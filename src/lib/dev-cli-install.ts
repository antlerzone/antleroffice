/** Poll dev CLI install after developer hire or Settings install. */

export type DevCliInstallStart = {
  ok?: boolean
  queued?: boolean
  skipped?: boolean
  alreadyInstalled?: boolean
  error?: string
} | null

export type DevCliInstallBundle = {
  cursor?: DevCliInstallStart
  codex?: DevCliInstallStart
  claude?: DevCliInstallStart
} | null

const DEV_TEMPLATE_IDS = new Set([
  'cursor_developer',
  'claude_developer',
  'codex_developer',
  'it_guys',
])

const INSTALL_LABELS: Record<string, string> = {
  cursor: 'Cursor CLI',
  codex: 'Codex CLI',
  claude: 'Claude CLI',
}

export async function pollDevCliInstallLog(
  maxPolls = 120,
  intervalMs = 2000,
  onProgress?: (installing: string | null, lines: string[]) => void,
): Promise<string[]> {
  const lines: string[] = []
  let idlePolls = 0
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, intervalMs))
    try {
      const res = await fetch('/api/onboard/log')
      const data = await res.json()
      const installing = (data.installing as string | null) || null
      lines.splice(0, lines.length, ...((data.lines as string[]) || []).slice(-10))
      onProgress?.(installing, [...lines])
      if (!installing) {
        idlePolls++
        if (idlePolls >= 2) break
      } else {
        idlePolls = 0
      }
    } catch {
      break
    }
  }
  return lines
}

type DevToolsStatus = {
  cursor?: { installed?: boolean }
  codex?: { installed?: boolean }
  claude?: { installed?: boolean }
} | null

async function fetchDevToolsStatus(): Promise<DevToolsStatus> {
  try {
    const res = await fetch('/api/dev/tools/status')
    const data = await res.json()
    return res.ok && data.ok ? data : null
  } catch {
    return null
  }
}

export async function fetchCursorInstalled(): Promise<boolean> {
  const data = await fetchDevToolsStatus()
  return !!data?.cursor?.installed
}

export async function fetchCodexInstalled(): Promise<boolean> {
  const data = await fetchDevToolsStatus()
  return !!data?.codex?.installed
}

export async function fetchClaudeInstalled(): Promise<boolean> {
  const data = await fetchDevToolsStatus()
  return !!data?.claude?.installed
}

export function isDevTemplate(template: { id?: string; role?: string; devEngine?: string } | null | undefined): boolean {
  if (!template) return false
  if (template.devEngine) return true
  if (template.id && DEV_TEMPLATE_IDS.has(template.id)) return true
  return template.role === 'it'
}

/** @deprecated Use isDevTemplate */
export function isItTemplate(template: { id?: string; role?: string; devEngine?: string } | null | undefined): boolean {
  return isDevTemplate(template)
}

function needsInstall(start: DevCliInstallStart | undefined): boolean {
  return !!(start?.ok && !start.skipped && !start.alreadyInstalled)
}

export function devCliInstallLabel(installing: string | null): string {
  if (!installing) return '开发工具'
  return INSTALL_LABELS[installing] || installing
}

export async function waitForDevClisAfterHire(
  bundle: DevCliInstallBundle,
  onProgress?: (label: string, lines: string[]) => void,
): Promise<{ cursor: boolean; codex: boolean; claude: boolean; lines: string[]; anyInstall: boolean }> {
  const cursorStart = bundle?.cursor
  const codexStart = bundle?.codex
  const claudeStart = bundle?.claude
  const anyInstall =
    needsInstall(cursorStart) || needsInstall(codexStart) || needsInstall(claudeStart)

  if (!anyInstall) {
    const [cursor, codex, claude] = await Promise.all([
      fetchCursorInstalled(),
      fetchCodexInstalled(),
      fetchClaudeInstalled(),
    ])
    return { cursor, codex, claude, lines: [], anyInstall: false }
  }

  const lines = await pollDevCliInstallLog(120, 2000, (installing, logLines) => {
    const label = devCliInstallLabel(installing)
    onProgress?.(label, logLines)
  })

  await new Promise((r) => setTimeout(r, 2000))
  let cursor = await fetchCursorInstalled()
  let codex = await fetchCodexInstalled()
  let claude = await fetchClaudeInstalled()
  if (!cursor || !codex || !claude) {
    await new Promise((r) => setTimeout(r, 3000))
    cursor = await fetchCursorInstalled()
    codex = await fetchCodexInstalled()
    claude = await fetchClaudeInstalled()
  }
  return { cursor, codex, claude, lines, anyInstall: true }
}

/** @deprecated Use DevCliInstallStart */
export type CodexInstallStart = DevCliInstallStart

/** @deprecated Use waitForDevClisAfterHire */
export async function waitForCodexAfterHire(
  codexInstall: DevCliInstallStart,
  onLog?: (lines: string[]) => void,
): Promise<{ installed: boolean; lines: string[]; skipped: boolean }> {
  const { codex, lines, anyInstall } = await waitForDevClisAfterHire(
    { codex: codexInstall },
    (_label, logLines) => onLog?.(logLines),
  )
  return { installed: codex, lines, skipped: !anyInstall && codex }
}

/** @deprecated Use pollDevCliInstallLog */
export const pollCodexInstallLog = pollDevCliInstallLog
