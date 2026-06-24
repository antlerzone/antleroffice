import { ref, watch } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useVoiceOutput } from '@/composables/useVoiceOutput'
import { useStandupPlayback } from '@/composables/useStandupPlayback'
import { useVoiceRealtime } from '@/composables/useVoiceRealtime'
import { usePersonaVoice } from '@/composables/usePersonaVoice'
import { useBossStore } from '@/stores/boss'
import { isElectronApp, isSummonHost, showItemInFolder } from '@/lib/desktop-shell'
import { unlockAudioPlayback } from '@/lib/audio-unlock'
import { getCachedGreetingBlob } from '@/lib/persona-greeting-cache'
import {
  dedupeWakePhrases,
  wakeListenHint,
} from '@/constants/voiceAssistant'
import { summonBanner, summonError, summonInfo, summonLog, summonMark, summonMic, summonVerbose, summonWarn, resetSummonTimer } from '@/lib/summon-debug'
import { clearSummonSession, markSummonSessionActive, startSummonIdleWatch, summonSessionActive } from '@/lib/summon-session'

export type VoiceWakeMode = 'sleep' | 'active' | 'speaking'

const mode = ref<VoiceWakeMode>('sleep')
const lastTranscript = ref('')
const lastReply = ref('')
const connected = ref(false)

let eventSource: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect(connectFn: () => void) {
  clearReconnectTimer()
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    wakeLog('SSE reconnecting…')
    connectFn()
  }, 2500)
}

function wakeLog(...args: unknown[]) {
  summonVerbose(...args)
}

function wakeWarn(...args: unknown[]) {
  summonWarn(...args)
}

function wakeError(...args: unknown[]) {
  summonError(...args)
}

let lastWakeHandledAt = 0
let listenerSleepInFlight = false
let lastForceListenerSleepAt = 0
/** Set synchronously when a wake is accepted — blocks orphan mode repair until handshake finishes. */
let wakeHandshakeUntil = 0
const WAKE_HANDSHAKE_MS = 8_000
/** True from accepted wake until greeting/realtime setup completes — blocks listener resync. */
let wakeFlowInProgress = false
/** Bumped on endSummonSession — aborts in-flight greeting/realtime from a cancelled wake. */
let wakeGeneration = 0
let summonIdleHookInstalled = false
let listenerResyncTimer: ReturnType<typeof setInterval> | null = null
let micMonitorTimer: ReturnType<typeof setTimeout> | null = null
let micMonitorActive = false
let micMonitorInFlight = false
let micWasAboveVad = false
let lastMicAboveVadAt = 0
let listenerOrphanActiveSince = 0
let lastStaleRealtimeRepairAt = 0
let lastMicLogAt = 0
let lastWakeIdleWarnAt = 0
const MIC_POLL_OK_MS = 800
const MIC_POLL_ERR_MS = 3000
let micPollDelayMs = MIC_POLL_OK_MS
let bootstrapPromise: Promise<void> | null = null
/** Prevents overlapping greet playback (HMR duplicate SSE / race). */
let greetingInFlight = false
let wakeHandlerInFlight = false
let summonSettingsWatchInstalled = false

const SUMMON_ES_GLOBAL = '__antlerSummonEventSource'

function closeSummonEventSource() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  try {
    if (typeof window !== 'undefined') {
      const prev = (window as unknown as Record<string, EventSource | undefined>)[SUMMON_ES_GLOBAL]
      if (prev && prev !== eventSource) prev.close()
      delete (window as unknown as Record<string, unknown>)[SUMMON_ES_GLOBAL]
    }
  } catch {
    /* ignore */
  }
}

