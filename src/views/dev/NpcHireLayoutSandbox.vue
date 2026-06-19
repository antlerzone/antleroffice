<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  DETAIL_AGENT_CANVAS,
  loadCharacterImages,
  registerPreview,
  startSkinPreviews,
  stopSkinPreviews,
  unregisterPreviewsIn,
} from '@/lib/skin-preview'
import {
  NPC_HIRE_LAYOUT_DEFAULT,
  clearNpcHireLayoutStorage,
  layoutReport,
  layoutToAgentColStyle,
  layoutToCssSnippet,
  layoutToSceneStyle,
  layoutToStatsStyle,
  loadNpcHireLayout,
  normalizeNpcHireLayout,
  saveNpcHireLayoutToStorage,
  saveNpcHireLayoutShared,
  type NpcHireLayout,
} from '@/lib/npc-hire-layout'

const layout = reactive<NpcHireLayout>({ ...NPC_HIRE_LAYOUT_DEFAULT })
const baseline = ref<NpcHireLayout>({ ...NPC_HIRE_LAYOUT_DEFAULT })
const savedFlash = ref('')
const dragLabel = ref('')

const agentCanvasRef = ref<HTMLCanvasElement | null>(null)

const sceneStyle = computed(() => layoutToSceneStyle(layout))
const agentColStyle = computed(() => layoutToAgentColStyle(layout))
const statsStyle = computed(() => layoutToStatsStyle(layout))

type DragTarget = 'agent' | 'agent-resize' | 'stats' | 'scene' | null
let dragTarget: DragTarget = null
let dragStartX = 0
let dragStartY = 0
let dragStartLayout: NpcHireLayout | null = null

function flash(msg: string) {
  savedFlash.value = msg
  window.setTimeout(() => {
    if (savedFlash.value === msg) savedFlash.value = ''
  }, 2400)
}

async function mountAgentPreview() {
  await loadCharacterImages()
  const canvas = agentCanvasRef.value
  if (!canvas) return
  unregisterPreviewsIn(canvas.parentElement ?? undefined)
  registerPreview({ canvas, palette: 0 })
  startSkinPreviews()
}

onMounted(async () => {
  const loaded = await loadNpcHireLayout()
  Object.assign(layout, loaded)
  baseline.value = { ...loaded }
  await mountAgentPreview()
})

onUnmounted(() => {
  stopSkinPreviews()
  if (agentCanvasRef.value?.parentElement) unregisterPreviewsIn(agentCanvasRef.value.parentElement)
})

watch(agentCanvasRef, () => {
  void mountAgentPreview()
})

function onPointerDown(e: PointerEvent, target: DragTarget) {
  if (!target) return
  dragTarget = target
  dragStartX = e.clientX
  dragStartY = e.clientY
  dragStartLayout = { ...layout }
  dragLabel.value =
    target === 'agent'
      ? '拖动 Pixel Agent'
      : target === 'agent-resize'
        ? '调整 Agent 大小'
        : target === 'stats'
          ? '拖动 Reviews / Downloads'
          : '拖动背景'
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
  e.stopPropagation()
}

function onPointerMove(e: PointerEvent) {
  if (!dragTarget || !dragStartLayout) return
  const dx = e.clientX - dragStartX
  const dy = e.clientY - dragStartY

  if (dragTarget === 'agent') {
    layout.agentOffsetX = Math.round(dragStartLayout.agentOffsetX + dx)
    layout.agentOffsetY = Math.round(dragStartLayout.agentOffsetY + dy)
  } else if (dragTarget === 'agent-resize') {
    layout.agentMaxW = clamp(Math.round(dragStartLayout.agentMaxW + dx), 80, 360)
    layout.agentMaxH = clamp(Math.round(dragStartLayout.agentMaxH + dy), 100, 420)
  } else if (dragTarget === 'stats') {
    layout.statsOffsetX = Math.round(dragStartLayout.statsOffsetX + dx)
    layout.statsOffsetY = Math.round(dragStartLayout.statsOffsetY + dy)
  } else if (dragTarget === 'scene') {
    layout.scenePosX = round1(dragStartLayout.scenePosX + dx * 0.08)
    layout.scenePosY = round1(dragStartLayout.scenePosY + dy * 0.08)
  }
}

