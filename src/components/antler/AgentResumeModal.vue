<script setup lang="ts">
import { ref, watch, onUnmounted, nextTick } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'
import {
  loadCharacterImages,
  registerPreview,
  startSkinPreviews,
  stopSkinPreviews,
  unregisterPreviewsIn,
  DETAIL_AGENT_CANVAS,
} from '@/lib/skin-preview'
import {
  layoutToAgentColStyle,
  layoutToSceneStyle,
  layoutToStatsStyle,
  loadNpcHireLayout,
} from '@/lib/npc-hire-layout'
import { drawModalBorderVignette } from '@/lib/npc-hire-vignette'
import { normalizeAgentOverview, type AgentOverview, type ResumeAgent } from '@/lib/agent-resume-fallback'

export type { ResumeAgent }

interface JobScopeCard {
  key: string
  icon: string
  label: string
  text: string
}

interface SkillLookup {
  id: string
  name: string
}

interface McpLookup {
  id: string
  name: string
}

const props = defineProps<{
  show: boolean
  agent: ResumeAgent | null
  builtinRole?: string | null
  palette?: number
  hueShift?: number
  skills?: SkillLookup[]
  mcps?: McpLookup[]
}>()

const emit = defineEmits<{ 'update:show': [value: boolean] }>()

const api = useAntlerApi()
const loading = ref(false)
const error = ref('')
const overview = ref<AgentOverview | null>(null)

const sceneStyle = ref<Record<string, string>>({})
const agentColStyle = ref<Record<string, string>>({})
const statsStyle = ref<Record<string, string>>({})
const stageRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const modalRef = ref<HTMLElement | null>(null)
const vignetteCanvasRef = ref<HTMLCanvasElement | null>(null)
let vignetteRaf = 0
let resizeObserver: ResizeObserver | null = null

function close() {
  emit('update:show', false)
}

function formatRole(role?: string) {
  if (!role) return 'Office worker'
  return role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function liveStatusLabel() {
  const state = overview.value?.live?.npcState || 'resting'
  if (state === 'working') return 'Working'
  if (state === 'walking') return 'On the move'
  return 'Idle'
}

async function mountPreview() {
  await nextTick()
  if (stageRef.value) unregisterPreviewsIn(stageRef.value)
  const canvas = canvasRef.value
  if (!canvas || !props.agent) return
  registerPreview({
    canvas,
    palette: props.palette ?? props.agent.sprite ?? 0,
    hueShift: props.hueShift ?? props.agent.hueShift ?? 0,
  })
  startSkinPreviews()
}

function updateVignette() {
  cancelAnimationFrame(vignetteRaf)
  vignetteRaf = requestAnimationFrame(() => {
    const canvas = vignetteCanvasRef.value
    const modal = modalRef.value
    if (!canvas || !modal || !props.show) return
    drawModalBorderVignette(canvas, modal.getBoundingClientRect())
  })
}

async function loadOverview() {
  if (!props.agent) return
  loading.value = true
  error.value = ''
  overview.value = null
  try {
    const layout = await loadNpcHireLayout()
    sceneStyle.value = layoutToSceneStyle(layout)
    agentColStyle.value = layoutToAgentColStyle(layout)
    statsStyle.value = layoutToStatsStyle(layout)
    const path = props.builtinRole
      ? `/api/config/builtin-agents/${encodeURIComponent(props.builtinRole)}/overview`
      : `/api/config/agents/${props.agent.id}/overview`
    const data = await api.get<AgentOverview>(path)
    const skillMap = new Map((props.skills || []).map((s) => [s.id, s.name]))
    const mcpMap = new Map((props.mcps || []).map((m) => [m.id, m.name]))
    overview.value = normalizeAgentOverview(data, props.agent, skillMap, mcpMap)
    try {
      await loadCharacterImages((props.palette ?? props.agent.sprite ?? 0) + 1)
    } catch {
      /* optional sprites */
    }
    await mountPreview()
    updateVignette()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load agent overview'
  } finally {
    loading.value = false
  }
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && props.show) close()
}

