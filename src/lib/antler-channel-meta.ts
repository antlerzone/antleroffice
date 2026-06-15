export interface ChannelField {
  key: string
  label: string
}

export interface ChannelMeta {
  label: string
  tag: string
  multiAccount?: boolean
  login?: boolean
  fields?: ChannelField[]
}

export const CHANNEL_META: Record<string, ChannelMeta> = {
  whatsapp: { label: 'WhatsApp', tag: 'WA', multiAccount: true, login: true },
  telegram: { label: 'Telegram', tag: 'TG', multiAccount: true, fields: [{ key: 'token', label: 'Bot token (from @BotFather)' }] },
  feishu: { label: 'Feishu', tag: 'FS', fields: [{ key: 'token', label: 'App token' }] },
  qqbot: { label: 'QQ Bot', tag: 'QQ', fields: [{ key: 'token', label: 'Bot token' }] },
  dingtalk: { label: 'DingTalk', tag: 'DT', fields: [{ key: 'token', label: 'App token' }] },
  wecom: { label: 'WeCom', tag: 'WC', fields: [{ key: 'token', label: 'Corp secret' }] },
  discord: { label: 'Discord', tag: 'DC', fields: [{ key: 'token', label: 'Bot token' }] },
  slack: {
    label: 'Slack',
    tag: 'SL',
    fields: [
      { key: 'botToken', label: 'Bot token (xoxb-…)' },
      { key: 'appToken', label: 'App token (xapp-…)' },
    ],
  },
  signal: { label: 'Signal', tag: 'SG', login: true },
  imessage: { label: 'iMessage', tag: 'iM', login: true },
  msteams: { label: 'MS Teams', tag: 'MT', fields: [{ key: 'token', label: 'Bot token' }] },
  mattermost: { label: 'Mattermost', tag: 'MM', fields: [{ key: 'token', label: 'Access token' }] },
  matrix: { label: 'Matrix', tag: 'MX', fields: [{ key: 'token', label: 'Access token' }] },
  line: { label: 'LINE', tag: 'LN', fields: [{ key: 'token', label: 'Channel access token' }] },
  googlechat: { label: 'Google Chat', tag: 'GC', fields: [{ key: 'token', label: 'Service token' }] },
}

/** Boss-facing channels shown first in Connect channel modal. */
export const PRIMARY_CHANNEL_IDS = [
  'whatsapp',
  'telegram',
  'feishu',
  'qqbot',
  'dingtalk',
  'wecom',
] as const

export const OTHER_CHANNEL_IDS = Object.keys(CHANNEL_META).filter(
  (id) => !PRIMARY_CHANNEL_IDS.includes(id as (typeof PRIMARY_CHANNEL_IDS)[number]),
)

export function channelMeta(id: string): ChannelMeta {
  return (
    CHANNEL_META[id] || {
      label: id,
      tag: (id || '?').slice(0, 2).toUpperCase(),
      fields: [{ key: 'token', label: 'Token' }],
    }
  )
}

export function formatWaPhone(jid: string | null | undefined): string | null {
  if (!jid) return null
  const s = String(jid)
  const m = s.match(/^(\d{8,15})/)
  if (m?.[1]) return `+${m[1]}`
  const bare = s.split('@')[0]?.split(':')[0] ?? ''
  return /^\d+$/.test(bare) ? `+${bare}` : bare || null
}