function onPointerUp(e: PointerEvent) {
  if (dragTarget) {
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
  }
  dragTarget = null
  dragStartLayout = null
  dragLabel.value = ''
}

function round1(n: number) {
  return Math.round(n * 10) / 10
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function resetDefaults() {
  Object.assign(layout, NPC_HIRE_LAYOUT_DEFAULT)
  flash('已恢复默认值（未保存）')
}

function resetBaseline() {
  Object.assign(layout, { ...baseline.value })
  flash('已恢复到上次保存')
}

function saveLayout() {
  const data = { ...layout }
  void saveNpcHireLayoutShared(data)
    .then(() => {
      baseline.value = { ...data }
      flash('已保存 — 浏览器与 Electron 共用 public/npc-hire-layout.json')
    })
    .catch((e) => {
      saveNpcHireLayoutToStorage(data)
      baseline.value = { ...data }
      flash(e instanceof Error ? e.message : '仅保存到本机 localStorage')
    })
}

async function copyCss() {
  await navigator.clipboard.writeText(layoutToCssSnippet({ ...layout }))
  flash('CSS 变量已复制')
}

function downloadJson() {
  const blob = new Blob([JSON.stringify({ ...layout }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'npc-hire-layout.json'
  a.click()
  URL.revokeObjectURL(url)
  flash('已下载 npc-hire-layout.json')
}

function applyJsonFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      Object.assign(layout, normalizeNpcHireLayout(JSON.parse(String(reader.result))))
      flash(`已载入 ${file.name}（未保存）`)
    } catch {
      flash('JSON 无效')
    }
    input.value = ''
  }
  reader.readAsText(file)
}

function clearSaved() {
  clearNpcHireLayoutStorage()
  flash('已清除 localStorage 记录')
}
</script>

<template>
  <div class="npc-layout-sandbox">
    <aside class="npc-layout-panel">
      <h1>NPC Hire 布局画布</h1>
      <p class="npc-layout-hint">
        拖拽 Agent、Reviews/Downloads 或背景；右下角圆点调整 Agent 大小。Save 后 Details 弹窗自动读取。
      </p>

      <div v-if="dragLabel" class="npc-layout-drag">{{ dragLabel }}</div>
      <div v-if="savedFlash" class="npc-layout-flash">{{ savedFlash }}</div>

      <dl class="npc-layout-values">
        <div>
          <dt>Agent offset</dt>
          <dd>
            X <input v-model.number="layout.agentOffsetX" type="number" step="1" class="sm" /> · Y
            <input v-model.number="layout.agentOffsetY" type="number" step="1" class="sm" /> px
          </dd>
        </div>
        <div>
          <dt>Agent size</dt>
          <dd>
            W <input v-model.number="layout.agentMaxW" type="number" min="80" max="360" class="sm" /> · H
            <input v-model.number="layout.agentMaxH" type="number" min="100" max="420" class="sm" /> px
          </dd>
        </div>
        <div>
          <dt>Stats offset</dt>
          <dd>
            X <input v-model.number="layout.statsOffsetX" type="number" class="sm" /> · Y
            <input v-model.number="layout.statsOffsetY" type="number" class="sm" /> px
          </dd>
        </div>
        <div>
          <dt>Scene pos</dt>
          <dd>
            X <input v-model.number="layout.scenePosX" type="number" step="0.1" class="sm" />% · Y
            <input v-model.number="layout.scenePosY" type="number" step="0.1" class="sm" />%
          </dd>
        </div>
        <div>
          <dt>Scene size-h</dt>
          <dd><input v-model.number="layout.sceneSizeH" type="number" step="1" /> %</dd>
        </div>
      </dl>

      <pre class="npc-layout-report">{{ layoutReport(layout) }}</pre>

      <div class="npc-layout-actions">
        <button type="button" class="primary" @click="saveLayout">Save</button>
        <button type="button" @click="copyCss">Copy CSS</button>
        <button type="button" @click="downloadJson">Download JSON</button>
        <label class="file-btn">
          Load JSON
          <input type="file" accept="application/json,.json" hidden @change="applyJsonFile" />
        </label>
        <button type="button" @click="resetBaseline">Undo to saved</button>
        <button type="button" @click="resetDefaults">Defaults</button>
        <button type="button" class="ghost" @click="clearSaved">Clear storage</button>
      </div>
    </aside>

    <div class="npc-layout-stage">
      <div class="npc-layout-preview-page">
        <div class="npc-hire-modal">
          <div
            class="npc-hire-scene npc-hire-scene--modal npc-layout-draggable"
            :style="sceneStyle"
            aria-hidden="true"
            @pointerdown="onPointerDown($event, 'scene')"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <div class="npc-hire-bg npc-hire-bg--scene" />
            <div class="npc-hire-vignette npc-hire-vignette--modal" />
            <span class="npc-layout-handle scene">背景 · 拖动</span>
          </div>
          <div class="npc-hire-content">
            <div class="npc-hire-col npc-hire-col--left" :style="agentColStyle">
              <div class="npc-hire-left">
                <header class="npc-hire-copy">
                  <span class="npc-hire-brand">AntlerOffice</span>
                  <h2 class="npc-hire-title">Human Resource</h2>
                  <p class="npc-hire-subtitle">Create SaaS NPC workers — catalog, bundles & departments</p>
                </header>

                <div class="npc-hire-showcase">
                  <div
                    class="npc-hire-character npc-layout-draggable"
                    @pointerdown.stop="onPointerDown($event, 'agent')"
                    @pointermove="onPointerMove"
                    @pointerup="onPointerUp"
                    @pointercancel="onPointerUp"
                  >
                    <span class="npc-layout-handle agent">Agent · 拖动</span>
                    <canvas
                      ref="agentCanvasRef"
                      :width="DETAIL_AGENT_CANVAS"
                      :height="DETAIL_AGENT_CANVAS"
                      role="img"
                      aria-label="Agent preview"
                    />
                    <span
                      class="npc-layout-resize"
                      title="拖动调整大小"
                      @pointerdown.stop="onPointerDown($event, 'agent-resize')"
                      @pointermove="onPointerMove"
                      @pointerup="onPointerUp"
                      @pointercancel="onPointerUp"
                    />
                  </div>
                </div>
              </div>

              <div
                class="npc-hire-stats npc-layout-draggable"
                :style="statsStyle"
                @pointerdown.stop="onPointerDown($event, 'stats')"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointercancel="onPointerUp"
              >
                <span class="npc-layout-handle stats">Reviews / Downloads · 拖动</span>
                <div class="npc-hire-stat">
                  <h4 class="npc-hire-stat-title">Reviews</h4>
                  <div class="npc-hire-stat-body">
                    <span class="npc-hire-stat-icon star" aria-hidden="true" />
                    <p class="npc-hire-stat-value"><strong>4.9</strong><em>/ 5.0</em></p>
                  </div>
                  <p class="npc-hire-stat-foot">Based on 46 reviews</p>
                </div>
                <div class="npc-hire-stat">
                  <h4 class="npc-hire-stat-title">Downloads</h4>
                  <div class="npc-hire-stat-body">
                    <span class="npc-hire-stat-icon download" aria-hidden="true" />
                    <p class="npc-hire-stat-value"><strong>1,256+</strong></p>
                  </div>
                  <p class="npc-hire-stat-foot">Total downloads</p>
                </div>
              </div>
            </div>

            <div class="npc-hire-col npc-hire-col--right">
              <div class="npc-hire-right">
                <div class="npc-hire-glass">
                  <header class="npc-hire-glass-head">
                    <h3 class="npc-hire-glass-title">AntlerOffice Human Resource</h3>
                    <div class="npc-hire-salary">
                      <span class="npc-hire-coin" aria-hidden="true">◎</span>
                      <strong>12</strong>
                      <span class="npc-hire-salary-unit">credits / month</span>
                      <em class="npc-hire-salary-label">Salary</em>
                    </div>
                    <div class="npc-hire-divider" aria-hidden="true"><span /></div>
                  </header>
                  <div class="npc-hire-glass-body">
                    <section class="npc-hire-section">
                      <h4 class="npc-hire-section-title">Job Scope</h4>
                      <p class="npc-layout-placeholder">（右侧仅作高度参考）</p>
                    </section>
                  </div>
                  <footer class="npc-hire-glass-footer">
                    <button type="button" class="npc-hire-btn primary" disabled>Hire Agent</button>
                    <button type="button" class="npc-hire-btn secondary" disabled>Cancel</button>
                  </footer>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.npc-layout-sandbox {
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  min-height: 100vh;
  background: #0a0c10;
  color: #e8e4da;
}

.npc-layout-panel {
  position: relative;
  z-index: 2;
  padding: 20px 18px;
  border-right: 1px solid rgba(214, 168, 79, 0.15);
  overflow-y: auto;
}

.npc-layout-panel h1 {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
}

.npc-layout-hint {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(232, 228, 218, 0.55);
}

.npc-layout-drag,
.npc-layout-flash {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
}

.npc-layout-drag {
  background: rgba(214, 168, 79, 0.12);
  border: 1px solid rgba(214, 168, 79, 0.28);
  color: #d6a84f;
}

.npc-layout-flash {
  background: rgba(80, 160, 100, 0.15);
  border: 1px solid rgba(80, 160, 100, 0.35);
  color: #9fd4a9;
}

.npc-layout-values {
  margin: 0 0 12px;
  display: grid;
  gap: 8px;
}

.npc-layout-values div {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 8px;
  align-items: center;
}

.npc-layout-values dt {
  margin: 0;
  font-size: 11px;
  color: rgba(232, 228, 218, 0.5);
}

.npc-layout-values dd {
  margin: 0;
  font-size: 12px;
}

.npc-layout-values input {
  width: 72px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.35);
  color: #f8f4ea;
}

