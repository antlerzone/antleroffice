export type AiProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'deepseek'

export type AiProviderPresetId = AiProviderId | 'custom'

export interface AiProviderDefinition {
  id: AiProviderId
  label: string
  defaultModel: string
  docsUrl: string
  api: string
  baseUrl: string
}

/** Shared provider list for onboarding, Models quick setup, and create-provider presets. */
export const AI_PROVIDERS: AiProviderDefinition[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'openai/gpt-4o-mini',
    docsUrl: 'https://platform.openai.com/api-keys',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'anthropic/claude-sonnet-4-20250514',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    defaultModel: 'google/gemini-2.0-flash',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    api: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'openrouter/openai/gpt-4o-mini',
    docsUrl: 'https://openrouter.ai/keys',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'groq',
    label: 'Groq',
    defaultModel: 'groq/llama-3.3-70b-versatile',
    docsUrl: 'https://console.groq.com/keys',
    api: 'openai-completions',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    defaultModel: 'mistral/mistral-large-latest',
    docsUrl: 'https://console.mistral.ai/api-keys',
    api: 'openai-completions',
    baseUrl: 'https://api.mistral.ai/v1',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek/deepseek-chat',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
  },
]

export function aiProviderOptions() {
  return AI_PROVIDERS.map((p) => ({ label: p.label, value: p.id }))
}

export function presetModelId(defaultModel: string): string {
  const slashIndex = defaultModel.indexOf('/')
  return slashIndex >= 0 ? defaultModel.slice(slashIndex + 1) : defaultModel
}

export function modelRefForProvider(providerId: string, defaultModel: string): string {
  const modelId = presetModelId(defaultModel)
  return `${providerId}/${modelId}`
}
