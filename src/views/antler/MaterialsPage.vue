<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { NModal, NInput, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAntlerApi } from '@/composables/useAntlerApi'
import PdfViewer from '@/components/common/PdfViewer.vue'

interface MaterialEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  extension?: string
  kind?: string
  size?: number
  sizeLabel?: string
  updatedAtMs?: number
  mimeType?: string
  previewable?: boolean
}

interface MaterialDetail extends MaterialEntry {
  absolutePath?: string
  createdAtMs?: number
}

interface MaterialsListResponse {
  ok?: boolean
  rootPath?: string
  path?: string
  absolutePath?: string
  entries?: MaterialEntry[]
  openclawHint?: string
  error?: string
}

interface ClipboardState {
  mode: 'copy' | 'cut'
  entry: MaterialEntry
}

type ContextAction =
  | 'properties'
  | 'copyPath'
  | 'viewDetail'
  | 'move'
  | 'duplicate'
  | 'cut'
  | 'copy'
  | 'delete'
  | 'paste'

const { t } = useI18n()
const api = useAntlerApi()
const message = useMessage()

const loading = ref(false)
const rootPath = ref('')
const currentPath = ref('')
const absolutePath = ref('')
const entries = ref<MaterialEntry[]>([])
const openclawHint = ref('')
const viewMode = ref<'list' | 'grid'>('list')

const showCreateModal = ref(false)
const newFolderName = ref('')
const createLoading = ref(false)

const showRootModal = ref(false)
const rootInput = ref('')
const rootLoading = ref(false)

const clipboard = ref<ClipboardState | null>(null)

const ctx = ref({ show: false, x: 0, y: 0, entry: null as MaterialEntry | null })

const showPreview = ref(false)
const previewLoading = ref(false)
const previewEntry = ref<MaterialEntry | null>(null)
const previewText = ref('')
const previewImageUrl = ref('')
const previewBinary = ref(false)

const showDetail = ref(false)
const detailLoading = ref(false)
const detailEntry = ref<MaterialDetail | null>(null)

const showMoveModal = ref(false)
const moveTarget = ref<MaterialEntry | null>(null)
const moveDest = ref('')
const moveLoading = ref(false)

const pathParts = computed(() =>
  currentPath.value ? currentPath.value.split('/').filter(Boolean) : [],
)

const sortedEntries = computed(() => {
  const dirs = entries.value.filter((e) => e.type === 'directory')
  const files = entries.value.filter((e) => e.type === 'file')
  return [...dirs, ...files]
})

const canPaste = computed(() => !!clipboard.value)

function fmt(ts?: number) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function absPath(entry: MaterialEntry | string) {
  const rel = typeof entry === 'string' ? entry : entry.path
  return `${rootPath.value}/${rel}`.replace(/\\/g, '/')
}

function mediaUrl(path: string) {
  return `/api/materials/get?path=${encodeURIComponent(path)}&binary=true`
}

function entryIcon(entry: MaterialEntry) {
  if (entry.type === 'directory') return '📁'
  switch (entry.kind) {
    case 'Image': return '🖼️'
    case 'Video': return '🎬'
    case 'PDF': return '📕'
    case 'Document': return '📝'
    case 'Text': return '📄'
    default: return '📦'
  }
}

function isImage(entry: MaterialEntry) {
  return entry.kind === 'Image'
}

function isVideo(entry: MaterialEntry) {
  return entry.kind === 'Video'
}

function isPdf(entry: MaterialEntry) {
  return entry.kind === 'PDF'
}

async function loadWorkspace() {
  const r = await api.get<MaterialsListResponse>('/api/materials')
  rootPath.value = r.rootPath || ''
  openclawHint.value = r.openclawHint || ''
}

async function refresh() {
  loading.value = true
  try {
    const q = currentPath.value ? `?path=${encodeURIComponent(currentPath.value)}` : ''
    const r = await api.get<MaterialsListResponse>(`/api/materials/list${q}`)
    if (!r.ok) throw new Error(r.error || 'Could not list folder')
    rootPath.value = r.rootPath || rootPath.value
    currentPath.value = r.path || ''
    absolutePath.value = r.absolutePath || ''
    entries.value = r.entries || []
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not load materials')
  } finally {
    loading.value = false
  }
}

