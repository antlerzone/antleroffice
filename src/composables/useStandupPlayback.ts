import { computed, ref } from 'vue'
import type { DeliverableItem, DeliverableStandupSection } from '@/lib/deliverable-meta'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceOutput, type SpeakOptions } from '@/composables/useVoiceOutput'

export type StandupPlaybackPhase = 'idle' | 'playing' | 'interrupted' | 'followUp'

const phase = ref<StandupPlaybackPhase>('idle')
const deliverableId = ref<string | null>(null)
const sections = ref<DeliverableStandupSection[]>([])
const currentIndex = ref(0)

let cancelToken = 0
let lastOfficeAgentKey: string | null = null

function officeAgentKey(section: DeliverableStandupSection) {
  return section.agentId || section.role || null
}

async function setOfficeStandupAgent(api: ReturnType<typeof useAntlerApi>, key: string | null, label: string, working: boolean) {
  if (!key) return
  try {
    await api.send('POST', '/api/office/command', {
      action: working ? 'work' : 'rest',
      agentId: key,
      note: working ? `Standup: ${label}` : '',
    })
  } catch {
    /* best-effort */
  }
}

async function restLastOfficeAgent(api: ReturnType<typeof useAntlerApi>) {
  if (!lastOfficeAgentKey) return
  await setOfficeStandupAgent(api, lastOfficeAgentKey, '', false)
  lastOfficeAgentKey = null
}

function sectionVoiceOpts(section: DeliverableStandupSection, bargeIn = true): SpeakOptions {
  const voice = section.voice
  if (!voice?.engine) return { bargeIn }
  return {
    engine: voice.engine as SpeakOptions['engine'],
    voiceId: voice.voiceId,
    bargeIn,
  }
}

export function useStandupPlayback() {
  const api = useAntlerApi()
  const { speak, stop } = useVoiceOutput()

  const isActive = computed(() => phase.value !== 'idle')

  async function syncPlaybackState(patch: {
    active: boolean
    deliverableId?: string | null
    sectionIndex?: number
    interrupted?: boolean
  }) {
    try {
      await api.send('POST', '/api/voice/listener/standup-playback', patch)
    } catch {
      /* best-effort */
    }
  }

  async function endPlayback() {
    cancelToken++
    stop()
    await restLastOfficeAgent(api)
    phase.value = 'idle'
    deliverableId.value = null
    sections.value = []
    currentIndex.value = 0
    await syncPlaybackState({ active: false })
  }

  async function playSection(index: number) {
    const sec = sections.value[index]
    if (!sec || !deliverableId.value) return
    currentIndex.value = index
    const key = officeAgentKey(sec)
    if (key && key !== lastOfficeAgentKey) {
      await restLastOfficeAgent(api)
      lastOfficeAgentKey = key
      await setOfficeStandupAgent(api, key, sec.label, true)
    }
    await syncPlaybackState({
      active: true,
      deliverableId: deliverableId.value,
      sectionIndex: index,
      interrupted: false,
    })
    await speak(sec.text, sectionVoiceOpts(sec, true))
  }

  async function runLoop(startIndex = 0) {
    const token = ++cancelToken
    phase.value = 'playing'

    for (let i = startIndex; i < sections.value.length; i++) {
      // phase is reactive and mutated by interrupt handlers; cast avoids a false
      // "no-overlap" narrowing (TS thinks it's still 'playing' from line 100).
      if (token !== cancelToken || (phase.value as string) === 'idle') return
      if ((phase.value as string) === 'interrupted') {
        await syncPlaybackState({
          active: true,
          deliverableId: deliverableId.value,
          sectionIndex: i,
          interrupted: true,
        })
        return
      }
      try {
        await playSection(i)
      } catch {
        break
      }
      if ((phase.value as string) === 'interrupted') return
    }

    await endPlayback()
  }

  async function start(deliverable: DeliverableItem) {
    if (!deliverable.standupSections?.length) return
    await endPlayback()
    deliverableId.value = deliverable.id
    sections.value = [...deliverable.standupSections]
    currentIndex.value = 0
    void runLoop(0)
  }

  async function stopPlayback() {
    await endPlayback()
  }

  async function handlePlaybackCommand(result: {
    ok?: boolean
    action?: string
    text?: string
    sectionIndex?: number
  }) {
    const action = result.action || ''
    if (!action.startsWith('standup_')) return false

    stop()

    if (action === 'standup_stop') {
      phase.value = 'interrupted'
      await syncPlaybackState({
        active: true,
        deliverableId: deliverableId.value,
        sectionIndex: currentIndex.value,
        interrupted: true,
      })
      if (result.text) await speak(result.text, { bargeIn: false })
      return true
    }

    if (action === 'standup_continue') {
      const next = Number.isFinite(result.sectionIndex)
        ? Number(result.sectionIndex)
        : currentIndex.value + 1
      phase.value = 'playing'
      void runLoop(next)
      return true
    }

    if (action === 'standup_follow_up' && result.text) {
      phase.value = 'interrupted'
      const sec = sections.value[currentIndex.value]
      await speak(result.text, sec ? sectionVoiceOpts(sec, true) : { bargeIn: true })
      return true
    }

    if (action === 'standup_follow_up_failed' && result.text) {
      await speak(result.text, { bargeIn: false })
      return true
    }

    return true
  }

  return {
    phase,
    currentIndex,
    isActive,
    deliverableId,
    start,
    stopPlayback,
    handlePlaybackCommand,
  }
}
