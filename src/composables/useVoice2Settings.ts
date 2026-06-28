// Voice v2 设置（本地保存）。唤醒词、自启开关、音色、TTS 供应商都在这里。
import { reactive, watch } from 'vue'

export type Voice2TtsProvider = 'openai' | 'elevenlabs' | 'fish'

export interface Voice2Settings {
  localWake: boolean        // 本地唤醒：用本机 openWakeWord 听“Jarvis”，听到才自动连 v2（省 token）。默认开。
  wakePhrases: string[]     // 唤醒词（可多个，任一命中即唤醒）
  assistantName: string     // 这个语音助手的名字（默认 Jarvis）
  soul: string              // 助手的“灵魂”：性格/口吻/人设，自定义
  greeting: string          // 唤醒后的招呼语。空=按人设自动生成；填了=每次说这句
  sleepPhrases: string[]    // 休息语（触发词，可多个）：老板说到任一就结束
  sleepReply: string        // 休息语回复（道别词）：结束时助手说的话
  voice: string             // OpenAI 自带音色
  model: string             // Realtime 模型
  ttsProvider: Voice2TtsProvider // 语音输出用哪个：openai 自带 / fish / elevenlabs
  elevenLabsKey: string
  elevenVoiceId: string     // ElevenLabs 音色 ID
  fishKey: string
  fishVoiceId: string       // Fish 音色/参考模型 ID（referenceId）
}

const STORAGE_KEY = 'antler_voice2_settings'

const DEFAULTS: Voice2Settings = {
  localWake: true,
  wakePhrases: ['Jarvis'],
  assistantName: 'Jarvis',
  soul: '',
  greeting: '',
  sleepPhrases: ['没事了', '退下', '拜拜', '先这样', '不聊了', '没了'],
  sleepReply: '好的，那我先休息了，有事再喊我。',
  voice: 'cedar',
  model: 'gpt-realtime',
  ttsProvider: 'openai',
  elevenLabsKey: '',
  elevenVoiceId: '',
  fishKey: '',
  fishVoiceId: '',
}

function load(): Voice2Settings {
  let parsed: any = {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) parsed = JSON.parse(raw)
  } catch { /* ignore */ }
  const s: any = { ...DEFAULTS, ...parsed }
  // 兼容旧数据：单个唤醒词字符串 → 数组
  if (typeof parsed.wakePhrase === 'string' && !Array.isArray(parsed.wakePhrases)) {
    s.wakePhrases = parsed.wakePhrase.trim() ? [parsed.wakePhrase.trim()] : [...DEFAULTS.wakePhrases]
  }
  // 兼容旧数据：逗号分隔的休息语字符串 → 数组
  if (typeof parsed.sleepPhrases === 'string') {
    s.sleepPhrases = parsed.sleepPhrases.split(',').map((x: string) => x.trim()).filter(Boolean)
  }
  if (!Array.isArray(s.wakePhrases) || s.wakePhrases.length === 0) s.wakePhrases = [...DEFAULTS.wakePhrases]
  if (!Array.isArray(s.sleepPhrases)) s.sleepPhrases = [...DEFAULTS.sleepPhrases]
  delete s.wakePhrase
  return s as Voice2Settings
}

const settings = reactive<Voice2Settings>(load())

// 共享后端存储：一台电脑只存一份，electron/exe/localhost 都读同一处。
const SERVER_PATH = '/api/voice/ui-settings/antler_voice2_settings'
let hydrationDone = false

function postToServer() {
  try {
    void fetch(SERVER_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    }).catch(() => {})
  } catch { /* ignore */ }
}

watch(settings, (v) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)) } catch { /* ignore */ }
  // 水合完成后才回写后端，避免启动瞬间用默认值覆盖别的源已存好的设置。
  if (hydrationDone) postToServer()
}, { deep: true })

// 启动时从后端拉共享设置：后端有就用后端；后端空但本地有，就把本地播种上去。
async function hydrateFromServer() {
  let applied = false
  try {
    const res = await fetch(SERVER_PATH)
    const data = (await res.json()) as { ok?: boolean; settings?: Partial<Voice2Settings> | null }
    if (
      data?.ok &&
      data.settings &&
      typeof data.settings === 'object' &&
      Object.keys(data.settings).length
    ) {
      Object.assign(settings, data.settings)
      applied = true
    }
  } catch { /* ignore */ }
  if (!applied) {
    try {
      if (localStorage.getItem(STORAGE_KEY)) postToServer()
    } catch { /* ignore */ }
  }
  hydrationDone = true
}

void hydrateFromServer()

export function useVoice2Settings() {
  return { settings }
}
