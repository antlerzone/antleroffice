<script setup lang="ts">
import { ref, computed, reactive, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useBossStore } from '@/stores/boss'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useOfficeProfile } from '@/composables/useOfficeProfile'
import {
  loadCharacterImages,
  registerPreview,
  startSkinPreviews,
  stopSkinPreviews,
  unregisterPreviewsIn,
  AGENT_SKIN_CANVAS,
} from '@/lib/skin-preview'

interface RosterDept {
  role: string
  label: string
  charSprite: number
  skillId: string | null
  routable: boolean
}

interface SnapshotNpc {
  id: string
  label: string
  role: string
  charSprite?: number
  hueShift?: number
  npcState?: string
  userAgentId?: string | null
  external?: boolean
}

interface UserAgent {
  id: string
  name: string
  role: string
  sprite?: number
  hueShift?: number
  skillIds?: string[]
}

export interface OrgEmployee {
  id: string
  name: string
  npcState: 'working' | 'idle'
  charSprite: number
  hueShift: number
  kind: 'hired' | 'builtin' | 'external'
}

export interface OrgDepartmentGroup {
  role: string
  label: string
  charSprite: number
  employees: OrgEmployee[]
  hasEmployees: boolean
}

export interface OrgNode {
  role: string
  deptLabel: string
  occupantName: string | null
  npcState: 'working' | 'idle' | 'vacant'
  charSprite: number
  hueShift: number
  kind: 'boss' | 'builtin' | 'hired' | 'vacant' | 'external'
}

const MIN_SCALE = 0.35
const MAX_SCALE = 2.5

const props = defineProps<{
  snapshot?: SnapshotNpc[]
  userAgents?: UserAgent[]
}>()

const api = useAntlerApi()
const boss = useBossStore()
const { resolvedBossName, resolvedDesktopName, load: loadOfficeProfile } = useOfficeProfile()
const loading = ref(false)
const roster = ref<RosterDept[]>([])
const localSnapshot = ref<SnapshotNpc[]>([])
const localUserAgents = ref<UserAgent[]>([])
const treeRef = ref<HTMLElement | null>(null)
const viewportRef = ref<HTMLElement | null>(null)
const scale = ref(1)
const offset = reactive({ x: 0, y: 0 })
const dragging = ref(false)
const dragStart = reactive({ x: 0, y: 0, ox: 0, oy: 0 })

const snapshotAgents = computed(() => props.snapshot ?? localSnapshot.value)
const userAgents = computed(() => props.userAgents ?? localUserAgents.value)

