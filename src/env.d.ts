/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'vue-pdf-embed' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, any>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_WS_URL: string
  readonly VITE_APP_TITLE: string
  readonly VITE_APP_VERSION?: string
  readonly VITE_OPENCLAW_CLIENT_ID?: string
  readonly VITE_OPENCLAW_CLIENT_MODE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface VoiceWakeState {
  mode: 'sleep' | 'active' | 'speaking'
  globalListen?: boolean
}

interface AntlerDesktopBridge {
  platform?: string
  isElectron?: boolean
  openExternal?: (url: string) => Promise<{ ok?: boolean }>
  voiceWakeGetStatus?: () => Promise<{ ok: boolean; state?: VoiceWakeState }>
  voiceWakeSetMode?: (mode: 'sleep' | 'active') => Promise<{ ok: boolean }>
  voiceWakeWake?: () => Promise<{ ok: boolean }>
  onVoiceWakeOpenSettings?: (cb: () => void) => () => void
  onVoiceWakeState?: (cb: (state: VoiceWakeState) => void) => () => void
}

interface Window {
  antlerDesktop?: AntlerDesktopBridge
}
