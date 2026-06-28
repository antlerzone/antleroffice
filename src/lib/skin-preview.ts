// Canvas previews for skins / hire cards — animated like the pixel office (from AntlerOffice v1).

const FRAME_W = 16
const FRAME_H = 32
const TILE = 16
const WALK_FRAMES = [0, 1, 2, 1]
const DIR_ROW: Record<string, number> = { down: 0, side: 2 }
const ASSET_BASE = '/office-pa/assets/characters'

const WALK_FRAME_MS = 120
const POSE_MIN_MS = 3200
const POSE_MAX_MS = 5200

export const SKIN_CANVAS_SIZE = 128
export const AGENT_SKIN_CANVAS = 72
export const DETAIL_AGENT_CANVAS = 420
export const RESUME_THUMB_CANVAS = 72

type PreviewEntry = {
  canvas: HTMLCanvasElement
  palette: number
  hueShift: number
  direction: string
  flip: boolean
  mode: string
  frame: number
  walkIdx: number
  frameTimer: number
  actionFrame: number
  actionTimer: number
  poseTimer: number
  poseInterval: number
  // Optional custom sprite-sheet image (paid/custom skins). When loaded, it is
  // used instead of the palette-indexed builtin char_N.png. Same 16×32 frame
  // layout (7 walk/action cols × 3 direction rows).
  customImage?: HTMLImageElement | null
}

// Cache custom sprite-sheet images by URL so each skin loads once.
const customImageCache = new Map<string, HTMLImageElement>()

let charImages: HTMLImageElement[] | null = null
let charImageCount = 6
let rafId: number | null = null
let lastTs = 0
const previews = new Set<PreviewEntry>()

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error(`Failed to load ${src}`))
    im.src = src
  })
}

export function resetCharacterImages() {
  charImages = null
  charImageCount = 6
}

export async function loadCharacterImages(count = 6): Promise<HTMLImageElement[]> {
  const need = Math.max(6, count)
  if (charImages && charImageCount >= need) return charImages

  const imgs: HTMLImageElement[] = []
  for (let i = 0; i < need; i++) {
    try {
      imgs.push(await loadImg(`${ASSET_BASE}/char_${i}.png`))
    } catch {
      imgs.push(imgs[0] || (await loadImg(`${ASSET_BASE}/char_0.png`)))
    }
  }
  charImages = imgs
  charImageCount = need
  return charImages
}

function layoutSprite(canvas: HTMLCanvasElement) {
  const isDetail = canvas.width >= 360
  const scaleCap = isDetail ? 20 : canvas.width >= 240 ? 9 : canvas.width >= 120 ? 5 : 4
  const sidePad = isDetail ? 16 : 8
  const topPad = isDetail ? 10 : 6
  const bottomPad = isDetail ? 22 : 6

  const scale = Math.min(
    (canvas.width - sidePad * 2) / FRAME_W,
    (canvas.height - topPad - bottomPad) / FRAME_H,
    scaleCap,
  )
  const dw = FRAME_W * scale
  const dh = FRAME_H * scale
  const dx = (canvas.width - dw) / 2
  const dy = Math.max(topPad, canvas.height - bottomPad - dh)
  return { dw, dh, dx, dy }
}

function randomPoseInterval() {
  return POSE_MIN_MS + Math.random() * (POSE_MAX_MS - POSE_MIN_MS)
}

function pickNextPose(entry: PreviewEntry) {
  const roll = Math.random()
  if (roll < 0.45) {
    entry.direction = 'down'
    entry.flip = false
    entry.mode = 'walk'
  } else if (roll < 0.85) {
    entry.direction = 'side'
    entry.flip = Math.random() < 0.5
    entry.mode = 'walk'
  } else {
    entry.direction = Math.random() < 0.55 ? 'down' : 'side'
    entry.flip = entry.direction === 'side' && Math.random() < 0.5
    entry.mode = Math.random() < 0.6 ? 'type' : 'read'
    entry.actionFrame = 0
    entry.actionTimer = 0
  }
  entry.walkIdx = 0
  entry.frame = WALK_FRAMES[0]!
  entry.frameTimer = 0
  entry.poseTimer = 0
  entry.poseInterval = randomPoseInterval()
}

