/**
 * Holding Pattern — progressive "waiting phrases" for the voice agent.
 *
 * When the office (COO/OpenClaw) takes a few seconds to work, silence feels broken.
 * This plays an immediate acknowledgement, then escalating progress phrases at
 * intervals, so the user always hears that the assistant is working — exactly like a
 * good human receptionist ("好的，我帮您查询" → "正在整理记录" → "分析接近完成").
 *
 * Call start() when the command is handed to the COO, and stop() the moment the real
 * result is ready (then speak the result).
 */

type StageBank = Record<'zh' | 'en', string[]>

// 0–3s: let them know you heard them.
const ACK: StageBank = {
  zh: [
    '好的，我帮您查询一下。',
    '收到，我现在查看相关资料。',
    '好的，请稍等，我正在确认资料。',
    '让我帮您核对一下系统记录。',
  ],
  en: [
    "Sure, let me look that up for you.",
    "Got it — checking now.",
    "One moment, I'm pulling up the details.",
    "Let me check the records for you.",
  ],
}

// ~4s: tell them which step you're on.
const STAGE_4S: StageBank = {
  zh: [
    '我已经找到相关资料，正在整理记录。',
    '系统正在读取最近的数据。',
    '我正在汇总相关信息，请稍等。',
    '资料已经调出，正在进一步核对。',
  ],
  en: [
    "I've found the records, organising them now.",
    "Reading the latest data.",
    "Pulling the details together — one moment.",
  ],
}

// ~8s: still working — show real progress.
const STAGE_8S: StageBank = {
  zh: [
    '我已经取得部分资料，正在分析完整记录。',
    '数据较多，我正在整理最近的情况。',
    '我正在比对多个系统的数据，请稍等片刻。',
    '已经找到相关纪录，正在确认细节。',
  ],
  en: [
    "I have part of it — analysing the full record now.",
    "There's a fair bit of data, sorting through it.",
    "Cross-checking across the systems, one moment.",
  ],
}

// ~15s: report progress.
const STAGE_15S: StageBank = {
  zh: [
    '分析接近完成，正在整理最终结果。',
    '已经取得主要资料，接下来整理重点给您。',
    '分析已完成约一半，正在生成摘要。',
  ],
  en: [
    "Almost done — putting the results together.",
    "I have the main data, summarising the key points now.",
  ],
}

// ~22s: explain the reason for the wait.
const STAGE_22S: StageBank = {
  zh: [
    '这项查询涉及较多历史资料，需要多一点时间。',
    '我正在处理较大的数据集，请再给我一点时间。',
    '资料已经取得，正在进行最终分析。',
  ],
  en: [
    "This one covers a lot of history, so it needs a little longer.",
    "Working through a larger dataset — just a bit more time.",
  ],
}

// 30s+: set a clear expectation.
const STAGE_30S: StageBank = {
  zh: [
    '这份分析还需要一点时间，您可以继续等，或者我完成后主动通知您。',
    '这是较复杂的查询，我可以先给您目前的结果，稍后再补充完整分析。',
  ],
  en: [
    "This will take a little longer — happy to keep going, or I can notify you when it's ready.",
    "It's a complex one; I can share what I have now and follow up with the rest.",
  ],
}

// Spaced ~7s+ apart: cloud TTS (Fish) takes ~2s to synthesize + ~3s to play, so tighter
// gaps would make phrases overlap and cut each other off.
const SCHEDULE: Array<{ at: number; bank: StageBank }> = [
  { at: 7000, bank: STAGE_4S },
  { at: 15000, bank: STAGE_8S },
  { at: 24000, bank: STAGE_15S },
  { at: 34000, bank: STAGE_22S },
  { at: 45000, bank: STAGE_30S },
]

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)] || arr[0] || ''
}

/** Every waiting phrase for a language — used to pre-render them in the boss's voice. */
export function allWaitingPhrases(lang: 'zh' | 'en'): string[] {
  const banks = [ACK, STAGE_4S, STAGE_8S, STAGE_15S, STAGE_22S, STAGE_30S]
  const out: string[] = []
  for (const bank of banks) for (const p of bank[lang]) if (p.trim()) out.push(p.trim())
  return Array.from(new Set(out))
}

export function useHoldingPattern(
  speak: (text: string) => void,
  getLang?: () => 'zh' | 'en',
) {
  let timers: ReturnType<typeof setTimeout>[] = []
  let active = false

  function lang(): 'zh' | 'en' {
    // Follow the boss's Reply language (passed by the caller); default English.
    return getLang ? getLang() : 'en'
  }

  function start() {
    stop()
    active = true
    const l = lang()
    speak(pick(ACK[l])) // 0–3s acknowledgement, immediately
    for (const step of SCHEDULE) {
      timers.push(
        setTimeout(() => {
          if (active) speak(pick(step.bank[l]))
        }, step.at),
      )
    }
  }

  function stop() {
    active = false
    timers.forEach((t) => clearTimeout(t))
    timers = []
  }

  return { start, stop }
}