watch(
  () => [props.show, props.agent?.id] as const,
  ([open]) => {
    if (open && props.agent) {
      document.body.style.overflow = 'hidden'
      window.addEventListener('keydown', onKeydown)
      window.addEventListener('resize', updateVignette)
      resizeObserver?.disconnect()
      void nextTick(() => {
        const modal = modalRef.value
        if (modal && typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => updateVignette())
          resizeObserver.observe(modal)
        }
      })
      void loadOverview()
    } else {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('resize', updateVignette)
      resizeObserver?.disconnect()
      resizeObserver = null
      cancelAnimationFrame(vignetteRaf)
      stopSkinPreviews()
      if (stageRef.value) unregisterPreviewsIn(stageRef.value)
    }
  },
)

onUnmounted(() => {
  document.body.style.overflow = ''
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', updateVignette)
  resizeObserver?.disconnect()
  stopSkinPreviews()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="agent-resume-fade">
      <section
        v-if="show && agent"
        class="npc-hire-page"
        role="dialog"
        aria-modal="true"
        :aria-label="`${agent.name} resume`"
        @click.self="close"
      >
        <button type="button" class="npc-hire-backdrop" aria-label="Close" @click="close">
          <canvas ref="vignetteCanvasRef" class="npc-hire-vignette-canvas" aria-hidden="true" />
        </button>

        <div ref="modalRef" class="npc-hire-modal">
          <div class="npc-hire-scene npc-hire-scene--modal" :style="sceneStyle" aria-hidden="true">
            <div class="npc-hire-bg npc-hire-bg--scene" />
            <div class="npc-hire-vignette npc-hire-vignette--modal" />
          </div>

          <div class="npc-hire-content">
            <div class="npc-hire-col npc-hire-col--left" :style="agentColStyle">
              <div class="npc-hire-left">
                <header class="npc-hire-copy">
                  <span class="npc-hire-brand">AntlerOffice</span>
                  <h2 class="npc-hire-title">{{ agent.name }}</h2>
                  <p class="npc-hire-subtitle">{{ formatRole(agent.role) }} · {{ agent.runtime || 'openclaw' }}</p>
                </header>

                <div class="npc-hire-showcase">
                  <div ref="stageRef" class="npc-hire-character">
                    <canvas
                      ref="canvasRef"
                      :width="DETAIL_AGENT_CANVAS"
                      :height="DETAIL_AGENT_CANVAS"
                      role="img"
                      :aria-label="`${agent.name} character`"
                    />
                  </div>
                </div>
              </div>

              <div class="npc-hire-stats" :style="statsStyle">
                <div class="npc-hire-stat">
                  <h4 class="npc-hire-stat-title">Status</h4>
                  <div class="npc-hire-stat-body">
                    <span class="npc-hire-stat-icon briefcase" aria-hidden="true" />
                    <p class="npc-hire-stat-value">
                      <strong>{{ liveStatusLabel() }}</strong>
                    </p>
                  </div>
                  <p v-if="overview?.live?.currentJob" class="npc-hire-stat-foot">
                    {{ overview.live.currentJob }}
                  </p>
                  <p v-else-if="overview?.live?.bubbleText" class="npc-hire-stat-foot">
                    {{ overview.live.bubbleText }}
                  </p>
                  <p v-else class="npc-hire-stat-foot">Ready for your next task</p>
                </div>
                <div class="npc-hire-stat">
                  <h4 class="npc-hire-stat-title">Hired</h4>
                  <div class="npc-hire-stat-body">
                    <span class="npc-hire-stat-icon download" aria-hidden="true" />
                    <p class="npc-hire-stat-value">
                      <strong>{{ agent.hiredAt ? new Date(agent.hiredAt).toLocaleDateString() : '—' }}</strong>
                    </p>
                  </div>
                  <p class="npc-hire-stat-foot">
                    {{ agent.salaryCreditsPerMonth ? `${agent.salaryCreditsPerMonth} credits / month` : 'No salary set' }}
                  </p>
                </div>
              </div>
            </div>

            <div class="npc-hire-col npc-hire-col--right">
              <div class="npc-hire-right">
                <div class="npc-hire-glass">
                  <header class="npc-hire-glass-head">
                    <h3 class="npc-hire-glass-title">Agent Resume</h3>
                    <div v-if="agent.salaryCreditsPerMonth" class="npc-hire-salary">
                      <span class="npc-hire-coin" aria-hidden="true">◎</span>
                      <strong>{{ agent.salaryCreditsPerMonth }}</strong>
                      <span class="npc-hire-salary-unit">credits / month</span>
                      <em class="npc-hire-salary-label">Salary</em>
                    </div>
                    <div class="npc-hire-divider" aria-hidden="true"><span /></div>
                  </header>

                    <p v-if="props.builtinRole" class="hint npc-hire-hidden-banner">
                      Built-in supervisor — always on your team at no extra salary.
                    </p>

                    <div class="npc-hire-glass-body">
                    <p v-if="loading" class="hint">Loading resume…</p>
                    <p v-else-if="error" class="apply-error">{{ error }}</p>

                    <template v-else-if="overview">
                      <section class="npc-hire-section">
                        <h4 class="npc-hire-section-title">What This Agent Does</h4>
                        <p class="npc-hire-scope-text">{{ overview.description }}</p>
                      </section>

                      <section v-if="overview.examples?.length" class="npc-hire-section">
                        <h4 class="npc-hire-section-title">Examples</h4>
                        <ul class="npc-hire-checklist">
                          <li v-for="(ex, i) in overview.examples" :key="`ex-${i}`">
                            <span aria-hidden="true">•</span>{{ ex }}
                          </li>
                        </ul>
                      </section>

                      <section class="npc-hire-section">
                        <h4 class="npc-hire-section-title">Job Scope</h4>
                        <div class="npc-hire-scope-list">
                          <article
                            v-for="card in overview.jobScope || []"
                            :key="card.key"
                            class="npc-hire-scope-item"
                          >
                            <span class="npc-hire-scope-icon" :class="card.icon" aria-hidden="true" />
                            <div class="npc-hire-scope-copy">
                              <span class="npc-hire-scope-label">{{ card.label }}</span>
                              <p class="npc-hire-scope-text">{{ card.text }}</p>
                            </div>
                          </article>
                        </div>
                      </section>

                      <section v-if="overview.skills?.length" class="npc-hire-section">
                        <h4 class="npc-hire-section-title">Installed Capabilities</h4>
                        <div class="npc-hire-scope-list">
                          <article
                            v-for="skill in (overview.baseSkills?.length ? overview.baseSkills : overview.skills.filter((s) => !s.additional))"
                            :key="skill.id"
                            class="npc-hire-scope-item"
                          >
                            <span class="npc-hire-scope-icon gear" aria-hidden="true" />
                            <div class="npc-hire-scope-copy">
                              <span class="npc-hire-scope-label">{{ skill.name }}</span>
                              <p v-if="skill.systemPreview" class="npc-hire-scope-text">{{ skill.systemPreview }}</p>
                            </div>
                          </article>
                        </div>
                      </section>

                      <section
                        v-if="overview.additionalCapabilities?.length"
                        class="npc-hire-section npc-hire-section--additional"
                      >
                        <h4 class="npc-hire-section-title">Additional Capabilities</h4>
                        <p class="hint npc-hire-refresh-hint">
                          Added after hire — refreshed each time you open this resume.
                        </p>
                        <div class="npc-hire-scope-list">
                          <article
                            v-for="cap in overview.additionalCapabilities"
                            :key="`${cap.kind}-${cap.id}`"
                            class="npc-hire-scope-item npc-hire-scope-item--additional"
                          >
                            <span
                              class="npc-hire-scope-icon"
                              :class="cap.kind === 'mcp' ? 'wrench' : 'gear'"
                              aria-hidden="true"
                            />
                            <div class="npc-hire-scope-copy">
                              <span class="npc-hire-scope-label">{{ cap.label }}: {{ cap.name }}</span>
                              <p v-if="cap.detail" class="npc-hire-scope-text">{{ cap.detail }}</p>
                            </div>
                          </article>
                        </div>
                      </section>
                    </template>
                  </div>

                  <footer class="npc-hire-glass-footer">
                    <button type="button" class="npc-hire-btn secondary" @click="close">Close</button>
                  </footer>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.apply-error {
  color: #e88080;
  font-size: 13px;
}
.npc-hire-refresh-hint {
  margin: 0 0 10px;
  font-size: 12px;
  opacity: 0.75;
}
.npc-hire-scope-item--additional .npc-hire-scope-label {
  color: #c9b87a;
}
</style>