async function navigateTo(path: string) {
  currentPath.value = path
  await refresh()
}

function goUp() {
  if (!currentPath.value) return
  const parts = currentPath.value.split('/').filter(Boolean)
  parts.pop()
  navigateTo(parts.join('/'))
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('common.copied'))
  } catch {
    message.error(t('common.copyFailed'))
  }
}

async function createFolder() {
  const name = newFolderName.value.trim()
  if (!name) return
  createLoading.value = true
  try {
    await api.send('POST', '/api/materials/mkdir', { path: currentPath.value, name })
    showCreateModal.value = false
    newFolderName.value = ''
    message.success(t('pages.materials.folderCreated'))
    await refresh()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.folderCreateFailed'))
  } finally {
    createLoading.value = false
  }
}

async function deleteEntry(entry: MaterialEntry) {
  try {
    await api.send('POST', '/api/materials/delete', { path: entry.path })
    if (clipboard.value?.entry.path === entry.path) clipboard.value = null
    message.success(t('pages.materials.deleted'))
    await refresh()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.deleteFailed'))
  }
}

async function saveRoot() {
  rootLoading.value = true
  try {
    const r = await api.send<MaterialsListResponse>('POST', '/api/materials/root', {
      rootPath: rootInput.value.trim(),
    })
    rootPath.value = r.rootPath || ''
    openclawHint.value = r.openclawHint || ''
    showRootModal.value = false
    currentPath.value = ''
    message.success(t('pages.materials.rootUpdated'))
    await refresh()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.rootUpdateFailed'))
  } finally {
    rootLoading.value = false
  }
}

function openRootModal() {
  rootInput.value = rootPath.value
  showRootModal.value = true
}

function closeContextMenu() {
  ctx.value.show = false
}

function openContextMenu(event: MouseEvent, entry: MaterialEntry | null) {
  event.preventDefault()
  ctx.value = {
    show: true,
    x: event.clientX,
    y: event.clientY,
    entry,
  }
}

function handleEntryClick(entry: MaterialEntry) {
  if (entry.type === 'directory') {
    navigateTo(entry.path)
    return
  }
  openPreview(entry)
}