function loadCustomImage(src: string): HTMLImageElement {
  let im = customImageCache.get(src)
  if (!im) {
    im = new Image()
    im.src = src
    customImageCache.set(src, im)
  }
  return im
}

function createPreviewState(canvas: HTMLCanvasElement, palette: number, hueShift = 0, customSrc?: string | null): PreviewEntry {
  return {
    canvas,
    palette,
    hueShift,
    direction: 'down',
    flip: false,
    mode: 'walk',
    frame: WALK_FRAMES[0]!,
    walkIdx: 0,
    frameTimer: 0,
    actionFrame: 0,
    actionTimer: 0,
    poseTimer: 0,
    poseInterval: randomPoseInterval(),
    customImage: customSrc ? loadCustomImage(customSrc) : null,
  }
}

export function drawSkinPreview(entry: PreviewEntry) {
  const { canvas, palette, direction, flip, hueShift = 0, mode, frame, actionFrame = 0 } = entry
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // Prefer a loaded custom sprite sheet; otherwise fall back to the builtin palette image.
  let img: HTMLImageElement | undefined
  if (entry.customImage && entry.customImage.complete && entry.customImage.naturalWidth > 0) {
    img = entry.customImage
  } else {
    const imgs = charImages
    if (!imgs?.length) return
    img = imgs[palette % imgs.length]
  }
  if (!img?.complete) return

  const row = DIR_ROW[direction] ?? 0
  let col = frame
  if (mode === 'type') col = 3 + actionFrame
  else if (mode === 'read') col = 5 + actionFrame

  const { dw, dh, dx, dy } = layoutSprite(canvas)

  ctx.save()
  if (hueShift) ctx.filter = `hue-rotate(${hueShift}deg)`

  if (flip && direction === 'side') {
    ctx.translate(dx + dw, dy)
    ctx.scale(-1, 1)
    ctx.drawImage(img, col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H, 0, 0, dw, dh)
  } else {
    ctx.drawImage(img, col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H, dx, dy, dw, dh)
  }
  ctx.restore()
}

export function registerPreview({
  canvas,
  palette,
  hueShift = 0,
  customSrc = null,
}: {
  canvas: HTMLCanvasElement
  palette: number
  hueShift?: number
  customSrc?: string | null
}) {
  const entry = createPreviewState(canvas, palette, hueShift, customSrc)
  previews.add(entry)
  drawSkinPreview(entry)
  return entry
}

function tick(ts: number) {
  if (!lastTs) lastTs = ts
  const dt = Math.min(ts - lastTs, 50)
  lastTs = ts

  for (const p of previews) {
    p.poseTimer += dt
    if (p.poseTimer >= p.poseInterval) pickNextPose(p)

    if (p.mode === 'walk') {
      p.frameTimer += dt
      if (p.frameTimer >= WALK_FRAME_MS) {
        p.frameTimer = 0
        p.walkIdx = (p.walkIdx + 1) % WALK_FRAMES.length
        p.frame = WALK_FRAMES[p.walkIdx]!
      }
    } else {
      p.actionTimer += dt
      if (p.actionTimer >= 260) {
        p.actionTimer = 0
        p.actionFrame = 1 - p.actionFrame
      }
    }
    drawSkinPreview(p)
  }

  rafId = requestAnimationFrame(tick)
}

export function unregisterPreviewsIn(root: ParentNode | null | undefined) {
  if (!root) return
  for (const p of previews) {
    if (root.contains(p.canvas)) previews.delete(p)
  }
  if (!previews.size && rafId) {
    cancelAnimationFrame(rafId)
    rafId = null
    lastTs = 0
  }
}

export function startSkinPreviews() {
  stopSkinPreviews(false)
  lastTs = 0
  rafId = requestAnimationFrame(tick)
}

export function stopSkinPreviews(clearEntries = true) {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  lastTs = 0
  if (clearEntries) previews.clear()
}
