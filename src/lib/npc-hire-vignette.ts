/** Floor opacity at viewport edge; peak at modal border (outside). */
export const NPC_HIRE_VIGNETTE_FLOOR = 0.8
export const NPC_HIRE_VIGNETTE_PEAK = 1

/**
 * Rectangle-border vignette: opacity = lerp(peak, floor, dist / maxDist).
 * Modal interior is not painted (canvas sits behind modal; modal covers center).
 */
export function drawModalBorderVignette(
  canvas: HTMLCanvasElement,
  modal: DOMRect,
  floor = NPC_HIRE_VIGNETTE_FLOOR,
  peak = NPC_HIRE_VIGNETTE_PEAK,
) {
  const extra = peak - floor
  const dpr = window.devicePixelRatio || 1
  const w = window.innerWidth
  const h = window.innerHeight

  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  ctx.fillStyle = `rgba(0,0,0,${floor})`
  ctx.fillRect(0, 0, w, h)

  const { left, top, right, bottom } = modal
  const extraColor = (a: number) => `rgba(0,0,0,${a})`

  // Top (above modal, between left/right)
  if (top > 0) {
    const g = ctx.createLinearGradient(0, top, 0, 0)
    g.addColorStop(0, extraColor(extra))
    g.addColorStop(1, extraColor(0))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, top)
  }

  // Bottom
  if (bottom < h) {
    const g = ctx.createLinearGradient(0, bottom, 0, h)
    g.addColorStop(0, extraColor(extra))
    g.addColorStop(1, extraColor(0))
    ctx.fillStyle = g
    ctx.fillRect(0, bottom, w, h - bottom)
  }

  // Left (between top/bottom of modal)
  if (left > 0 && bottom > top) {
    const g = ctx.createLinearGradient(left, 0, 0, 0)
    g.addColorStop(0, extraColor(extra))
    g.addColorStop(1, extraColor(0))
    ctx.fillStyle = g
    ctx.fillRect(0, top, left, bottom - top)
  }

  // Right
  if (right < w && bottom > top) {
    const g = ctx.createLinearGradient(right, 0, w, 0)
    g.addColorStop(0, extraColor(extra))
    g.addColorStop(1, extraColor(0))
    ctx.fillStyle = g
    ctx.fillRect(right, top, w - right, bottom - top)
  }

  // Corner quadrants — radial from modal corner (shortest distance in diagonal regions)
  if (left > 0 && top > 0) {
    const r = Math.hypot(left, top)
    const g = ctx.createRadialGradient(left, top, 0, left, top, r)
    g.addColorStop(0, extraColor(extra))
    g.addColorStop(1, extraColor(0))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, left, top)
  }

  if (right < w && top > 0) {
    const r = Math.hypot(w - right, top)
    const g = ctx.createRadialGradient(right, top, 0, right, top, r)
    g.addColorStop(0, extraColor(extra))
    g.addColorStop(1, extraColor(0))
    ctx.fillStyle = g
    ctx.fillRect(right, 0, w - right, top)
  }

  if (left > 0 && bottom < h) {
    const r = Math.hypot(left, h - bottom)
    const g = ctx.createRadialGradient(left, bottom, 0, left, bottom, r)
    g.addColorStop(0, extraColor(extra))
    g.addColorStop(1, extraColor(0))
    ctx.fillStyle = g
    ctx.fillRect(0, bottom, left, h - bottom)
  }

  if (right < w && bottom < h) {
    const r = Math.hypot(w - right, h - bottom)
    const g = ctx.createRadialGradient(right, bottom, 0, right, bottom, r)
    g.addColorStop(0, extraColor(extra))
    g.addColorStop(1, extraColor(0))
    ctx.fillStyle = g
    ctx.fillRect(right, bottom, w - right, h - bottom)
  }
}
