export interface NpcHireLayout {
  agentLeft: number
  agentBottom: number
  agentOffsetX: number
  agentOffsetY: number
  agentMaxW: number
  agentMaxH: number
  statsOffsetX: number
  statsOffsetY: number
  scenePosX: number
  scenePosY: number
  sceneSizeH: number
}

/** @deprecated use statsOffsetY — kept for older saved JSON */
type NpcHireLayoutLegacy = Partial<NpcHireLayout> & { statsMarginTop?: number }

export const NPC_HIRE_LAYOUT_STORAGE_KEY = 'npc-hire-layout-v1'

export const NPC_HIRE_LAYOUT_DEFAULT: NpcHireLayout = {
  agentLeft: 50,
  agentBottom: 38,
  agentOffsetX: 0,
  agentOffsetY: -35,
  agentMaxW: 180,
  agentMaxH: 220,
  statsOffsetX: 0,
  statsOffsetY: 200,
  scenePosX: 48,
  scenePosY: 52,
  sceneSizeH: 118,
}

export function normalizeNpcHireLayout(raw: NpcHireLayoutLegacy | null | undefined): NpcHireLayout {
  const statsY =
    typeof raw?.statsOffsetY === 'number'
      ? raw.statsOffsetY
      : typeof raw?.statsMarginTop === 'number'
        ? raw.statsMarginTop
        : NPC_HIRE_LAYOUT_DEFAULT.statsOffsetY

  return {
    agentLeft: num(raw?.agentLeft, NPC_HIRE_LAYOUT_DEFAULT.agentLeft),
    agentBottom: num(raw?.agentBottom, NPC_HIRE_LAYOUT_DEFAULT.agentBottom),
    agentOffsetX: num(raw?.agentOffsetX, NPC_HIRE_LAYOUT_DEFAULT.agentOffsetX),
    agentOffsetY: num(raw?.agentOffsetY, NPC_HIRE_LAYOUT_DEFAULT.agentOffsetY),
    agentMaxW: num(raw?.agentMaxW, NPC_HIRE_LAYOUT_DEFAULT.agentMaxW),
    agentMaxH: num(raw?.agentMaxH, NPC_HIRE_LAYOUT_DEFAULT.agentMaxH),
    statsOffsetX: num(raw?.statsOffsetX, NPC_HIRE_LAYOUT_DEFAULT.statsOffsetX),
    statsOffsetY: statsY,
    scenePosX: num(raw?.scenePosX, NPC_HIRE_LAYOUT_DEFAULT.scenePosX),
    scenePosY: num(raw?.scenePosY, NPC_HIRE_LAYOUT_DEFAULT.scenePosY),
    sceneSizeH: num(raw?.sceneSizeH, NPC_HIRE_LAYOUT_DEFAULT.sceneSizeH),
  }
}

function num(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function loadNpcHireLayoutFromStorage(): NpcHireLayout | null {
  try {
    const raw = localStorage.getItem(NPC_HIRE_LAYOUT_STORAGE_KEY)
    if (!raw) return null
    return normalizeNpcHireLayout(JSON.parse(raw) as NpcHireLayoutLegacy)
  } catch {
    return null
  }
}

export function saveNpcHireLayoutToStorage(layout: NpcHireLayout) {
  localStorage.setItem(NPC_HIRE_LAYOUT_STORAGE_KEY, JSON.stringify(layout, null, 2))
}

export function clearNpcHireLayoutStorage() {
  localStorage.removeItem(NPC_HIRE_LAYOUT_STORAGE_KEY)
}

export async function loadNpcHireLayout(): Promise<NpcHireLayout> {
  const fromStorage = loadNpcHireLayoutFromStorage()
  if (fromStorage) return fromStorage

  try {
    const res = await fetch('/npc-hire-layout.json', { cache: 'no-store' })
    if (res.ok) {
      const json = (await res.json()) as NpcHireLayoutLegacy
      return normalizeNpcHireLayout(json)
    }
  } catch {
    /* use defaults */
  }

  return { ...NPC_HIRE_LAYOUT_DEFAULT }
}

export function layoutToSceneStyle(layout: NpcHireLayout): Record<string, string> {
  return {
    '--npc-scene-size-w': 'auto',
    '--npc-scene-size-h': `${layout.sceneSizeH}%`,
    '--npc-scene-pos-x': `${layout.scenePosX}%`,
    '--npc-scene-pos-y': `${layout.scenePosY}%`,
  }
}

export function layoutToAgentColStyle(layout: NpcHireLayout): Record<string, string> {
  return {
    '--npc-agent-left': `${layout.agentLeft}%`,
    '--npc-agent-bottom': `${layout.agentBottom}%`,
    '--npc-agent-offset-x': `${layout.agentOffsetX}px`,
    '--npc-agent-offset-y': `${layout.agentOffsetY}px`,
    '--npc-agent-max-w': `${layout.agentMaxW}px`,
    '--npc-agent-max-h': `${layout.agentMaxH}px`,
  }
}

export function layoutToColStyle(layout: NpcHireLayout): Record<string, string> {
  return {
    ...layoutToSceneStyle(layout),
    ...layoutToAgentColStyle(layout),
  }
}

export function layoutToStatsStyle(layout: NpcHireLayout): Record<string, string> {
  return {
    transform: `translate(${layout.statsOffsetX}px, ${layout.statsOffsetY}px)`,
  }
}

export function layoutToCssSnippet(layout: NpcHireLayout): string {
  return `/* npc-hire-layout */
--npc-scene-pos-x: ${layout.scenePosX}%;
--npc-scene-pos-y: ${layout.scenePosY}%;
--npc-scene-size-h: ${layout.sceneSizeH}%;
--npc-agent-left: ${layout.agentLeft}%;
--npc-agent-bottom: ${layout.agentBottom}%;
--npc-agent-offset-x: ${layout.agentOffsetX}px;
--npc-agent-offset-y: ${layout.agentOffsetY}px;
--npc-agent-max-w: ${layout.agentMaxW}px;
--npc-agent-max-h: ${layout.agentMaxH}px;
/* .npc-hire-stats */
transform: translate(${layout.statsOffsetX}px, ${layout.statsOffsetY}px);`
}

export function layoutReport(layout: NpcHireLayout): string {
  return [
    `Agent offset: (${layout.agentOffsetX}px, ${layout.agentOffsetY}px)`,
    `Agent size: ${layout.agentMaxW}px × ${layout.agentMaxH}px`,
    `Agent anchor: (${layout.agentLeft}%, ${layout.agentBottom}% bottom)`,
    `Stats offset: (${layout.statsOffsetX}px, ${layout.statsOffsetY}px)`,
    `Scene: pos (${layout.scenePosX}%, ${layout.scenePosY}%), size-h ${layout.sceneSizeH}%`,
  ].join('\n')
}
