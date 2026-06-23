import { isLocalDevHost } from '@/lib/desktop-shell'

const TAG = '[summon]'

let pipelineAnchorMs = 0
let lastMarkMs = 0

function clockTs(): string {
  const d = new Date()
  return d.toLocaleTimeString('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
}

function elapsedSuffix(): string {
  if (!pipelineAnchorMs) return ''
  const total = Math.round(performance.now() - pipelineAnchorMs)
  return ` +${total}ms`
}

function formatPrefix(): string {
  return `${TAG} ${clockTs()}${elapsedSuffix()}`
}

/** Reset pipeline timer (wake, new utterance, test greeting). */
export function resetSummonTimer(reason?: string) {
  pipelineAnchorMs = performance.now()
  lastMarkMs = pipelineAnchorMs
  console.info(`${formatPrefix()} ⏱ timer start${reason ? `: ${reason}` : ''}`)
}

/** Mark a phase with +total and +delta since last mark. */
export function summonMark(label: string, detail?: unknown) {
  const now = performance.now()
  const delta = lastMarkMs ? Math.round(now - lastMarkMs) : 0
  const total = pipelineAnchorMs ? Math.round(now - pipelineAnchorMs) : 0
  lastMarkMs = now
  const timing = `(Δ${delta}ms, Σ${total}ms)`
  if (detail !== undefined) console.info(`${formatPrefix()} ${timing} ${label}`, detail)
  else console.info(`${formatPrefix()} ${timing} ${label}`)
}

/** Verbose SSE / mic on localhost dev, or localStorage antleroffice-summon-debug=1 */
export function isSummonVerbose(): boolean {
  try {
    if (typeof window !== 'undefined' && isLocalDevHost()) return true
  } catch {
    /* ignore */
  }
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('antleroffice-summon-debug') === '1') {
      return true
    }
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('summonDebug')) {
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

export function summonInfo(...args: unknown[]) {
  console.info(formatPrefix(), ...args)
}

export function summonLog(...args: unknown[]) {
  console.log(formatPrefix(), ...args)
}

export function summonWarn(...args: unknown[]) {
  console.warn(formatPrefix(), ...args)
}

export function summonError(...args: unknown[]) {
  console.error(formatPrefix(), ...args)
}

export function summonVerbose(...args: unknown[]) {
  if (isSummonVerbose()) summonLog(...args)
}

/** Always logs on localhost — mic level / speech gate (filter console: [summon]) */
export function summonMic(...args: unknown[]) {
  try {
    if (typeof window !== 'undefined' && isLocalDevHost()) {
      console.info(formatPrefix(), '🎤', ...args)
    }
  } catch {
    /* ignore */
  }
}

/** One-line green banner so DevTools filter `[summon]` is easy to spot. */
export function summonBanner(message: string, detail?: Record<string, unknown>) {
  console.info(`%c${formatPrefix()} ${message}`, 'color:#22c55e;font-weight:bold', detail ?? '')
}
