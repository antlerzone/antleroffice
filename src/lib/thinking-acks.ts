const ACKS_ZH = ['我了解', '好的', '你说得对', '没错', '明白', '嗯…']
const ACKS_EN = ['I see', 'Right', 'Got it', 'Sure', 'Understood', 'Hmm…']

const FOLLOW_UP_ZH = '我这边查了一下，等我一下，我检查一下'
const FOLLOW_UP_EN = 'Let me check on that — one moment, please.'

let lastPick = ''

export function pickThinkingAck(lang: 'zh' | 'en'): string {
  const list = lang === 'zh' ? ACKS_ZH : ACKS_EN
  if (list.length === 1) return list[0] ?? ''
  let pick = list[Math.floor(Math.random() * list.length)] ?? ''
  let guard = 0
  while (pick === lastPick && guard < 6) {
    pick = list[Math.floor(Math.random() * list.length)] ?? ''
    guard += 1
  }
  lastPick = pick
  return pick
}

export function pickThinkingFollowUp(lang: 'zh' | 'en'): string {
  return lang === 'zh' ? FOLLOW_UP_ZH : FOLLOW_UP_EN
}
