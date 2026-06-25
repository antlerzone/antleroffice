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
  localWake: tru