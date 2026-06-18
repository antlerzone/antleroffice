<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, h } from 'vue'
import {
  NCard,
  NButton,
  NIcon,
  NSpace,
  NEmpty,
  NSpin,
  NTag,
  NDataTable,
  NModal,
  NInput,
  NSelect,
  NDropdown,
  NGrid,
  NGridItem,
  useMessage,
  type DataTableColumns,
  type DataTableSortState,
} from 'naive-ui'
import {
  FolderOutline,
  AddOutline,
  DocumentOutline,
  ImageOutline,
  VideocamOutline,
  DocumentTextOutline,
  GridOutline,
  ListOutline,
  SearchOutline,
  SaveOutline,
  FunnelOutline,
} from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { ensureApiSession, getApiAuthHeaders } from '@/lib/api-auth'
import { formatRelativeTime } from '@/utils/format'
import StatCard from '@/components/common/StatCard.vue'
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

interface MaterialsWorkspaceResponse {
  ok?: boolean
  rootPath?: string
  defaultRoot?: string
  isDefaultRoot?: boolean
  dataDir?: string
  openclawHint?: string
  error?: string
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

interface MaterialsSummaryResponse {
  ok?: boolean
  rootPath?: string
  fileCount?: number
  folderCount?: number
  totalBytes?: number
  totalSizeLabel?: string
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
  | 'newFolder'
  | 'changeRoot'

const { t } = useI18n()
const message = useMessage()

async function materialsGet<T>(path: string): Promise<T> {
  await ensureApiSession()
  const res = await fetch(path, { headers: getApiAuthHeaders({ contentType: false }) })
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return res.json() as Promise<T>
}

async function materialsSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  await ensureApiSession()
  const res = await fetch(path, {
    method,
    headers: getApiAuthHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status}`)
  return data as T
}

const loading = ref(false)
const summaryLoading = ref(false)
const rootPath = ref('')
const defaultRootPath = ref('')
const isDefaultRoot = ref(true)
const currentPath = ref('')
const absolutePath = ref('')
const entries = ref<MaterialEntry[]>([])
const openclawHint = ref('')

const librarySummary = ref({
  fileCount: 0,
  folderCount: 0,
  totalBytes: 0,
  totalSizeLabel: '0 B',
})
type MaterialFilter = 'all' | 'folder' | 'file' | 'image' | 'video' | 'pdf' | 'document' | 'text' | 'other'

type MaterialSortKey = 'name' | 'kind' | 'size' | 'updatedAtMs'

const viewMode = ref<'list' | 'grid'>('list')
const sortState = ref<{ columnKey: MaterialSortKey; order: 'ascend' | 'descend' }>({
  columnKey: 'name',
  order: 'ascend',
})
const searchQuery = ref('')
const typeFilter = ref<MaterialFilter>('all')
const showFilterPanel = ref(false)
const isDragOver = ref(false)
const uploadLoading = ref(false)
let dragDepth = 0

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

const effectiveRootPath = computed(() => rootPath.value || defaultRootPath.value)

const pathParts = computed(() =>
  currentPath.value ? currentPath.value.split('/').filter(Boolean) : [],
)

const rootFolderLabel = computed(() => {
  const root = effectiveRootPath.value.replace(/\\/g, '/')
  if (!root) return t('pages.materials.libraryRoot')
  const parts = root.split('/').filter(Boolean)
  return parts[parts.length - 1] || t('pages.materials.libraryRoot')
})

const isAtRoot = computed(() => pathParts.value.length === 0)

const openclawPathParent = computed(() => {
  const root = displayRootPath.value
  const label = rootFolderLabel.value
  if (!root || !label) return ''
  if (root.endsWith(label)) return root.slice(0, root.length - label.length)
  return root
})

const filesystemPath = computed(() => {
  if (absolutePath.value) return absolutePath.value
  if (!effectiveRootPath.value) return ''
  return currentPath.value
    ? `${effectiveRootPath.value}/${currentPath.value}`
    : effectiveRootPath.value
})

const displayRootPath = computed(() => effectiveRootPath.value.replace(/\//g, '\\'))

const displayCurrentRelPath = computed(() => currentPath.value.replace(/\//g, '\\'))

const filesystemPathLine = computed(() => {
  if (!effectiveRootPath.value) return ''
  return displayCurrentRelPath.value
    ? `${displayRootPath.value}:   ${displayCurrentRelPath.value}`
    : `${displayRootPath.value}:`
})

const directories = computed(() => entries.value.filter((e) => e.type === 'directory'))
const filesOnly = computed(() => entries.value.filter((e) => e.type === 'file'))

const sortedEntries = computed(() => [...directories.value, ...filesOnly.value])

const filterOptions = computed(() => [
  { label: t('pages.materials.filterAll'), value: 'all' },
  { label: t('pages.materials.filterFolders'), value: 'folder' },
  { label: t('pages.materials.filterFiles'), value: 'file' },
  { label: t('pages.materials.filterImages'), value: 'image' },
  { label: t('pages.materials.filterVideos'), value: 'video' },
  { label: t('pages.materials.filterPdfs'), value: 'pdf' },
  { label: t('pages.materials.filterDocuments'), value: 'document' },
  { label: t('pages.materials.filterText'), value: 'text' },
  { label: t('pages.materials.filterOther'), value: 'other' },
])

const filteredEntries = computed(() => {
  let rows = sortedEntries.value
  const q = searchQuery.value.trim().toLowerCase()
  if (q) {
    rows = rows.filter((entry) => entry.name.toLowerCase().includes(q))
  }

  switch (typeFilter.value) {
    case 'folder':
      return rows.filter((entry) => entry.type === 'directory')
    case 'file':
      return rows.filter((entry) => entry.type === 'file')
    case 'image':
      return rows.filter((entry) => entry.kind === 'Image')
    case 'video':
      return rows.filter((entry) => entry.kind === 'Video')
    case 'pdf':
      return rows.filter((entry) => entry.kind === 'PDF')
    case 'document':
      return rows.filter((entry) => entry.kind === 'Document')
    case 'text':
      return rows.filter((entry) => entry.kind === 'Text')
    case 'other':
      return rows.filter((entry) =>
        entry.type === 'file'
        && !['Image', 'Video', 'PDF', 'Document', 'Text'].includes(entry.kind || ''),
      )
    default:
      return rows
  }
})

const filteredDirectories = computed(() => filteredEntries.value.filter((e) => e.type === 'directory'))
const filteredFiles = computed(() => filteredEntries.value.filter((e) => e.type === 'file'))

function sortOrderFor(key: MaterialSortKey): 'ascend' | 'descend' | false {
  if (sortState.value.columnKey !== key) return false
  return sortState.value.order
}

function compareEntries(
  a: MaterialEntry,
  b: MaterialEntry,
  key: MaterialSortKey,
  order: 'ascend' | 'descend',
) {
  const dir = order === 'ascend' ? 1 : -1
  let cmp = 0

  switch (key) {
    case 'name':
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      break
    case 'kind': {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      const ak = a.kind || (a.type === 'directory' ? t('pages.materials.folderType') : '')
      const bk = b.kind || (b.type === 'directory' ? t('pages.materials.folderType') : '')
      cmp = ak.localeCompare(bk, undefined, { sensitivity: 'base' })
      break
    }
    case 'size':
      cmp = (a.size ?? 0) - (b.size ?? 0)
      if (cmp === 0 && a.type !== b.type) return a.type === 'directory' ? -1 : 1
      break
    case 'updatedAtMs':
      cmp = (a.updatedAtMs ?? 0) - (b.updatedAtMs ?? 0)
      break
  }

  if (cmp === 0) {
    cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  }
  return cmp * dir
}

const tableDisplayEntries = computed(() => {
  const rows = [...filteredEntries.value]
  const { columnKey, order } = sortState.value
  rows.sort((a, b) => compareEntries(a, b, columnKey, order))
  return rows
})

const hasActiveFilters = computed(() =>
  !!searchQuery.value.trim() || typeFilter.value !== 'all',
)

const hasTypeFilter = computed(() => typeFilter.value !== 'all')

const canPaste = computed(() => !!clipboard.value)

function fmt(ts?: number) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function absPath(entry: MaterialEntry | string) {
  const rel = typeof entry === 'string' ? entry : entry.path
  return `${effectiveRootPath.value}/${rel}`.replace(/\\/g, '/')
}

function mediaUrl(path: string) {
  return `/api/materials/get?path=${encodeURIComponent(path)}&binary=true`
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

function openNewFolderModal() {
  showCreateModal.value = true
}

function navigateToPath(index: number) {
  navigateTo(pathParts.value.slice(0, index + 1).join('/'))
}

function clearFilters() {
  searchQuery.value = ''
  typeFilter.value = 'all'
}

function buildRowActionOptions(row: MaterialEntry) {
  return [
    { label: t('pages.materials.open'), key: 'open' },
    { label: t('pages.materials.properties'), key: 'properties' },
    { label: t('pages.materials.copyPath'), key: 'copyPath' },
    { type: 'divider', key: 'd1' },
    {
      label: t('common.delete'),
      key: 'delete',
      props: { style: 'color: var(--error-color, #d03050)' },
    },
  ]
}

function runRowAction(entry: MaterialEntry, key: string) {
  switch (key) {
    case 'open':
      if (entry.type === 'directory') navigateTo(entry.path)
      else openPreview(entry)
      break
    case 'properties':
      void openDetail(entry)
      break
    case 'copyPath':
      void copyText(absPath(entry))
      break
    case 'delete':
      if (window.confirm(
        entry.type === 'directory'
          ? t('pages.materials.confirmDeleteFolder', { name: entry.name })
          : t('pages.materials.confirmDeleteFile', { name: entry.name }),
      )) {
        void deleteEntry(entry)
      }
      break
  }
}

function onDragEnter(e: DragEvent) {
  e.preventDefault()
  dragDepth += 1
  isDragOver.value = true
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  dragDepth -= 1
  if (dragDepth <= 0) {
    dragDepth = 0
    isDragOver.value = false
  }
}

async function onDrop(e: DragEvent) {
  e.preventDefault()
  dragDepth = 0
  isDragOver.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  await uploadDroppedFiles(files)
}

async function uploadFile(file: File) {
  await ensureApiSession()
  const form = new FormData()
  form.append('file', file)
  form.append('path', currentPath.value)
  const res = await fetch('/api/materials/upload', {
    method: 'POST',
    headers: getApiAuthHeaders({ contentType: false }),
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Upload failed')
  return data
}

async function uploadDroppedFiles(files: File[]) {
  if (!effectiveRootPath.value) {
    message.error(t('pages.materials.rootMissing'))
    return
  }
  uploadLoading.value = true
  let ok = 0
  try {
    for (const file of files) {
      if (!file.name) continue
      await uploadFile(file)
      ok += 1
    }
    if (ok > 0) {
      message.success(t('pages.materials.uploadSuccess', { count: ok }))
      await refresh()
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.uploadFailed'))
  } finally {
    uploadLoading.value = false
  }
}

function handleSorterChange(sorter: DataTableSortState | DataTableSortState[] | null) {
  const s = Array.isArray(sorter) ? sorter[0] ?? null : sorter
  if (!s || s.order === false) {
    sortState.value = { columnKey: 'name', order: 'ascend' }
    return
  }
  sortState.value = {
    columnKey: s.columnKey as MaterialSortKey,
    order: s.order === 'ascend' ? 'ascend' : 'descend',
  }
}

const tableColumns = computed<DataTableColumns<MaterialEntry>>(() => [
  {
    title: t('pages.materials.colName'),
    key: 'name',
    sorter: true,
    sortOrder: sortOrderFor('name'),
    render(row) {
      const icon = row.type === 'directory' ? FolderOutline : entryFileIcon(row)
      const color = row.type === 'directory' ? '#f0a020' : undefined
      return h(NSpace, { align: 'center', size: 8 }, {
        default: () => [
          h(NIcon, { component: icon, color, size: 18 }),
          h('span', {
            style: 'font-weight: 500;',
          }, row.name),
        ],
      })
    },
  },
  {
    title: t('pages.materials.colType'),
    key: 'kind',
    width: 110,
    sorter: true,
    sortOrder: sortOrderFor('kind'),
    render(row) {
      const label = row.kind || (row.type === 'directory' ? t('pages.materials.folderType') : '—')
      return h(
        NTag,
        { size: 'small', bordered: false, round: true, type: row.type === 'directory' ? 'warning' : 'default' },
        { default: () => label },
      )
    },
  },
  {
    title: t('pages.materials.colSize'),
    key: 'size',
    width: 100,
    sorter: true,
    sortOrder: sortOrderFor('size'),
    render(row) {
      if (row.type === 'directory') return '—'
      return row.sizeLabel || '—'
    },
  },
  {
    title: t('pages.materials.colModified'),
    key: 'updatedAtMs',
    width: 160,
    sorter: true,
    sortOrder: sortOrderFor('updatedAtMs'),
    render(row) {
      return row.updatedAtMs ? formatRelativeTime(row.updatedAtMs) : '—'
    },
  },
  {
    title: t('pages.files.columns.actions'),
    key: 'actions',
    width: 110,
    render(row) {
      return h(NDropdown, {
        trigger: 'click',
        options: buildRowActionOptions(row),
        onSelect: (key: string) => runRowAction(row, key),
      }, {
        default: () => h(NButton, { size: 'small', quaternary: true }, {
          default: () => t('pages.materials.actions'),
        }),
      })
    },
  },
])

function entryFileIcon(entry: MaterialEntry) {
  switch (entry.kind) {
    case 'Image': return ImageOutline
    case 'Video': return VideocamOutline
    case 'PDF': return DocumentTextOutline
    default: return DocumentOutline
  }
}

async function loadWorkspace() {
  try {
    const r = await materialsGet<MaterialsWorkspaceResponse>('/api/materials')
    rootPath.value = r.rootPath || ''
    defaultRootPath.value = r.defaultRoot || ''
    isDefaultRoot.value = r.isDefaultRoot ?? true
    openclawHint.value = r.openclawHint || ''
  } catch {
    /* list/summary may still provide rootPath */
  }
}

async function loadSummary() {
  summaryLoading.value = true
  try {
    const r = await materialsGet<MaterialsSummaryResponse>('/api/materials/summary')
    if (!r.ok) throw new Error(r.error || 'Could not load library summary')
    if (r.rootPath) rootPath.value = r.rootPath
    librarySummary.value = {
      fileCount: r.fileCount ?? 0,
      folderCount: r.folderCount ?? 0,
      totalBytes: r.totalBytes ?? 0,
      totalSizeLabel: r.totalSizeLabel || '0 B',
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.summaryFailed'))
  } finally {
    summaryLoading.value = false
  }
}

async function refresh() {
  loading.value = true
  try {
    const q = currentPath.value ? `?path=${encodeURIComponent(currentPath.value)}` : ''
    const r = await materialsGet<MaterialsListResponse>(`/api/materials/list${q}`)
    if (!r.ok) throw new Error(r.error || 'Could not list folder')
    rootPath.value = r.rootPath || rootPath.value
    currentPath.value = r.path || ''
    absolutePath.value = r.absolutePath || ''
    entries.value = r.entries || []
    await loadSummary()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function navigateTo(path: string) {
  currentPath.value = path
  await refresh()
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('common.copied'))
  } catch {
    message.error(t('common.copyFailed'))
  }
}

async function copyFilesystemPath() {
  if (!filesystemPath.value) return
  try {
    await navigator.clipboard.writeText(filesystemPath.value.replace(/\//g, '\\'))
    message.success(t('pages.materials.pathCopied'))
  } catch {
    message.error(t('common.copyFailed'))
  }
}

async function createFolder() {
  const name = newFolderName.value.trim()
  if (!name) return
  createLoading.value = true
  try {
    await materialsSend('POST', '/api/materials/mkdir', { path: currentPath.value, name })
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
    await materialsSend('POST', '/api/materials/delete', { path: entry.path })
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
    const r = await materialsSend<MaterialsWorkspaceResponse>('POST', '/api/materials/root', {
      rootPath: rootInput.value.trim(),
    })
    rootPath.value = r.rootPath || ''
    defaultRootPath.value = r.defaultRoot || defaultRootPath.value
    isDefaultRoot.value = r.isDefaultRoot ?? false
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

async function resetToDefaultRoot() {
  rootLoading.value = true
  try {
    const r = await materialsSend<MaterialsWorkspaceResponse>('POST', '/api/materials/root', {
      useDefault: true,
    })
    rootPath.value = r.rootPath || ''
    defaultRootPath.value = r.defaultRoot || rootPath.value
    isDefaultRoot.value = true
    openclawHint.value = r.openclawHint || ''
    showRootModal.value = false
    currentPath.value = ''
    message.success(t('pages.materials.defaultRootRestored'))
    await refresh()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.materials.rootUpdateFailed'))
  } finally {
    rootLoading.value = false
  }
}

function openRootModal() {
  rootInput.value = effectiveRootPath.value
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

function handleEntryDoubleClick(entry: MaterialEntry) {
  if (entry.type === 'directory') {
    navigateTo(entry.path)
    return
  }
  if (isVideo(entry) || isImage(entry) || isPdf(entry)) {
    openPreview(entry)
    return
  }
  void openDetail(entry)
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
      const r = await materialsGet<{ file?: { content?: string; binary?: boolean } }>(
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
    const r = await materialsGet<{ entry?: MaterialDetail }>(
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
    await materialsSend('POST', '/api/materials/move', {
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
    await materialsSend('POST', '/api/materials/duplicate', { path: entry.path })
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
    await materialsSend('POST', '/api/materials/paste', {
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
  if (!entry) {
    if (action === 'newFolder') {
      openNewFolderModal()
      return
    }
    if (action === 'changeRoot') {
      openRootModal()
      return
    }
    return
  }

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
  await loadSummary()
  await refresh()
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
})
</script>

<template>
  <NSpace vertical :size="16" @contextmenu.prevent="openContextMenu($event, null)">
    <NSpin :show="summaryLoading">
      <NGrid cols="1 s:2" responsive="screen" :x-gap="16" :y-gap="16">
        <NGridItem>
          <StatCard
            :title="t('pages.materials.totalFiles')"
            :value="librarySummary.fileCount"
            :icon="DocumentOutline"
            color="#2080f0"
          />
        </NGridItem>
        <NGridItem>
          <StatCard
            :title="t('pages.materials.totalUsage')"
            :value="librarySummary.totalSizeLabel"
            :icon="SaveOutline"
            color="#18a058"
          />
        </NGridItem>
      </NGrid>
    </NSpin>

    <NCard class="app-card materials-card">
      <template #header>
        <div class="materials-card-header">
          <div class="materials-toolbar-row">
            <div class="materials-search-row">
              <NInput
                v-model:value="searchQuery"
                size="small"
                clearable
                :placeholder="t('pages.materials.searchPlaceholder')"
                class="materials-search"
              >
                <template #prefix>
                  <NIcon :component="SearchOutline" />
                </template>
              </NInput>
              <NButton
                size="small"
                :type="showFilterPanel || hasTypeFilter ? 'primary' : 'default'"
                :quaternary="!showFilterPanel && !hasTypeFilter"
                class="materials-filter-toggle"
                @click="showFilterPanel = !showFilterPanel"
              >
                <template #icon>
                  <NIcon :component="FunnelOutline" />
                </template>
                {{ t('pages.materials.filter') }}
              </NButton>
            </div>

            <div v-if="!effectiveRootPath" class="materials-path-missing">
              <span>{{ t('pages.materials.pathUnavailable') }}</span>
              <NButton size="tiny" quaternary type="primary" @click="openRootModal">
                {{ t('pages.materials.setRoot') }}
              </NButton>
            </div>

            <div v-show="showFilterPanel" class="materials-filter-panel">
              <span class="materials-filter-label">{{ t('pages.materials.filterType') }}</span>
              <NSelect
                v-model:value="typeFilter"
                size="small"
                :options="filterOptions"
                class="materials-filter-select"
              />
              <NButton
                v-if="hasTypeFilter"
                size="tiny"
                quaternary
                @click="typeFilter = 'all'"
              >
                {{ t('pages.materials.clearFilters') }}
              </NButton>
            </div>
          </div>
        </div>
      </template>

      <div v-if="effectiveRootPath" class="materials-openclaw-hint">
        <NTag size="small" type="success" :bordered="false" round>OpenClaw</NTag>
        <span>
          {{ t('pages.materials.openclawHintPrefix') }}
          <span class="materials-openclaw-path">
            {{ openclawPathParent }}<span
              v-if="isAtRoot"
              class="materials-path-link materials-path-link--current"
            >{{ rootFolderLabel }}</span><button
              v-else
              type="button"
              class="materials-path-link"
              @click="navigateTo('')"
            >{{ rootFolderLabel }}</button><template
              v-for="(part, index) in pathParts"
              :key="`${part}-${index}`"
            ><span class="materials-path-slash">\</span><span
              v-if="index === pathParts.length - 1"
              class="materials-path-link materials-path-link--current"
            >{{ part }}</span><button
              v-else
              type="button"
              class="materials-path-link"
              @click="navigateToPath(index)"
            >{{ part }}</button></template>
          </span>.
        </span>
      </div>

      <div class="files-stats-row">
        <div class="files-stats">
          <NTag size="small" :bordered="false">
            {{ filteredDirectories.length }} {{ t('pages.materials.folderType') }}
          </NTag>
          <NTag size="small" :bordered="false" type="info">
            {{ filteredFiles.length }} {{ t('pages.materials.fileType') }}
          </NTag>
          <NTag v-if="hasActiveFilters" size="small" :bordered="false" type="warning">
            {{ t('pages.materials.filteredCount', { count: filteredEntries.length, total: sortedEntries.length }) }}
          </NTag>
          <NButton v-if="hasActiveFilters" size="tiny" quaternary @click="clearFilters">
            {{ t('pages.materials.clearFilters') }}
          </NButton>
        </div>

        <NSpace :size="8">
          <NButton
            size="small"
            :type="viewMode === 'list' ? 'primary' : 'default'"
            secondary
            @click="viewMode = 'list'"
          >
            <template #icon><NIcon :component="ListOutline" /></template>
            {{ t('pages.materials.listView') }}
          </NButton>
          <NButton
            size="small"
            :type="viewMode === 'grid' ? 'primary' : 'default'"
            secondary
            @click="viewMode = 'grid'"
          >
            <template #icon><NIcon :component="GridOutline" /></template>
            {{ t('pages.materials.gridView') }}
          </NButton>
          <NButton
            size="small"
            type="primary"
            :disabled="!effectiveRootPath"
            @click="openNewFolderModal"
          >
            <template #icon><NIcon :component="AddOutline" /></template>
            {{ t('pages.materials.newFolder') }}
          </NButton>
        </NSpace>
      </div>

      <div
        class="materials-drop-zone"
        :class="{ 'materials-drop-zone--active': isDragOver }"
        @dragenter.prevent="onDragEnter"
        @dragover.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
      >
        <div v-if="isDragOver" class="materials-drop-overlay">
          <NIcon :component="AddOutline" :size="28" />
          <span>{{ t('pages.materials.dropHint') }}</span>
        </div>
        <NSpin :show="loading || uploadLoading">
        <NDataTable
          v-if="viewMode === 'list' && filteredEntries.length > 0"
          :columns="tableColumns"
          :data="tableDisplayEntries"
          :bordered="false"
          :single-line="false"
          size="small"
          :max-height="520"
          virtual-scroll
          :row-key="(row: MaterialEntry) => row.path"
          :row-props="(row: MaterialEntry) => ({
            style: 'cursor: default;',
            onDblclick: (e: MouseEvent) => {
              e.preventDefault()
              handleEntryDoubleClick(row)
            },
            onContextmenu: (e: MouseEvent) => openContextMenu(e, row),
          })"
          @update:sorter="handleSorterChange"
        />
        <div v-else-if="viewMode === 'grid' && filteredEntries.length > 0" class="materials-grid">
          <div
            v-for="entry in filteredEntries"
            :key="entry.path"
            class="materials-grid-card"
            @dblclick="handleEntryDoubleClick(entry)"
            @contextmenu.stop.prevent="openContextMenu($event, entry)"
          >
            <div class="materials-grid-thumb">
              <img
                v-if="isImage(entry)"
                :src="mediaUrl(entry.path)"
                :alt="entry.name"
                loading="lazy"
              >
              <NIcon v-else :component="entry.type === 'directory' ? FolderOutline : entryFileIcon(entry)" :size="36" />
            </div>
            <div class="materials-grid-name" :title="entry.name">{{ entry.name }}</div>
            <div class="materials-grid-meta">
              <NTag size="tiny" :bordered="false" round>{{ entry.kind || '—' }}</NTag>
              <span>{{ entry.sizeLabel || '—' }}</span>
            </div>
          </div>
        </div>
        <NEmpty v-else-if="!effectiveRootPath" :description="t('pages.materials.rootMissing')" style="padding: 48px 0;">
          <template #extra>
            <NButton type="primary" @click="openRootModal">{{ t('pages.materials.setRoot') }}</NButton>
          </template>
        </NEmpty>
        <NEmpty
          v-else-if="hasActiveFilters && filteredEntries.length === 0"
          :description="t('pages.materials.noSearchResults')"
          style="padding: 48px 0;"
        />
        <NEmpty v-else :description="t('pages.materials.empty')" style="padding: 48px 0;">
          <template v-if="filesystemPathLine" #extra>
            <code class="materials-empty-path">{{ filesystemPathLine }}</code>
          </template>
        </NEmpty>
        </NSpin>
      </div>
    </NCard>

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
      <template v-else>
        <button type="button" @click="runContextAction('newFolder')">{{ t('pages.materials.newFolder') }}</button>
        <button type="button" @click="runContextAction('changeRoot')">{{ t('pages.materials.changeRoot') }}</button>
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
      <p v-if="defaultRootPath" class="hint materials-default-root-hint">
        {{ t('pages.materials.defaultFolderHint', { path: defaultRootPath.replace(/\//g, '\\') }) }}
      </p>
      <NInput v-model:value="rootInput" :placeholder="t('pages.materials.rootPlaceholder')" />
      <template #footer>
        <button type="button" class="btn ghost" @click="showRootModal = false">{{ t('common.cancel') }}</button>
        <button type="button" class="btn ghost" :disabled="rootLoading || isDefaultRoot" @click="resetToDefaultRoot">
          {{ t('pages.materials.useDefaultFolder') }}
        </button>
        <button type="button" class="btn" :disabled="rootLoading" @click="saveRoot">{{ t('common.save') }}</button>
      </template>
    </NModal>
  </NSpace>
</template>

<style scoped>
:deep(.materials-card .n-card-header) {
  padding-bottom: 12px;
}

.materials-card-header {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.materials-toolbar-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.materials-search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.materials-search {
  flex: 1;
  min-width: 0;
}

.materials-filter-toggle {
  flex-shrink: 0;
}

.materials-path-missing {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.materials-empty-path {
  display: block;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg-secondary);
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-all;
}

.materials-default-root-hint {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  word-break: break-all;
}

.materials-filter-panel {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-secondary);
}

.materials-filter-label {
  font-size: 13px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.materials-filter-select {
  width: min(220px, 100%);
}

.files-stats-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.materials-drop-zone {
  position: relative;
  min-height: 280px;
  border-radius: var(--radius, 8px);
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}

.materials-drop-zone--active {
  background: rgba(24, 160, 88, 0.06);
  box-shadow: inset 0 0 0 2px rgba(24, 160, 88, 0.45);
}

.materials-drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--primary-color, #18a058);
  font-size: 14px;
  font-weight: 500;
  pointer-events: none;
  background: rgba(24, 160, 88, 0.08);
  border-radius: inherit;
}

.materials-openclaw-hint {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

.materials-openclaw-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  word-break: break-all;
}

.materials-path-link {
  border: 0;
  padding: 0;
  margin: 0;
  background: transparent;
  color: var(--primary-color, #18a058);
  font: inherit;
  font-family: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.materials-path-link:hover {
  opacity: 0.85;
}

.materials-path-link--current {
  font-weight: 600;
  color: var(--text-primary);
  text-decoration: none;
  cursor: default;
}

.materials-path-slash {
  color: var(--text-secondary);
}

.files-path-header {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color);
}

.files-path-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
}

.files-path-trail {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
  flex: 1;
}

.files-path-root,
.files-path-segment {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font-size: 20px;
  line-height: 1.3;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 999px;
  cursor: pointer;
  max-width: 100%;
  transition: background-color 0.15s ease;
}

.files-path-root {
  background: var(--bg-secondary);
}

.files-path-root:hover,
.files-path-segment:hover {
  background: rgba(128, 128, 128, 0.12);
}

.files-path-segment--current {
  font-weight: 600;
}

.files-path-segment span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
}

.files-path-sep {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.files-path-current-caret {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.files-path-location {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  max-width: 100%;
}

.files-path-location span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.files-path-location:hover {
  color: var(--text-primary);
}

.files-path-tooltip {
  max-width: 420px;
}

.files-path-tooltip-path {
  margin-top: 4px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
  word-break: break-all;
}

.files-path-tooltip-hint {
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.8;
}

.files-stats {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.materials-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}

.materials-grid-card {
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  padding: 10px;
  cursor: pointer;
  background: var(--bg-card);
  transition: border-color 0.15s ease;
}

.materials-grid-card:hover {
  border-color: var(--primary-color);
}

.materials-grid-thumb {
  aspect-ratio: 1;
  border-radius: 8px;
  background: var(--bg-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  margin-bottom: 8px;
}

.materials-grid-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.materials-grid-name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.materials-grid-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-secondary);
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