const treeStyle = computed(() => ({
  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale.value})`,
}))

function agentMatchesDept(agent: UserAgent, dept: RosterDept) {
  if (agent.role === dept.role) return true
  if (dept.skillId && (agent.skillIds || []).includes(dept.skillId)) return true
  return false
}

function snapForUserAgent(agentId: string) {
  return snapshotAgents.value.find((a) => a.userAgentId === agentId)
}

function resolveEmployeeFromUser(agent: UserAgent, dept: RosterDept): OrgEmployee {
  const snap = snapForUserAgent(agent.id)
  return {
    id: agent.id,
    name: agent.name,
    npcState: snap?.npcState === 'working' ? 'working' : 'idle',
    charSprite: snap?.charSprite ?? agent.sprite ?? dept.charSprite,
    hueShift: snap?.hueShift ?? agent.hueShift ?? 0,
    kind: 'hired',
  }
}

function buildDepartmentGroup(dept: RosterDept): OrgDepartmentGroup {
  const employees: OrgEmployee[] = []
  const seen = new Set<string>()

  for (const agent of userAgents.value) {
    if (!agentMatchesDept(agent, dept)) continue
    if (seen.has(agent.id)) continue
    seen.add(agent.id)
    employees.push(resolveEmployeeFromUser(agent, dept))
  }

  for (const snap of snapshotAgents.value) {
    if (!snap.external || snap.role !== dept.role) continue
    if (seen.has(snap.id)) continue
    seen.add(snap.id)
    employees.push({
      id: snap.id,
      name: snap.label,
      npcState: snap.npcState === 'working' ? 'working' : 'idle',
      charSprite: snap.charSprite ?? dept.charSprite,
      hueShift: snap.hueShift ?? 0,
      kind: 'external',
    })
  }

  return {
    role: dept.role,
    label: dept.label,
    charSprite: dept.charSprite,
    employees,
    hasEmployees: employees.length > 0,
  }
}

function resolveNode(dept: RosterDept): OrgNode {
  const snap = snapshotAgents.value.find((a) => a.role === dept.role && !a.external)
  const hired = userAgents.value.find((a) => a.role === dept.role)
  const external = snapshotAgents.value.find((a) => a.role === dept.role && a.external)

  if (external) {
    return {
      role: dept.role,
      deptLabel: dept.label,
      occupantName: external.label,
      npcState: external.npcState === 'working' ? 'working' : 'idle',
      charSprite: external.charSprite ?? dept.charSprite,
      hueShift: external.hueShift ?? 0,
      kind: 'external',
    }
  }

  if (snap) {
    const isHired = !!snap.userAgentId
    const user = isHired ? userAgents.value.find((u) => u.id === snap.userAgentId) : null

    if (dept.role === 'secretary') {
      return {
        role: dept.role,
        deptLabel: dept.label,
        occupantName: user?.name || snap.label || 'Secretary',
        npcState: snap.npcState === 'working' ? 'working' : 'idle',
        charSprite: snap.charSprite ?? user?.sprite ?? dept.charSprite,
        hueShift: snap.hueShift ?? user?.hueShift ?? 0,
        kind: 'builtin',
      }
    }

    if (dept.role === 'ceo' && !isHired) {
      return {
        role: dept.role,
        deptLabel: dept.label,
        occupantName: null,
        npcState: 'vacant',
        charSprite: snap.charSprite ?? dept.charSprite,
        hueShift: snap.hueShift ?? 0,
        kind: 'vacant',
      }
    }

    return {
      role: dept.role,
      deptLabel: dept.label,
      occupantName: user?.name || snap.label,
      npcState: snap.npcState === 'working' ? 'working' : 'idle',
      charSprite: snap.charSprite ?? user?.sprite ?? dept.charSprite,
      hueShift: snap.hueShift ?? user?.hueShift ?? 0,
      kind: isHired ? 'hired' : 'builtin',
    }
  }

  if (hired) {
    return {
      role: dept.role,
      deptLabel: dept.label,
      occupantName: hired.name,
      npcState: 'vacant',
      charSprite: hired.sprite ?? dept.charSprite,
      hueShift: hired.hueShift ?? 0,
      kind: 'hired',
    }
  }

  return {
    role: dept.role,
    deptLabel: dept.label,
    occupantName: null,
    npcState: 'vacant',
    charSprite: dept.charSprite,
    hueShift: 0,
    kind: 'vacant',
  }
}

const bossNode = computed<OrgNode>(() => ({
  role: 'boss',
  deptLabel: 'Boss',
  occupantName: resolvedBossName.value,
  npcState: 'idle',
  charSprite: 0,
  hueShift: 0,
  kind: 'boss',
}))

const secretaryNode = computed(() => {
  const dept = roster.value.find((d) => d.role === 'secretary')
  return dept ? resolveNode(dept) : null
})
const ceoNode = computed(() => {
  const dept = roster.value.find((d) => d.role === 'ceo')
  return dept ? resolveNode(dept) : null
})
const departmentGroups = computed(() =>
  roster.value.filter((d) => d.routable).map(buildDepartmentGroup),
)

const filledDeptCount = computed(
  () => departmentGroups.value.filter((d) => d.hasEmployees).length,
)
const hiredEmployeeCount = computed(() =>
  departmentGroups.value.reduce((n, d) => n + d.employees.length, 0),
)

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const viewport = viewportRef.value
  if (!viewport) return

  const rect = viewport.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  const delta = e.deltaY > 0 ? -0.1 : 0.1
  const oldScale = scale.value
  const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldScale + delta))
  const ratio = newScale / oldScale

  offset.x = mx - (mx - offset.x) * ratio
  offset.y = my - (my - offset.y) * ratio
  scale.value = newScale
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  const target = e.target as HTMLElement
  if (target.closest('.org-node')) return
  dragging.value = true
  dragStart.x = e.clientX
  dragStart.y = e.clientY
  dragStart.ox = offset.x
  dragStart.oy = offset.y
  viewportRef.value?.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  offset.x = dragStart.ox + (e.clientX - dragStart.x)
  offset.y = dragStart.oy + (e.clientY - dragStart.y)
}

function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  viewportRef.value?.releasePointerCapture(e.pointerId)
}

function resetView() {
  scale.value = 1
  offset.x = 0
  offset.y = 0
}

async function loadData() {
  if (props.snapshot && props.userAgents) return
  loading.value = true
  try {
    const [rosterRes, snapRes, agentsRes] = await Promise.all([
      api.get<{ departments?: RosterDept[] }>('/api/office/roster'),
      api.get<{ agents?: SnapshotNpc[] }>('/api/office/snapshot'),
      api.get<{ agents?: UserAgent[] }>('/api/config/agents'),
    ])
    roster.value = rosterRes.departments || []
    localSnapshot.value = snapRes.agents || []
    localUserAgents.value = agentsRes.agents || []
  } finally {
    loading.value = false
  }
}

async function mountPreviews() {
  await nextTick()
  const root = treeRef.value
  if (!root) return
  unregisterPreviewsIn(root)
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-palette]').forEach((canvas) => {
    registerPreview({
      canvas,
      palette: Number(canvas.dataset.palette) || 0,
      hueShift: Number(canvas.dataset.hue) || 0,
    })
  })
  startSkinPreviews()
}

async function refresh() {
  await loadData()
  if (!props.snapshot) {
    try {
      const maxPalette = Math.max(0, ...roster.value.map((d) => d.charSprite ?? 0)) + 1
      await loadCharacterImages(maxPalette)
    } catch {
      /* sprites optional */
    }
  }
  await mountPreviews()
}

watch([snapshotAgents, userAgents, roster], () => void mountPreviews())

onMounted(async () => {
  if (!props.snapshot) void boss.refreshSession()
  try {
    await loadOfficeProfile()
  } catch {
    /* profile optional */
  }
  if (props.snapshot && props.userAgents) {
    const r = await api.get<{ departments?: RosterDept[] }>('/api/office/roster')
    roster.value = r.departments || []
    try {
      const maxPalette = Math.max(0, ...roster.value.map((d) => d.charSprite ?? 0)) + 1
      await loadCharacterImages(maxPalette)
    } catch {
      /* sprites optional */
    }
    await mountPreviews()
  } else {
    void refresh()
  }
})

onUnmounted(() => stopSkinPreviews())

defineExpose({ refresh })
</script>

<template>
  <div class="org-chart">
    <p v-if="loading" class="hint">Loading organization chart…</p>

    <template v-else>
      <div class="tab-toolbar org-toolbar">
        <p class="hint">
          <strong>{{ resolvedDesktopName }}</strong> · Boss → Secretary → CEO → departments.
          {{ filledDeptCount }} of {{ departmentGroups.length }} departments ·
          {{ hiredEmployeeCount }} employees hired.
        </p>
        <div class="org-controls">
          <span class="org-zoom-label">{{ Math.round(scale * 100) }}%</span>
          <button type="button" class="btn ghost sm" @click="resetView">Reset view</button>
        </div>
      </div>
      <p class="hint org-pan-hint">Scroll to zoom · drag empty space to pan</p>

      <div
        ref="viewportRef"
        class="org-viewport"
        :class="{ dragging }"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <div ref="treeRef" class="org-tree" :style="treeStyle">
          <!-- Boss -->
          <div class="org-level org-level-boss">
            <article class="org-node org-node-boss org-node-active">
              <div class="org-node-avatar org-node-avatar-boss" aria-hidden="true">👔</div>
              <div class="org-node-body">
                <span class="org-node-dept">{{ bossNode.deptLabel }}</span>
                <strong class="org-node-name">{{ bossNode.occupantName }}</strong>
              </div>
            </article>
          </div>

          <div class="org-connector org-connector-down" aria-hidden="true" />

          <!-- Secretary (front door, below Boss) -->
          <div class="org-level org-level-leader">
            <article
              v-if="secretaryNode"
              class="org-node org-node-secretary org-node-active"
            >
              <div class="org-node-avatar">
                <canvas
                  :width="AGENT_SKIN_CANVAS"
                  :height="AGENT_SKIN_CANVAS"
                  :data-palette="secretaryNode.charSprite"
                  :data-hue="secretaryNode.hueShift"
                  :aria-label="secretaryNode.occupantName || secretaryNode.deptLabel"
                />
              </div>
              <div class="org-node-body">
                <span class="org-node-dept">{{ secretaryNode.deptLabel }}</span>
                <strong class="org-node-name">{{ secretaryNode.occupantName || 'Secretary' }}</strong>
                <span class="tag built">Front door · OpenClaw main</span>
                <span class="pill" :class="{ ok: secretaryNode.npcState === 'working' }">
                  {{ secretaryNode.npcState === 'working' ? 'Working' : 'Idle' }}
                </span>
              </div>
            </article>
          </div>

          <div class="org-connector org-connector-down" aria-hidden="true" />

          <!-- CEO (below Secretary) -->
          <div class="org-level org-level-leader">
            <article
              v-if="ceoNode"
              class="org-node org-node-ceo"
              :class="ceoNode.kind === 'vacant' ? 'org-node-inactive' : 'org-node-active'"
            >
              <div class="org-node-avatar">
                <canvas
                  :width="AGENT_SKIN_CANVAS"
                  :height="AGENT_SKIN_CANVAS"
                  :data-palette="ceoNode.charSprite"
                  :data-hue="ceoNode.hueShift"
                  :aria-label="ceoNode.occupantName || ceoNode.deptLabel"
                />
              </div>
              <div class="org-node-body">
                <span class="org-node-dept">{{ ceoNode.deptLabel }}</span>
                <strong class="org-node-name">{{ ceoNode.occupantName || 'Vacant' }}</strong>
                <span v-if="ceoNode.kind === 'vacant'" class="tag">Hire from Browse</span>
                <span v-else class="tag">Hired</span>
                <span
                  v-if="ceoNode.kind !== 'vacant'"
                  class="pill"
                  :class="{ ok: ceoNode.npcState === 'working' }"
                >
                  {{ ceoNode.npcState === 'working' ? 'Working' : 'Idle' }}
                </span>
              </div>
            </article>
          </div>

          <div class="org-connector org-connector-fan" aria-hidden="true">
            <span class="org-connector-bar" />
          </div>

          <!-- Departments under CEO — each column can have multiple employees -->
          <div class="org-level org-level-depts">
            <div
              v-for="dept in departmentGroups"
              :key="dept.role"
              class="org-dept-column"
              :class="dept.hasEmployees ? 'org-dept-active' : 'org-dept-inactive'"
            >
              <div class="org-dept-label">{{ dept.label }}</div>
              <div class="org-dept-staff">
                <article
                  v-for="emp in dept.employees"
                  :key="emp.id"
                  class="org-node org-node-employee org-node-active"
                >
                  <div class="org-node-avatar">
                    <canvas
                      :width="AGENT_SKIN_CANVAS"
                      :height="AGENT_SKIN_CANVAS"
                      :data-palette="emp.charSprite"
                      :data-hue="emp.hueShift"
                      :aria-label="emp.name"
                    />
                  </div>
                  <div class="org-node-body">
                    <strong class="org-node-name">{{ emp.name }}</strong>
                    <span v-if="emp.kind === 'external'" class="tag">External</span>
                    <span v-else class="tag">Hired</span>
                    <span class="pill" :class="{ ok: emp.npcState === 'working' }">
                      {{ emp.npcState === 'working' ? 'Working' : 'Idle' }}
                    </span>
                  </div>
                </article>
                <article v-if="!dept.employees.length" class="org-node org-node-employee org-node-inactive">
                  <div class="org-node-avatar">
                    <canvas
                      :width="AGENT_SKIN_CANVAS"
                      :height="AGENT_SKIN_CANVAS"
                      :data-palette="dept.charSprite"
                      data-hue="0"
                      aria-hidden="true"
                    />
                  </div>
                  <div class="org-node-body">
                    <strong class="org-node-name">Vacant</strong>
                    <span class="tag">Hire from Browse</span>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.org-chart {
  padding-bottom: 24px;
}

.org-toolbar {
  margin-bottom: 8px;
}

.org-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.org-zoom-label {
  font-size: 12px;
  color: var(--muted);
  min-width: 3.5em;
  text-align: right;
}

.org-pan-hint {
  margin: 0 0 10px;
  font-size: 12px;
}

.btn.sm {
  font-size: 12px;
  padding: 4px 10px;
}

.org-viewport {
  position: relative;
  height: min(72vh, 720px);
  min-height: 420px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
  background:
    radial-gradient(circle at 50% 0%, rgba(70, 209, 96, 0.04), transparent 55%),
    rgba(0, 0, 0, 0.2);
  cursor: grab;
  touch-action: none;
}

.org-viewport.dragging {
  cursor: grabbing;
}

.org-tree {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  padding: 32px 48px 48px;
  transform-origin: 0 0;
  will-change: transform;
}

.org-level {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 16px;
  width: 100%;
}

.org-level-leader {
  max-width: 200px;
}

.org-level-exec {
  max-width: 720px;
}

.org-level-depts {
  max-width: 1200px;
  align-items: flex-start;
}

.org-dept-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  min-width: 148px;
  max-width: 188px;
  padding: 10px 8px 12px;
  border-radius: 14px;
  transition: filter 0.2s, opacity 0.2s;
}

.org-dept-column-exec {
  min-width: 140px;
}

.org-dept-active {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--line);
}

.org-dept-inactive {
  background: rgba(255, 255, 255, 0.01);
  border: 1px dashed rgba(255, 255, 255, 0.12);
  filter: grayscale(1) brightness(0.55);
  opacity: 0.72;
}

.org-dept-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  text-align: center;
  line-height: 1.3;
  padding: 0 4px;
}

.org-dept-inactive .org-dept-label {
  color: rgba(255, 255, 255, 0.35);
}

.org-dept-staff {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.org-node-employee {
  min-width: 128px;
  max-width: 168px;
  padding: 12px 10px;
  width: 100%;
}

.org-node-employee .org-node-avatar {
  width: 64px;
  height: 64px;
  margin-bottom: 6px;
}

.org-node-employee .org-node-avatar canvas {
  width: 64px;
  height: 64px;
}

.org-connector {
  flex-shrink: 0;
}

.org-connector-down {
  width: 2px;
  height: 28px;
  background: var(--line);
}

.org-connector-fan {
  position: relative;
  width: min(100%, 900px);
  height: 28px;
  margin: 0 auto;
}

.org-connector-bar {
  display: block;
  position: absolute;
  top: 0;
  left: 10%;
  right: 10%;
  height: 2px;
  background: var(--line);
}

.org-connector-fan::after {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 2px;
  height: 28px;
  background: var(--line);
  transform: translateX(-50%);
}

.org-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 140px;
  max-width: 180px;
  padding: 14px 12px;
  border-radius: 12px;
  text-align: center;
  transition: filter 0.2s, border-color 0.15s, background 0.2s;
}

.org-node-active {
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.04);
}

.org-node-active:hover {
  border-color: rgba(70, 209, 96, 0.4);
}

.org-node-inactive {
  border: 1px dashed rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.015);
  filter: grayscale(1) brightness(0.55);
  opacity: 0.72;
}

.org-node-inactive:hover {
  filter: grayscale(0.85) brightness(0.65);
  opacity: 0.85;
}

.org-node-boss {
  border-color: rgba(70, 209, 96, 0.5);
  background: rgba(70, 209, 96, 0.1);
  min-width: 160px;
}

.org-node-secretary {
  border-color: rgba(70, 209, 96, 0.45);
  background: rgba(70, 209, 96, 0.08);
}

.org-node-ceo {
  border-color: rgba(100, 180, 255, 0.45);
  background: rgba(100, 180, 255, 0.08);
}

.org-node-avatar {
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
}

.org-node-avatar canvas {
  image-rendering: pixelated;
  width: 72px;
  height: 72px;
}

.org-node-avatar-boss {
  font-size: 36px;
  line-height: 1;
}

.org-node-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.org-node-dept {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.org-node-inactive .org-node-dept,
.org-node-inactive .org-node-name {
  color: rgba(255, 255, 255, 0.35);
}

.org-node-name {
  font-size: 14px;
  line-height: 1.25;
}

.org-node-body .tag,
.org-node-body .pill {
  margin-top: 2px;
}

.org-node-inactive .tag {
  border-color: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.3);
}
</style>
