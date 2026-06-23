// Minimal multi-provider LLM client using global fetch (Node 18+/Electron 35).
// Each NPC's "brain" picks a provider; the client supplies the API key in Settings.

async function callOpenAI({ apiKey, model, system, prompt, maxTokens = 1024, signal }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

/** Stream OpenAI chat completions; onDelta(textChunk) for each content delta. */
async function streamOpenAI({ apiKey, model, system, prompt, maxTokens = 1024, onDelta, signal }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
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

async function callAnthropic({ apiKey, model, system, prompt }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
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
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('').trim();
}

async function callGemini({ apiKey, model, system, prompt }) {
  const m = model || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
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

module.exports = { runBrain, callOpenAI, streamOpenAI };
