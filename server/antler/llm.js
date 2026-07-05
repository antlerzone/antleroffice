// Minimal multi-provider LLM client using global fetch (Node 18+/Electron 35).
// Each NPC's "brain" picks a provider; the client supplies the API key in Settings.

// ---------------------------------------------------------------------------
// Transient-error retry (error recovery layer).
// A single 429/5xx or a dropped connection should NOT fail the whole task.
// Retries with exponential backoff + jitter, honors Retry-After, and never
// retries permanent errors (401 bad key, 400 bad request, aborts).
// ---------------------------------------------------------------------------

const RETRY_MAX_ATTEMPTS = 3; // 1 original try + 2 retries
const RETRY_BASE_DELAY_MS = 800;
const RETRY_MAX_DELAY_MS = 8000;

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

function sleepMs(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function retryDelayMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS);
  }
  const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * 0.3 * base;
  return Math.min(base + jitter, RETRY_MAX_DELAY_MS);
}

// fetch() rejects with TypeError/network-ish errors when the connection drops.
function isNetworkError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || /aborted/i.test(String(err.message || ''))) return false;
  const msg = String(err.message || '');
  return (
    err.name === 'TypeError' ||
    /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|UND_ERR/i.test(msg)
  );
}

/**
 * fetch() with retry on transient failures. Returns the successful Response.
 * Non-OK permanent responses (401/400/...) are thrown immediately with body text,
 * matching the previous error format: `<label> <status>: <body>`.
 */
async function fetchWithRetry(label, url, options = {}) {
  const signal = options.signal;
  let lastErr = null;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw lastErr || new Error('aborted');
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      if (!isNetworkError(err) || attempt === RETRY_MAX_ATTEMPTS - 1) throw err;
      lastErr = err;
      await sleepMs(retryDelayMs(attempt, null), signal);
      continue;
    }
    if (res.ok) return res;
    const bodyText = await res.text().catch(() => '');
    const error = new Error(`${label} ${res.status}: ${bodyText}`);
    error.status = res.status;
    if (!TRANSIENT_STATUS.has(res.status) || attempt === RETRY_MAX_ATTEMPTS - 1) throw error;
    lastErr = error;
    await sleepMs(retryDelayMs(attempt, res.headers?.get?.('retry-after')), signal);
  }
  throw lastErr || new Error(`${label}: request failed`);
}

async function callOpenAI({ apiKey, model, system, prompt, maxTokens = 1024, signal }) {
  const res = await fetchWithRetry('OpenAI', 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system || '' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

/** Stream OpenAI chat completions; onDelta(textChunk) for each content delta.
 *  Retries only cover connection setup — once deltas start flowing we never
 *  retry (that would duplicate text the UI already showed). */
async function streamOpenAI({ apiKey, model, system, prompt, maxTokens = 1024, onDelta, signal }) {
  const res = await fetchWithRetry('OpenAI', 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      max_tokens: maxTokens,
      stream: true,
      messages: [
        { role: 'system', content: system || '' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.body) throw new Error('OpenAI stream body missing');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          if (typeof onDelta === 'function') onDelta(delta);
        }
      } catch {
        /* ignore partial SSE */
      }
    }
  }
  return full.trim();
}

async function callAnthropic({ apiKey, model, system, prompt, signal }) {
  const res = await fetchWithRetry('Anthropic', 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-3-5-sonnet-latest',
      max_tokens: 1024,
      system: system || '',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('').trim();
}

async function callGemini({ apiKey, model, system, prompt, signal }) {
  const m = model || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const res = await fetchWithRetry('Gemini', url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }),
  });
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

// Resolve the provider/key for a given NPC brain + settings, then run.
// Returns { text, provider } or throws. Falls back to a deterministic
// "demo" answer when no key is configured, so the office still works offline.
async function runBrain({ settings, brain, system, prompt, note }) {
  const mode = brain?.mode || 'ai';
  if (mode === 'ecs') {
    return { provider: 'ecs', text: demoAnswer(prompt, 'ECS connector not wired yet (stub).') };
  }

  const provider = brain?.provider || settings.defaultProvider;
  const cfg = settings.providers?.[provider];

  if (!provider || provider === 'demo' || !cfg || !cfg.apiKey) {
    return { provider: 'demo', text: demoAnswer(prompt, note) };
  }

  const args = { apiKey: cfg.apiKey, model: cfg.model, system, prompt };
  let text = '';
  if (provider === 'openai') text = await callOpenAI(args);
  else if (provider === 'anthropic') text = await callAnthropic(args);
  else if (provider === 'gemini') text = await callGemini(args);
  else return { provider: 'demo', text: demoAnswer(prompt, note) };

  return { provider, text };
}

function demoAnswer(prompt, note) {
  const head = note ? `(${note})\n\n` : '(Demo mode — no AI key set in Settings, showing a placeholder.)\n\n';
  const foot = note
    ? `This is a placeholder. Once OpenClaw runs successfully, real model output replaces it.`
    : `Set an AI key in Settings to get a real answer from your own model.`;
  return (
    `${head}Task received: "${String(prompt).slice(0, 300)}"\n\n` +
    `Here is a draft deliverable:\n` +
    `1. Understood the request.\n` +
    `2. Outlined an approach.\n` +
    `3. Produced the result.\n\n` +
    foot
  );
}

module.exports = { runBrain, callOpenAI, streamOpenAI, fetchWithRetry };
