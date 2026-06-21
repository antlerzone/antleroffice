import type { ChatMessage } from '@/api/types'

const INTAKE_HEADER_RE = /\[AntlerOffice secretary intake/i

function parseIntakeBlock(content: string): { boss: string; secretary: string } | null {
  const text = String(content || '').trim()
  if (!INTAKE_HEADER_RE.test(text)) return null

  const body = text.replace(/^[^\n]*\[AntlerOffice secretary intake[^\n]*\]\s*/i, '').trim()
  const bossMatch = body.match(/Boss:\s*([\s\S]*?)(?=\nSecretary:|$)/i)
  const secMatch = body.match(/Secretary:\s*([\s\S]*)$/i)

  const boss = (bossMatch?.[1] || '').trim()
  const secretary = (secMatch?.[1] || '').trim()
  if (!boss && !secretary) return null
  return { boss, secretary }
}

function isSystemStatusBoss(text: string): boolean {
  const t = String(text || '').trim()
  return t === '[系统状态]' || t.startsWith('[CEO 执行') || t.startsWith('[系统]')
}

function isInjectBlob(content: string): boolean {
  return INTAKE_HEADER_RE.test(String(content || ''))
}

function toBossBubble(msg: ChatMessage, content: string, suffix: string): ChatMessage {
  return {
    ...msg,
    id: `${msg.id || 'inj'}-${suffix}`,
    role: 'user',
    content,
    name: 'Boss',
    rawContent: undefined,
  }
}

function toSecretaryBubble(msg: ChatMessage, content: string, suffix: string): ChatMessage {
  return {
    ...msg,
    id: `${msg.id || 'inj'}-${suffix}`,
    role: 'assistant',
    content,
    name: 'Secretary',
    rawContent: undefined,
  }
}

/**
 * Split legacy combined chat.inject blobs into separate Boss (right) + Secretary (left) bubbles.
 */
export function expandGatewayInjectedMessages(messages: ChatMessage[]): ChatMessage[] {
  const expanded: ChatMessage[] = []

  for (const msg of messages) {
    const content = String(msg.content || '').trim()
    if (!isInjectBlob(content)) {
      expanded.push(msg)
      continue
    }

    const parsed = parseIntakeBlock(content)
    if (!parsed) continue

    const baseId = msg.id || `inj-${expanded.length}`

    if (parsed.boss && !isSystemStatusBoss(parsed.boss)) {
      expanded.push(toBossBubble({ ...msg, id: baseId }, parsed.boss, 'boss'))
    }
    if (parsed.secretary) {
      expanded.push(toSecretaryBubble({ ...msg, id: baseId }, parsed.secretary, 'sec'))
    }
  }

  return expanded
}