async function openPreview(entry: MaterialEntry) {
  previewEntry.value = entry
  previewText.value = ''
  previewImageUrl.value = ''
  previewBinary.value = false
  showPreview.value = true
  previewLoading.value = true

  try {
    if (isImage(entry)) {
      previewImageUrl.value = mediaUrl(entry.path)
    } else if (isVideo(entry) || isPdf(entry)) {
      previewBinary.value = true
    } else {
      const r = await api.get<{ file?: { content?: string; binary?: boolean } }>(
        `/api/materials/get?path=${encodeURIComponent(entry.path)}`,
      )
      if (r.file?.binary) {
        previewBinary.value = true
      } else {
        previewText.value = r.file?.content || ''
      }
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.previewFailed'))
    showPreview.value = false
  } finally {
    previewLoading.value = false
  }
}

async function openDetail(entry: MaterialEntry) {
  detailEntry.value = null
  showDetail.value = true
  detailLoading.value = true
  try {
    const r = await api.get<{ entry?: MaterialDetail }>(
      `/api/materials/stat?path=${encodeURIComponent(entry.path)}`,
    )
    detailEntry.value = r.entry || null
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.detailFailed'))
    showDetail.value = false
  } finally {
    detailLoading.value = false
  }
}

function openMove(entry: MaterialEntry) {
  moveTarget.value = entry
  moveDest.value = currentPath.value
  showMoveModal.value = true
}

async function confirmMove() {
  if (!moveTarget.value) return
  moveLoading.value = true
  try {
    await api.send('POST', '/api/materials/move', {
      fromPath: moveTarget.value.path,
      toPath: moveDest.value.trim(),
    })
    if (clipboard.value?.entry.path === moveTarget.value.path) clipboard.value = null
    showMoveModal.value = false
    message.success(t('pages.materials.moved'))
    await refresh()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.moveFailed'))
  } finally {
    moveLoading.value = false
  }
}

async function duplicateEntry(entry: MaterialEntry) {
  try {
    await api.send('POST', '/api/materials/duplicate', { path: entry.path })
    message.success(t('pages.materials.duplicated'))
    await refresh()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.duplicateFailed'))
  }
}

function cutEntry(entry: MaterialEntry) {
  clipboard.value = { mode: 'cut', entry }
  message.info(t('pages.materials.cutReady', { name: entry.name }))
}

function copyEntry(entry: MaterialEntry) {
  clipboard.value = { mode: 'copy', entry }
  message.info(t('pages.materials.copyReady', { name: entry.name }))
}

async function pasteClipboard(targetDir?: string) {
  if (!clipboard.value) return
  const toDir = targetDir ?? currentPath.value
  try {
    await api.send('POST', '/api/materials/paste', {
      mode: clipboard.value.mode,
      fromPath: clipboard.value.entry.path,
      toDir,
    })
    if (clipboard.value.mode === 'cut') clipboard.value = null
    message.success(t('pages.materials.pasted'))
    await refresh()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.pasteFailed'))
  }
}

async function runContextAction(action: ContextAction) {
  const entry = ctx.value.entry
  closeContextMenu()

  if (action === 'paste') {
    await pasteClipboard(entry?.type === 'directory' ? entry.path : undefined)
    return
  }
  if (!entry) return

  switch (action) {
    case 'properties':
    case 'viewDetail':
      await openDetail(entry)
      break
    case 'copyPath':
      await copyText(absPath(entry))
      break
    case 'move':
      openMove(entry)
      break
    case 'duplicate':
      await duplicateEntry(entry)
      break
    case 'cut':
      cutEntry(entry)
      break
    case 'copy':
      copyEntry(entry)
      break
    case 'delete':
      if (window.confirm(
        entry.type === 'directory'
          ? t('pages.materials.confirmDeleteFolder', { name: entry.name })
          : t('pages.materials.confirmDeleteFile', { name: entry.name }),
      )) {
        await deleteEntry(entry)
      }
      break
  }
}

function onDocumentClick() {
  closeContextMenu()
}

onMounted(async () => {
  document.addEventListener('click', onDocumentClick)
  await loadWorkspace()
  await refresh()
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
})
</script>

<template>
  <div class="antler-v1-root materials-page" @contextmenu.prevent="openContextMenu($event, null)">
    <div class="view-head">
      <h1 class="view-title">{{ t('routes.materials') }}</h1>
      <div class="inline actions">
        <button
          type="button"
          class="btn ghost sm"
          :class="{ active: viewMode === 'list' }"
          @click="viewMode = 'list'"
        >
          {{ t('pages.materials.listView') }}
        </button>
        <button
          type="button"
          class="btn ghost sm"
          :class="{ active: viewMode === 'grid' }"
          @click="viewMode = 'grid'"
        >
          {{ t('pages.materials.gridView') }}
        </button>
        <button
          v-if="canPaste"
          type="button"
          class="btn ghost sm"
          @click="pasteClipboard()"
        >
          {{ t('pages.materials.paste') }}
        </button>
        <button type="button" class="btn ghost sm" :disabled="loading" @click="refresh">
          {{ t('common.refresh') }}
        </button>
        <button type="button" class="btn ghost sm" @click="showCreateModal = true">
          {{ t('pages.materials.newFolder') }}
        </button>
        <button type="button" class="btn ghost sm" @click="openRootModal">
          {{ t('pages.materials.changeRoot') }}
        </button>
      </div>
    </div>

    <p class="hint">{{ t('pages.materials.hint') }}</p>

    <div class="root-bar panel">
      <div class="root-label">{{ t('pages.materials.libraryRoot') }}</div>
      <code class="root-path">{{ rootPath }}</code>
      <button type="button" class="btn ghost sm" @click="copyText(rootPath)">
        {{ t('common.copy') }}
      </button>
    </div>

    <div v-if="openclawHint" class="openclaw-hint panel">
      <span class="badge">OpenClaw</span>
      {{ openclawHint }}
    </div>

    <div class="path-bar panel">
      <button type="button" class="crumb" :disabled="!currentPath" @click="navigateTo('')">
        {{ t('pages.materials.root') }}
      </button>
      <template v-for="(part, idx) in pathParts" :key="idx">
        <span class="sep">/</span>
        <button
          type="button"
          class="crumb"
          @click="navigateTo(pathParts.slice(0, idx + 1).join('/'))"
        >
          {{ part }}
        </button>
      </template>
      <div class="path-actions">
        <button v-if="currentPath" type="button" class="btn ghost sm" @click="goUp">
          {{ t('pages.materials.up') }}
        </button>
        <button type="button" class="btn ghost sm" @click="copyText(absolutePath)">
          {{ t('pages.materials.copyPath') }}
        </button>
      </div>
    </div>

    <p v-if="loading && !entries.length" class="hint">{{ t('pages.materials.loading') }}…</p>
    <p v-else-if="!entries.length" class="hint">{{ t('pages.materials.empty') }}</p>

    <!-- List view -->
    <div v-else-if="viewMode === 'list'" class="file-table panel">
      <div class="file-row head">
        <span></span>
        <span>{{ t('pages.materials.colName') }}</span>
        <span>{{ t('pages.materials.colType') }}</span>
        <span>{{ t('pages.materials.colSize') }}</span>
        <span>{{ t('pages.materials.colModified') }}</span>
      </div>
      <div
        v-for="entry in sortedEntries"
        :key="entry.path"
        class="file-row"
        :class="{ dir: entry.type === 'directory', selected: ctx.entry?.path === entry.path }"
        @click="handleEntryClick(entry)"
        @contextmenu.stop.prevent="openContextMenu($event, entry)"
      >
        <span class="icon">{{ entryIcon(entry) }}</span>
        <span class="name">{{ entry.name }}</span>
        <span class="meta kind">{{ entry.kind || '—' }}</span>
        <span class="meta">{{ entry.sizeLabel }}</span>
        <span class="meta">{{ fmt(entry.updatedAtMs) }}</span>
      </div>
    </div>

    <!-- Grid view -->
    <div v-else class="grid-view">
      <div
        v-for="entry in sortedEntries"
        :key="entry.path"
        class="grid-card panel"
        @click="handleEntryClick(entry)"
        @contextmenu.stop.prevent="openContextMenu($event, entry)"
      >
        <div class="thumb">
          <img
            v-if="isImage(entry)"
            :src="mediaUrl(entry.path)"
            :alt="entry.name"
            loading="lazy"
          >
          <span v-else class="thumb-icon">{{ entryIcon(entry) }}</span>
        </div>
        <div class="grid-name" :title="entry.name">{{ entry.name }}</div>
        <div class="grid-meta">
          <span class="kind-tag">{{ entry.kind }}</span>
          <span>{{ entry.sizeLabel }}</span>
        </div>
      </div>
    </div>

    <!-- Context menu -->
    <div
      v-if="ctx.show"
      class="ctx-menu"
      :style="{ top: `${ctx.y}px`, left: `${ctx.x}px` }"
      @click.stop
    >
      <template v-if="ctx.entry">
        <button type="button" @click="runContextAction('viewDetail')">{{ t('pages.materials.viewDetail') }}</button>
        <button type="button" @click="runContextAction('properties')">{{ t('pages.materials.properties') }}</button>
        <button type="button" @click="runContextAction('copyPath')">{{ t('pages.materials.copyPath') }}</button>
        <hr>
        <button type="button" @click="runContextAction('cut')">{{ t('pages.materials.cut') }}</button>
        <button type="button" @click="runContextAction('copy')">{{ t('pages.materials.copy') }}</button>
        <button type="button" @click="runContextAction('duplicate')">{{ t('pages.materials.duplicate') }}</button>
        <button type="button" @click="runContextAction('move')">{{ t('pages.materials.move') }}</button>
        <hr>
        <button type="button" class="danger" @click="runContextAction('delete')">{{ t('common.delete') }}</button>
      </template>
      <button v-if="canPaste" type="button" @click="runContextAction('paste')">{{ t('pages.materials.paste') }}</button>
    </div>

    <!-- Preview modal -->
    <NModal
      v-model:show="showPreview"
      preset="card"
      :title="previewEntry?.name || t('pages.materials.preview')"
      style="width: min(920px, 92vw)"
    >
      <NSpin :show="previewLoading">
        <div v-if="previewEntry" class="preview-body">
          <img
            v-if="isImage(previewEntry) && previewImageUrl"
            :src="previewImageUrl"
            :alt="previewEntry.name"
            class="preview-image"
          >
          <video
            v-else-if="isVideo(previewEntry)"
            :src="mediaUrl(previewEntry.path)"
            controls
            class="preview-video"
          />
          <PdfViewer
            v-else-if="isPdf(previewEntry)"
            :url="mediaUrl(previewEntry.path)"
          />
          <pre v-else-if="previewText" class="preview-text">{{ previewText }}</pre>
          <div v-else class="preview-fallback">
            <p>{{ t('pages.materials.previewUnavailable') }}</p>
            <code>{{ absPath(previewEntry) }}</code>
          </div>
        </div>
      </NSpin>
      <template #footer>
        <button type="button" class="btn ghost" @click="copyText(absPath(previewEntry!))">
          {{ t('pages.materials.copyPath') }}
        </button>
        <button type="button" class="btn" @click="showPreview = false">{{ t('common.close') }}</button>
      </template>
    </NModal>

    <!-- Detail / properties modal -->
    <NModal
      v-model:show="showDetail"
      preset="card"
      :title="t('pages.materials.properties')"
      style="max-width: 520px"
    >
      <NSpin :show="detailLoading">
        <dl v-if="detailEntry" class="detail-list">
          <dt>{{ t('pages.materials.colName') }}</dt>
          <dd>{{ detailEntry.name }}</dd>
          <dt>{{ t('pages.materials.colType') }}</dt>
          <dd>{{ detailEntry.kind }}</dd>
          <dt>{{ t('pages.materials.colSize') }}</dt>
          <dd>{{ detailEntry.sizeLabel }}</dd>
          <dt>{{ t('pages.materials.colModified') }}</dt>
          <dd>{{ fmt(detailEntry.updatedAtMs) }}</dd>
          <dt>{{ t('pages.materials.created') }}</dt>
          <dd>{{ fmt(detailEntry.createdAtMs) }}</dd>
          <dt>{{ t('pages.materials.path') }}</dt>
          <dd><code>{{ detailEntry.absolutePath }}</code></dd>
          <template v-if="detailEntry.mimeType">
            <dt>MIME</dt>
            <dd>{{ detailEntry.mimeType }}</dd>
          </template>
        </dl>
      </NSpin>
      <template #footer>
        <button type="button" class="btn ghost" @click="copyText(detailEntry?.absolutePath || '')">
          {{ t('pages.materials.copyPath') }}
        </button>
        <button type="button" class="btn" @click="showDetail = false">{{ t('common.close') }}</button>
      </template>
    </NModal>

    <!-- Move modal -->
    <NModal
      v-model:show="showMoveModal"
      preset="card"
      :title="t('pages.materials.move')"
      style="max-width: 520px"
    >
      <p class="hint">{{ t('pages.materials.moveHint', { name: moveTarget?.name || '' }) }}</p>
      <NInput
        v-model:value="moveDest"
        :placeholder="t('pages.materials.movePlaceholder')"
      />
      <template #footer>
        <button type="button" class="btn ghost" @click="showMoveModal = false">{{ t('common.cancel') }}</button>
        <button type="button" class="btn" :disabled="moveLoading" @click="confirmMove">{{ t('common.confirm') }}</button>
      </template>
    </NModal>

    <NModal
      v-model:show="showCreateModal"
      preset="card"
      :title="t('pages.materials.newFolder')"
      style="max-width: 420px"
    >
      <NInput
        v-model:value="newFolderName"
        :placeholder="t('pages.materials.folderNamePlaceholder')"
        @keyup.enter="createFolder"
      />
      <template #footer>
        <button type="button" class="btn ghost" @click="showCreateModal = false">{{ t('common.cancel') }}</button>
        <button type="button" class="btn" :disabled="createLoading" @click="createFolder">{{ t('common.confirm') }}</button>
      </template>
    </NModal>

    <NModal
      v-model:show="showRootModal"
      preset="card"
      :title="t('pages.materials.changeRoot')"
      style="max-width: 560px"
    >
      <p class="hint">{{ t('pages.materials.changeRootHint') }}</p>
      <NInput v-model:value="rootInput" :placeholder="t('pages.materials.rootPlaceholder')" />
      <template #footer>
        <button type="button" class="btn ghost" @click="showRootModal = false">{{ t('common.cancel') }}</button>
        <button type="button" class="btn" :disabled="rootLoading" @click="saveRoot">{{ t('common.save') }}</button>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.materials-page {
  padding-bottom: 24px;
}
.view-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.view-title {
  margin: 0;
  font-size: 24px;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.btn.sm {
  padding: 6px 10px;
  font-size: 13px;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.root-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.root-label {
  font-size: 12px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.root-path {
  flex: 1;
  min-width: 200px;
  font-size: 13px;
  word-break: break-all;
}
.openclaw-hint {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--muted);
}
.badge {
  background: rgba(70, 209, 96, 0.15);
  color: var(--accent);
  border: 1px solid rgba(70, 209, 96, 0.35);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
}
.path-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.crumb {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
}
.crumb:disabled {
  color: var(--text);
  cursor: default;
}
.sep {
  color: var(--muted);
}
.path-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.file-table {
  padding: 0;
  overflow: hidden;
}
.file-row {
  display: grid;
  grid-template-columns: 32px 1.4fr 0.7fr 0.6fr 1fr;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
}
.file-row.head {
  cursor: default;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  background: rgba(255, 255, 255, 0.02);
}
.file-row:last-child {
  border-bottom: none;
}
.file-row:hover:not(.head),
.file-row.selected {
  background: rgba(255, 255, 255, 0.04);
}
.file-row.dir .name {
  color: var(--accent);
}
.icon {
  font-size: 18px;
}
.name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.kind-tag,
.meta.kind {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--line);
  font-size: 11px;
}
.grid-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}
.grid-card {
  margin-bottom: 0;
  padding: 10px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.grid-card:hover {
  border-color: var(--accent);
}
.thumb {
  aspect-ratio: 1;
  border-radius: 8px;
  background: var(--panel-2);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  margin-bottom: 8px;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb-icon {
  font-size: 42px;
}
.grid-name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grid-meta {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted);
}
.ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}
.ctx-menu button {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.ctx-menu button:hover {
  background: rgba(255, 255, 255, 0.06);
}
.ctx-menu button.danger {
  color: #f08050;
}
.ctx-menu hr {
  border: none;
  border-top: 1px solid var(--line);
  margin: 4px 0;
}
.preview-body {
  min-height: 200px;
  max-height: 70vh;
  overflow: auto;
}
.preview-image,
.preview-video {
  max-width: 100%;
  max-height: 65vh;
  display: block;
  margin: 0 auto;
}
.preview-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.5;
  margin: 0;
}
.preview-fallback {
  text-align: center;
  color: var(--muted);
}
.detail-list {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 8px 12px;
  margin: 0;
}
.detail-list dt {
  color: var(--muted);
  font-size: 12px;
}
.detail-list dd {
  margin: 0;
  word-break: break-all;
}
@media (max-width: 720px) {
  .file-row {
    grid-template-columns: 32px 1fr;
    grid-template-rows: auto auto;
  }
  .file-row.head span:nth-child(n + 3),
  .file-row .meta {
    display: none;
  }
}
</style>