export function useVoiceWake() {
  const api = useAntlerApi()
  const boss = useBossStore()
  const { settings, honorific, updateSummon } = useVoiceAssistantSettings()
  const { speak, stop, playBlob } = useVoiceOutput()
  const { handlePlaybackCommand, isActive: standupPlaybackActive } = useStandupPlayback()
  const realtime = useVoiceRealtime()
  const { resolvedSampleReply, personaSpeakOptions } = usePersonaVoice()

  function isWakeFlowBusy() {
    return wakeFlowInProgress || Date.now() < wakeHandshakeUntil
  }

  async function forceListenerSleep(reason: string) {
    const now = Date.now()
    if (listenerSleepInFlight || now - lastForceListenerSleepAt < 1200) return
    if (isSummonEngaged() || isWakeFlowBusy()) return
    listenerSleepInFlight = true
    lastForceListenerSleepAt = now
    try {
      summonVerbose(`forcing listener sleep — ${reason}`)
      await setListenerSummonSession(false)
      await setMode('sleep')
    } finally {
      listenerSleepInFlight = false
    }
  }

  async function speakSummonLine(text: string) {
    const line = text.trim()
    if (!line) {
      wakeWarn('speak skipped — empty text')
      return
    }
    if (!settings.value.voice.enabled) {
      wakeWarn('speak skipped — voice output disabled (Voice → Enable TTS)')
      return
    }
    lastReply.value = line
    await notifySpeaking(true)
    try {
      await speak(line, personaSpeakOptions())
    } catch (e) {
      wakeError('speak failed', e)
      throw e
    } finally {
      await notifySpeaking(false)
    }
  }

  async function onWakeGreeting(wakeGen: number) {
    if (wakeGen !== wakeGeneration) return
    if (greetingInFlight) {
      summonWarn('greeting skipped — already playing')
      return
    }
    const line = resolvedSampleReply.value
    if (!line) {
      summonWarn('greeting skipped — no sample reply (save one in Persona)')
      return
    }
    greetingInFlight = true
    stop()
    await unlockAudioPlayback()
    if (wakeGen !== wakeGeneration) {
      greetingInFlight = false
      return
    }
    const opts = personaSpeakOptions()
    const cached = getCachedGreetingBlob(line, opts)
    summonLog('persona greeting →', {
      text: line,
      replyLanguage: settings.value.voice.replyLanguage,
      cached: !!cached,
      voice: personaSpeakOptions()?.engine || 'default',
    })
    try {
      await notifySpeaking(true)
      if (cached) {
        await playBlob(cached)
      } else {
        await speak(line, opts)
      }
      if (wakeGen !== wakeGeneration) return
      summonLog('persona greeting played')
      summonBanner('Greeting played — summon active', { phrase: line.slice(0, 60) })
    } catch (e) {
      if (wakeGen !== wakeGeneration) return
      summonError('persona greeting failed — trying Web Speech fallback', e)
      try {
        await speak(line, { ...opts, forceWebSpeech: true })
        summonLog('persona greeting played (webspeech fallback)')
      } catch (e2) {
        summonError('persona greeting failed (click the page once to unlock audio)', e2)
      }
    } finally {
      greetingInFlight = false
      await notifySpeaking(false)
    }
  }

  async function setListenerSummonSession(active: boolean) {
    try {
      await api.send('POST', '/api/voice/listener/config', {
        summonSessionEngaged: active,
        realtimeSessionActive: realtime.isActive.value,
      })
    } catch {
      /* ignore */
    }
  }

  async function rollbackAbortedWake(wakeGen: number, stage: string, source: string) {
    if (wakeGen === wakeGeneration) return
    summonVerbose(`wake aborted ${stage}`, { source })
    wakeHandshakeUntil = 0
    wakeFlowInProgress = false
    clearSummonSession()
    mode.value = 'sleep'
    await setListenerSummonSession(false)
    await setMode('sleep')
  }

  async function handleSummonWake(source: string, payload: Record<string, unknown> = {}) {
    if (source === 'listener-resync') {
      summonVerbose('listener-resync wake ignored (use sleep sync only)')
      return
    }
    const now = Date.now()
    const isManualTest = source === 'test-button' || source === 'simulate'

    if (!isManualTest && (wakeHandlerInFlight || greetingInFlight)) {
      summonLog('wake deduped — greeting flow in flight', { source })
      return
    }

    if (!isManualTest && !settings.value.summon.globalListenEnabled) {
      summonInfo('wake ignored — global listen disabled', { source, phrase: payload.phrase })
      return
    }

    if (!isManualTest && summonSessionActive.value && mode.value !== 'sleep') {
      summonInfo('wake ignored — already summoned (idle timeout resets session)', {
        source,
        phrase: payload.phrase,
        mode: mode.value,
        realtime: realtime.isActive.value,
      })
      return
    }
    if (!isManualTest && summonSessionActive.value && mode.value === 'sleep') {
      summonWarn('stale summonSessionActive while sleep — clearing before wake')
      clearSummonSession()
    }

    if (now - lastWakeHandledAt < 1200) {
      summonLog('wake deduped', { source })
      return
    }
    lastWakeHandledAt = now
    wakeHandlerInFlight = true
    wakeHandshakeUntil = now + WAKE_HANDSHAKE_MS
    wakeFlowInProgress = true
    const wakeGen = ++wakeGeneration
    resetSummonTimer(`wake (${source})`)
    const phrase = String(payload.phrase || payload.source || '').trim() || null
    const transcript = String(payload.transcript || '').trim() || null
    summonMic('mic receive!! wake word', { source, phrase: phrase || '(none)', transcript })
    summonInfo('detected', { source, phrase, transcript, mode: mode.value, realtime: realtime.isActive.value })
    summonBanner('Wake detected', { source, phrase: phrase || '(none)', transcript: transcript || undefined })
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('antler:summon-wake', { detail: { source, phrase: phrase || '' } }),
      )
    }
    try {
      stop()
      await unlockAudioPlayback()
      if (wakeGen !== wakeGeneration) {
        summonVerbose('wake aborted after unlock', { source })
        wakeHandshakeUntil = 0
        wakeFlowInProgress = false
        return
      }
      mode.value = 'active'
      markSummonSessionActive()
      await setListenerSummonSession(true)
      await setMode('active')
      if (wakeGen !== wakeGeneration) {
        await rollbackAbortedWake(wakeGen, 'after setMode', source)
        return
      }
      await onWakeGreeting(wakeGen)
      if (wakeGen !== wakeGeneration) {
        await rollbackAbortedWake(wakeGen, 'after greeting', source)
        return
      }
      if (settings.value.realtime.enabled && !realtime.isActive.value) {
        summonLog('starting realtime after greeting')
        try {
          await realtime.start({ afterWake: true })
          summonLog('realtime session started')
        } catch (err) {
          summonError('realtime start failed after greeting', err)
        }
      }
      startSummonIdleWatch(
        () => settings.value.summon.idleTimeoutSec || 300,
        () => summonSessionActive.value,
      )
      summonLog('complete', { source, phrase })
      wakeHandshakeUntil = 0
      wakeFlowInProgress = false
    } finally {
      wakeHandlerInFlight = false
    }
  }

  async function endSummonSession(reason: string) {
    summonInfo(`session ended — ${reason}`)
    wakeGeneration++
    wakeHandshakeUntil = 0
    wakeFlowInProgress = false
    clearSummonSession()
    stop()
    mode.value = 'sleep'
    lastWakeHandledAt = Date.now()
    try {
      await notifySpeaking(false)
      await setListenerSummonSession(false)
      if (realtime.isActive.value) {
        await realtime.stop()
      }
      await setMode('sleep')
      await syncListenerConfig()
    } catch (e) {
      summonWarn('endSummonSession partial cleanup failed', e)
    }
  }

  function isSummonEngaged() {
    return summonSessionActive.value || mode.value === 'active' || mode.value === 'speaking'
  }

  /** Header toggle: Sleep ↔ Active (no greeting; starts realtime when enabled). */
  async function toggleSummonSession() {
    if (isSummonEngaged()) {
      await endSummonSession('header-toggle')
      return
    }
    if (!settings.value.summon.globalListenEnabled) {
      summonWarn('toggle skipped — global listen disabled')
      return
    }
    lastWakeHandledAt = Date.now()
    resetSummonTimer('header-toggle')
    summonInfo('header toggle → active')
    await unlockAudioPlayback()
    mode.value = 'active'
    markSummonSessionActive()
    await setListenerSummonSession(true)
    if (settings.value.realtime.enabled && !realtime.isActive.value) {
      try {
        await realtime.start({ afterWake: true })
      } catch (err) {
        summonError('realtime start failed (header toggle)', err)
      }
    } else {
      await setMode('active')
    }
    startSummonIdleWatch(
      () => settings.value.summon.idleTimeoutSec || 300,
      () => summonSessionActive.value,
    )
  }

  function effectiveWakePhrases(): string[] {
    return dedupeWakePhrases(settings.value.summon.wakePhrases)
  }

  let syncDebounce: ReturnType<typeof setTimeout> | null = null

  function scheduleSyncListenerConfig() {
    if (syncDebounce) clearTimeout(syncDebounce)
    syncDebounce = setTimeout(() => {
      syncDebounce = null
      void syncListenerConfig()
    }, 900)
  }

  async function syncListenerConfig() {
    const summon = settings.value.summon
    const body = {
      globalListenEnabled: summon.globalListenEnabled,
      wakePhrases: effectiveWakePhrases(),
      idleTimeoutSec: summon.idleTimeoutSec,
      wakeEngine: 'openwakeword',
      wakeRequireStt: false,
      sensitivity: Math.min(0.9, Math.max(0.45, summon.sensitivity ?? 0.65)),
      porcupineAccessKey: summon.porcupineAccessKey,
      clapWake: false,
      clapWakeCount: 2,
      inputDeviceIndex: summon.inputDeviceIndex ?? null,
      personaEnabled: settings.value.persona.enabled,
      honorific: honorific.value,
      personaPrompt: settings.value.persona.systemPrompt,
      replyLanguage: settings.value.voice.replyLanguage,
      ownerKey: boss.chatOwnerKey || 'local:boss',
      ownerName: boss.session?.username || 'Boss',
      autoDispatch: true,
      realtimeSessionActive: realtime.isActive.value,
      summonSessionEngaged:
        summonSessionActive.value && (mode.value === 'active' || mode.value === 'speaking'),
    }
    wakeLog('syncListenerConfig', {
      wakeEngine: body.wakeEngine,
      wakeRequireStt: body.wakeRequireStt,
      sensitivity: body.sensitivity,
      wakePhrases: body.wakePhrases,
      replyLanguage: body.replyLanguage,
      globalListenEnabled: body.globalListenEnabled,
    })
    const res = await api.send<{ ok?: boolean; config?: Record<string, unknown> }>(
      'POST',
      '/api/voice/listener/config',
      body,
    )
    wakeLog('listener config applied', res?.config || res)
  }

  async function setMode(next: VoiceWakeMode) {
    mode.value = next
    try {
      await api.send('POST', '/api/voice/listener/mode', { mode: next })
    } catch (e) {
      summonWarn('setMode failed — is dev server running?', e)
    }
    if (isElectronApp()) {
      const m = next === 'speaking' ? 'active' : next
      await window.antlerDesktop?.voiceWakeSetMode?.(m === 'active' ? 'active' : 'sleep')
    }
  }

  async function notifySpeaking(speaking: boolean) {
    try {
      await api.send('POST', '/api/voice/listener/speaking', { speaking })
    } catch (e) {
      summonWarn('notifySpeaking failed — is dev server running?', e)
    }
    if (speaking) mode.value = 'speaking'
    else if (mode.value === 'speaking') mode.value = 'active'
  }

  async function handleLocalAction(action: string, replyText?: string) {
    if (action === 'stop_tts') {
      stop()
      await notifySpeaking(false)
      return
    }
    if (action === 'mute') {
      await endSummonSession('voice-mute')
      return
    }
    if (action === 'open_settings') {
      window.dispatchEvent(new CustomEvent('antler:open-settings'))
      return
    }
    if (action === 'start_work') {
      void api.send('POST', '/api/coo-heartbeat/run', { wait: false }).catch(() => {})
      window.dispatchEvent(new CustomEvent('antler:navigate-portal'))
      const line = String(replyText || '').trim()
      if (line && settings.value.voice.enabled) {
        lastReply.value = line
        await notifySpeaking(true)
        try {
          await speak(line, personaSpeakOptions())
        } finally {
          await notifySpeaking(false)
        }
      }
    }
  }

  async function handleCommandResult(payload: {
    text?: string
    result?: {
      ok?: boolean
      local?: boolean
      action?: string
      text?: string
      path?: string
      sectionIndex?: number
    }
  }) {
    if (!isSummonEngaged()) {
      summonVerbose('command_result ignored — session sleep', payload.text)
      return
    }
    if (wakeFlowInProgress || isWakeFlowBusy()) {
      summonVerbose('command_result ignored — wake greeting in progress', payload.text)
      return
    }
    if (realtime.isActive.value) {
      summonVerbose('command_result ignored — browser realtime active', payload.text)
      return
    }
    const result = payload.result
    if (!result?.ok) {
      wakeWarn('command failed', result)
      return
    }
    if (standupPlaybackActive.value && (await handlePlaybackCommand(result))) {
      return
    }
    if (result.action === 'standup_export_pdf' && result.text) {
      if (result.path) showItemInFolder(result.path)
      if (settings.value.voice.enabled) {
        await speakSummonLine(result.text)
      }
      return
    }
    if (result.local && result.action) {
      await handleLocalAction(result.action, result.text)
      return
    }
    const reply = String(result.text || '').trim()
    if (!reply) return
    await speakSummonLine(reply)
  }

  function connectEvents() {
    if (typeof EventSource === 'undefined') return
    closeSummonEventSource()
    clearReconnectTimer()
    eventSource = new EventSource('/api/voice/listener/events', { withCredentials: true })
    try {
      if (typeof window !== 'undefined') {
        ;(window as unknown as Record<string, EventSource>)[SUMMON_ES_GLOBAL] = eventSource
      }
    } catch {
      /* ignore */
    }

    eventSource.onopen = () => {
      connected.value = true
      summonLog('SSE open (/api/voice/listener/events)')
    }
    eventSource.onerror = () => {
      connected.value = false
      wakeWarn('SSE disconnected — will retry')
      if (eventSource) {
        eventSource.close()
        eventSource = null
      }
      scheduleReconnect(connectEvents)
    }
    eventSource.onmessage = (ev) => {
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(ev.data)
      } catch {
        wakeWarn('invalid SSE payload', ev.data)
        return
      }
      const type = String(payload.type || '')
      if (type === 'wake') {
        summonInfo('SSE wake event', payload)
        void handleSummonWake('sse', payload)
        return
      }
      if (type === 'mode') {
        // Mode events follow every wake/mode API call — repair runs on interval, not here.
        return
      }
      if (type === 'wake_miss') {
        const reason = String(payload.reason || '')
        const rms = Number(payload.utteranceRms ?? payload.peakRms ?? 0)
        const heard = String(payload.transcript || '').trim()
        const listenHint = wakeListenHint(effectiveWakePhrases())
        let hint: string
        if (reason === 'utterance_too_short') {
          hint = `clip too short — say the full wake phrase slowly (${listenHint})`
        } else if (reason === 'quiet_utterance') {
          hint = `mic too quiet (rms ${Math.round(rms)}) — move closer; ${listenHint}`
        } else if (heard) {
          hint = `heard "${heard}" — not a wake phrase; ${listenHint}`
        } else {
          hint = listenHint
        }
        summonVerbose('wake_miss', { reason, heard, hint })
        return
      }
      summonVerbose('event', type, payload)
      if (type === 'connected') {
        summonLog('SSE connected')
        return
      }
      if (type === 'idle') {
        summonInfo('idle timeout → sleep (listener)')
        void endSummonSession('idle-timeout')
        return
      }
      if (type === 'transcript') {
        lastTranscript.value = String(payload.text || '')
        if (isSummonEngaged()) {
          wakeLog('transcript', lastTranscript.value)
        } else {
          summonVerbose('transcript ignored — sleep', lastTranscript.value)
        }
        return
      }
      if (type === 'command_result') {
        wakeLog('command_result', payload.result)
        void handleCommandResult(payload as { text?: string; result?: { ok?: boolean; local?: boolean; action?: string; text?: string } })
        return
      }
      if (type === 'standup_complete') {
        const summary = String(payload.summary || '汇报已存入 Complete Job')
        if (settings.value.voice.enabled) {
          void speakSummonLine(`汇报已完成。${summary}`)
        }
      }
    }
  }

  function stopMicMonitor() {
    micMonitorActive = false
    if (micMonitorTimer) clearTimeout(micMonitorTimer)
    micMonitorTimer = null
    micWasAboveVad = false
    lastMicLogAt = 0
  }

  async function pollMicLevel() {
    if (!isSummonHost() || !settings.value.summon.globalListenEnabled || micMonitorInFlight) return
    micMonitorInFlight = true
    try {
      const res = await api.get<{
        health?: {
          up?: boolean
          data?: {
            currentRms?: number
            peakRms?: number
            vadThreshold?: number
            state?: { mode?: string; wake_backend?: string; wake_error?: string | null }
          }
        }
        config?: { wakePhrases?: string[] }
      }>('/api/voice/listener/status', { timeoutMs: 4000 })
      const data = res.health?.data
      const rms = Math.round(data?.currentRms ?? data?.peakRms ?? 0)
      const vad = Math.round(data?.vadThreshold ?? 0)
      const modeLabel = data?.state?.mode ?? 'sleep'
      const wakeBackend = data?.state?.wake_backend ?? 'unknown'
      const phrases = res.config?.wakePhrases ?? []
      micPollDelayMs = MIC_POLL_OK_MS

      if (modeLabel === 'speaking' || modeLabel === 'active') {
        micWasAboveVad = false
        return
      }

      if (wakeBackend === 'idle' || wakeBackend === 'none') {
        const nowWarn = Date.now()
        if (nowWarn - lastWakeIdleWarnAt >= 8000) {
          lastWakeIdleWarnAt = nowWarn
          summonWarn('wake detector idle — restarting listener config', {
            wakeBackend,
            wakePhrases: phrases,
          })
          void syncListenerConfig()
        }
      }

      const above = vad > 0 && rms >= vad
      const now = Date.now()
      const wakeHint = wakeListenHint(effectiveWakePhrases())
      if (above) lastMicAboveVadAt = now
      if (above && !micWasAboveVad) {
        summonMic(`mic receive (VAD only — ${wakeHint})`, {
          rms,
          vad,
          mode: modeLabel,
          wakePhrases: phrases,
        })
        lastMicLogAt = now
      } else if (above && now - lastMicLogAt >= 1500) {
        summonMic('mic receive', { rms, vad, mode: modeLabel })
        lastMicLogAt = now
      } else if (!above && micWasAboveVad) {
        summonMic('mic quiet', { rms, vad, mode: modeLabel })
      }
      micWasAboveVad = above
    } catch {
      micPollDelayMs = MIC_POLL_ERR_MS
    } finally {
      micMonitorInFlight = false
    }
  }

  function startMicMonitor() {
    stopMicMonitor()
    micMonitorActive = true
    const tick = async () => {
      if (!micMonitorActive) return
      await pollMicLevel()
      if (!micMonitorActive) return
      micMonitorTimer = setTimeout(() => void tick(), micPollDelayMs)
    }
    void tick()
  }

  function disconnectEvents() {
    clearReconnectTimer()
    stopMicMonitor()
    if (listenerResyncTimer) {
      clearInterval(listenerResyncTimer)
      listenerResyncTimer = null
    }
    closeSummonEventSource()
    connected.value = false
  }

  async function repairStaleListenerFlags() {
    if (wakeFlowInProgress) return
    const now = Date.now()
    try {
      const res = await api.get<{
        health?: { data?: { state?: { mode?: string } } }
        config?: { realtimeSessionActive?: boolean; summonSessionEngaged?: boolean }
      }>('/api/voice/listener/status', { timeoutMs: 3000 })
      const listenerMode = res.health?.data?.state?.mode
      const staleSummon = res.config?.summonSessionEngaged === true
      const staleRealtime = res.config?.realtimeSessionActive === true && !realtime.isActive.value
      const clientEngaged = summonSessionActive.value || isSummonEngaged()

      if (!clientEngaged && (staleSummon || staleRealtime) && now - lastStaleRealtimeRepairAt >= 15_000) {
        lastStaleRealtimeRepairAt = now
        summonWarn('clearing stale listener session flags (was blocking sleep wake)')
        await setListenerSummonSession(false)
      }
      if (
        summonSessionActive.value &&
        mode.value === 'sleep' &&
        !realtime.isActive.value &&
        !wakeFlowInProgress
      ) {
        summonWarn('repair: stale summonSessionActive while sleep — clearing')
        clearSummonSession()
        await setListenerSummonSession(false)
        await setMode('sleep')
        return
      }
      if (!clientEngaged && (listenerMode === 'active' || listenerMode === 'speaking')) {
        const orphanSince = listenerOrphanActiveSince || (listenerOrphanActiveSince = now)
        const speakingNow = now - lastMicAboveVadAt < 2500
        if (speakingNow) {
          summonVerbose('listener orphan-active during speech — deferring sleep repair')
        } else if (now - orphanSince >= 4000) {
          listenerOrphanActiveSince = 0
          await forceListenerSleep('client sleep / listener active mismatch')
        }
      } else {
        listenerOrphanActiveSince = 0
      }
      const clientWantsListenerActive =
        mode.value === 'active' || mode.value === 'speaking' || realtime.isActive.value
      if (clientWantsListenerActive && listenerMode === 'sleep' && !realtime.isActive.value) {
        summonVerbose('client engaged but listener sleep — resync listener mode (no greeting)')
        await setMode(mode.value === 'speaking' ? 'speaking' : 'active')
        await setListenerSummonSession(true)
      }
    } catch {
      /* ignore */
    }
  }

  function startListenerResync() {
    if (listenerResyncTimer) return
    listenerResyncTimer = setInterval(() => {
      void repairStaleListenerFlags()
    }, 5000)
  }

  async function bootstrap() {
    if (bootstrapPromise) return bootstrapPromise
    bootstrapPromise = bootstrapInner().finally(() => {
      bootstrapPromise = null
    })
    return bootstrapPromise
  }

  async function bootstrapInner() {
    if (!isSummonHost()) {
      summonInfo('bootstrap skipped — summon only runs in Electron or localhost dev')
      return
    }
    if (!settings.value.summon.globalListenEnabled) {
      summonInfo('bootstrap skipped — global listen disabled (Summon settings)')
      return
    }
    summonInfo('bootstrap start', {
      wakeEngine: 'openwakeword',
      wakePhrases: effectiveWakePhrases(),
      clipPhrases: Object.keys(settings.value.summon.wakePhraseClips || {}),
    })
    if (!isSummonEngaged()) {
      await setListenerSummonSession(false)
      await setMode('sleep')
    } else {
      summonLog('bootstrap — keeping engaged summon session')
    }
    await syncListenerConfig()
    await repairStaleListenerFlags()
    connectEvents()
    startListenerResync()
    startMicMonitor()
    if (!summonIdleHookInstalled && typeof window !== 'undefined') {
      summonIdleHookInstalled = true
      window.addEventListener('antler:summon-idle', () => {
        void endSummonSession('client-idle-timeout')
      })
    }
    summonBanner('ready — filter DevTools console by [summon]', {
      wakePhrases: effectiveWakePhrases(),
      replyLanguage: settings.value.voice.replyLanguage,
      greeting: resolvedSampleReply.value.slice(0, 80),
      sse: '/api/voice/listener/events',
      verbose: "localStorage.setItem('antleroffice-summon-debug','1')",
    })
    if (isElectronApp()) {
      const status = await window.antlerDesktop?.voiceWakeGetStatus?.()
      if (
        summonSessionActive.value &&
        (status?.state?.mode === 'active' || status?.state?.mode === 'speaking')
      ) {
        mode.value = status.state.mode
      }
      window.antlerDesktop?.onVoiceWakeState?.((state) => {
        summonLog('desktop state', state)
        if (!summonSessionActive.value) return
        if (state.mode === 'active' || state.mode === 'speaking') mode.value = state.mode
        else mode.value = 'sleep'
      })
    }
  }

  if (!summonSettingsWatchInstalled) {
    summonSettingsWatchInstalled = true
    watch(
      () => settings.value.summon,
      () => {
        scheduleSyncListenerConfig()
      },
      { deep: true },
    )

    watch(
      () => [settings.value.persona, settings.value.voice.replyLanguage, honorific.value, boss.chatOwnerKey],
      () => {
        scheduleSyncListenerConfig()
      },
      { deep: true },
    )

    watch(
      () => realtime.isActive.value,
      () => {
        if (summonSessionActive.value) scheduleSyncListenerConfig()
      },
    )
  }

  return {
    mode,
    connected,
    lastTranscript,
    lastReply,
    realtime,
    syncListenerConfig,
    setMode,
    notifySpeaking,
    bootstrap,
    disconnectEvents,
    endSummonSession,
    toggleSummonSession,
    isSummonEngaged,
  }
}