.npc-layout-values input.sm {
  width: 52px;
}

.npc-layout-report {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  color: rgba(232, 228, 218, 0.72);
}

.npc-layout-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.npc-layout-actions button,
.file-btn {
  position: relative;
  z-index: 1;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.06);
  color: #f8f4ea;
  font-size: 12px;
  cursor: pointer;
}

.npc-layout-actions button.primary {
  border-color: rgba(214, 168, 79, 0.45);
  background: linear-gradient(180deg, #d6a84f, #a88422);
  color: #1a1408;
  font-weight: 700;
}

.file-btn {
  display: inline-flex;
  align-items: center;
}

.npc-layout-stage {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow: auto;
}

.npc-layout-preview-page {
  position: relative;
  width: min(1092px, 100%);
  height: min(756px, calc(100vh - 48px));
  padding: 0;
  border-radius: 8px;
  overflow: hidden;
  background: #0f1115;
}

.npc-layout-preview-page .npc-hire-modal {
  width: 100%;
  height: 100%;
  max-height: none;
}

.npc-layout-draggable {
  cursor: grab;
  touch-action: none;
}

.npc-layout-draggable:active {
  cursor: grabbing;
}

.npc-layout-handle {
  position: absolute;
  z-index: 8;
  top: 4px;
  left: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(214, 168, 79, 0.9);
  color: #1a1408;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  pointer-events: none;
}

.npc-hire-character .npc-layout-handle.agent {
  top: -18px;
  left: 50%;
  transform: translateX(-50%);
}

.npc-layout-resize {
  position: absolute;
  right: -6px;
  bottom: -6px;
  z-index: 9;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid #1a1408;
  background: #d6a84f;
  cursor: nwse-resize;
  touch-action: none;
}

.npc-hire-stats {
  outline: 1px dashed rgba(214, 168, 79, 0.35);
  outline-offset: 4px;
}

.npc-hire-character {
  outline: 1px dashed rgba(214, 168, 79, 0.35);
  outline-offset: 4px;
}

.npc-hire-stats .npc-layout-handle.stats {
  top: -20px;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
}

.npc-hire-scene .npc-layout-handle.scene {
  top: 8px;
  right: 8px;
  left: auto;
}

.npc-layout-placeholder {
  margin: 0;
  font-size: 12px;
  color: rgba(248, 244, 234, 0.35);
}
</style>
