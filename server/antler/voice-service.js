const fs = require('node:fs');
const path = require('node:path');
const voiceProfiles = require('./voice-profiles-store');
const voiceGpu = require('./voice-gpu-check');
const voiceSidecarManager = require('./voice-sidecar-manager');
const voiceAudioUtils = require('./voice-audio-utils');
const voiceDebug = require('./voice-debug');
const voiceCommandService = require('./voice-command-service');
const voiceListenerManager = require('./voice-listener-manager');
const wakeClipsStore = require('./wake-clips-store');
const voiceApiPrefs = require('./voice-api-preferences-store');

const TYPEWHISPER_URL = (process.env.VOICE_TYPEWHISPER_URL || 'http://127.0.0.1:8978').replace(/\/+$/, '');
const TTS_URL = (process.env.VOICE_TTS_URL || process.env.VOICE_QWEN_URL || 'http://127.0.0.1:8765').replace(
  /\/+$/,
  '',
);
const ALT_TTS_URL = (process.env.VOICE_ALT_TTS_URL || 'http://127.0.0.1:8766').replace(/\/+$/, '');

const MAX_REF_TEXT_CHARS = Number(process.env.VOICE_MAX_REF_TEXT_CHARS || process.env.QWEN_MAX_REF_TEXT_CHARS) || 48;

const FISH_REFERENCE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function normalizeFishAudioReferenceId(input) {
  let s = String(input || '').trim().replace(/^["']|["']$/g, '');
  const fromUrl = s.match(/fish\.audio\/(?:voice\/|m\/|model\/|)?([A-Za-z0-9_-]{1,128})/i);
  if (fromUrl?.[1]) return fromUrl[1];
  if (s.includes('/')) {
    const seg = s.split('/').filter(Boolean).pop() || '';
    if (FISH_REFERENCE_ID_RE.test(seg)) return seg;
  }
  return s;
}

function isValidFishAudioReferenceId(input) {
  return FISH_REFERENCE_ID_RE.test(normalizeFishAudioReferenceId(input));
}

function trimRefTextForClone(refText) {
  const text = String(refText || '').trim();
  if (!text) return null;
  if (text.length <= MAX_REF_TEXT_CHARS) return text;
  return text.slice(0, MAX_REF_TEXT_CHARS);
}

async function probeUrl(baseUrl, healthPath = '/health') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`${baseUrl}${healthPath}`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function getVoiceStatus() {
  const [gpu, typewhisperUp, altTtsHealth, listenerHealth, setup] = await Promise.all([
    voiceGpu.checkGpuForVoiceClone().catch((e) => ({ meetsRequirements: false, vramMb: null, minVramMb: 0, reason: e.message })),
    probeUrl(TYPEWHISPER_URL).catch(() => false),
    voiceSidecarManager.probeAltTtsHealth().catch(() => ({ up: false, ready: false })),
    voiceListenerManager.probeListenerHealth().catch(() => ({ up: false, ready: false })),
    Promise.resolve(voiceSidecarManager.getSetupStatus()),
  ]);
  const openclawKey = voiceApiPrefs.openclawOpenAiKeyConfigured();
  return {
    ok: true,
    gpu,
    setup,
    stt: {
      engine: 'openai',
      openclawOpenAiKeyConfigured: openclawKey,
      sttKeyAvailable: openclawKey || typewhisperUp,
      available: openclawKey || typewhisperUp,
      typewhisper: {
        url: TYPEWHISPER_URL,
        available: typewhisperUp,
      },
    },
    tts: {
      engine: 'edgetts',
      url: ALT_TTS_URL,
      available: altTtsHealth.ready,
      sidecarRunning: altTtsHealth.ready,
      sidecarUp: altTtsHealth.up,
      gpuReady: gpu.meetsRequirements,
      gpuRequired: false,
      cosyvoiceRemoved: true,
    },
    altTts: {
      url: ALT_TTS_URL,
      available: altTtsHealth.ready,
      sidecarUp: altTtsHealth.up,
      kokoro: altTtsHealth.data?.kokoro === true,
      edgetts: altTtsHealth.data?.edgetts === true,
    },
    listener: {
      url: voiceListenerManager.LISTENER_URL,
      available: listenerHealth.ready,
      sidecarUp: listenerHealth.up,
      wakeBackend: listenerHealth.data?.state?.wake_backend || null,
      wakeError: listenerHealth.data?.state?.wake_error || null,
      clapDetectorActive: listenerHealth.data?.clapDetectorActive === true,
      clapThreshold: listenerHealth.data?.clapThreshold ?? null,
      peakRms: listenerHealth.data?.peakRms ?? null,
      config: voiceListenerManager.getListenerConfig(),
    },
  };
}

async function transcribeAudio(buffer, filename, mimeType, opts = {}) {
  const apiKey = String(opts.apiKey || opts.openaiApiKey || '').trim();
  const sttModel = opts.openaiSttModel || 'gpt-4o-mini-transcribe';
  const language = opts.language || opts.sttLanguage || null;

  if (apiKey) {
    const owResult = await transcribeWithOpenAI(buffer, filename, mimeType, apiKey, sttModel, language, opts.prompt);
    if (owResult.ok) {
      return { ...owResult, keySource: opts.keySource || 'configured' };
    }
    const twResult = await transcribeWithTypeWhisper(buffer, filename, mimeType);
    if (twResult.ok) return twResult;
    return {
      ok: false,
      fallback: 'browser',
      error: owResult.error || twResult.error || 'Transcription unavailable',
    };
  }

  const twResult = await transcribeWithTypeWhisper(buffer, filename, mimeType);
  if (twResult.ok) return twResult;

  return {
    ok: false,
    fallback: 'browser',
    error: twResult.error || 'No STT API key configured',
  };
}

async function transcribeWithTypeWhisper(buffer, filename, mimeType) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const form = new FormData();
    const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
    form.append('file', blob, filename || 'audio.webm');
    const res = await fetch(`${TYPEWHISPER_URL}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(errText || `TypeWhisper HTTP ${res.status}`);
    }
    const data = await res.json();
    const text = data.text || data.transcript || data.result || '';
    return { ok: true, text: String(text).trim(), engine: 'typewhisper' };
  } catch (e) {
    return {
      ok: false,
      error: e.message || 'TypeWhisper unavailable',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeWithOpenAI(buffer, filename, mimeType, apiKey, model, language, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const form = new FormData();
    const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
    form.append('file', blob, filename || 'audio.webm');
    form.append('model', String(model || 'gpt-4o-mini-transcribe').trim() || 'gpt-4o-mini-transcribe');
    const lang = String(language || '').trim().toLowerCase();
    if (lang === 'zh' || lang === 'en') form.append('language', lang);
    const hint = String(prompt || '').trim();
    if (hint) form.append('prompt', hint.slice(0, 500));
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(errText || `OpenAI STT HTTP ${res.status}`);
    }
    const data = await res.json();
    const text = data.text || data.transcript || '';
    const trimmed = String(text).trim();
    if (!trimmed) {
      // Retry with whisper-1 when mini model returns empty (common on short wake clips).
      if (String(model || '').includes('mini')) {
        return transcribeWithOpenAI(buffer, filename, mimeType, apiKey, 'whisper-1', language, prompt);
      }
      throw new Error('Empty transcription');
    }
    return { ok: true, text: trimmed, engine: 'openai-whisper' };
  } catch (e) {
    return {
      ok: false,
      error: e.message || 'OpenAI STT failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeOpenAiSpeech({ text, voice, model, ownerKey, apiKey }) {
  const resolved = apiKey
    ? { apiKey: String(apiKey).trim(), source: 'request_body' }
    : voiceApiPrefs.resolveSttApiKey(ownerKey || 'local:boss');
  if (!resolved.apiKey) {
    return { ok: false, error: 'No OpenAI API key configured' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        model: String(model || 'gpt-4o-mini-tts').trim() || 'gpt-4o-mini-tts',
        voice: String(voice || 'alloy').trim() || 'alloy',
        input: String(text || '').trim(),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: errText || `OpenAI TTS HTTP ${res.status}` };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      buffer,
      contentType: res.headers.get('content-type') || 'audio/mpeg',
      keySource: resolved.source,
    };
  } catch (e) {
    return { ok: false, error: e.message || 'OpenAI TTS failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeFishAudio({ text, apiKey, referenceId, latency }) {
  const ref = normalizeFishAudioReferenceId(referenceId);
  if (!apiKey) return { ok: false, error: 'Fish Audio API key is required' };
  if (!isValidFishAudioReferenceId(ref)) {
    return {
      ok: false,
      error:
        'Invalid Fish Audio Voice ID (reference_id). Copy the ID from fish.audio → My Voices — letters, numbers, _ and - only (not a URL).',
    };
  }
  await voiceSidecarManager.ensureAltTtsSidecarAsync();
  const altUp = await probeUrl(ALT_TTS_URL);
  if (!altUp) {
    return { ok: false, error: 'Alt TTS sidecar is not running' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`${ALT_TTS_URL}/tts/fishaudio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, apiKey, referenceId: ref, latency: latency || 'balanced' }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errMsg = errText;
      try { errMsg = JSON.parse(errText).error || errText; } catch { /* keep */ }
      const recoverable =
        /reference not found|invalid.*voice|not found|unauthorized|quota/i.test(String(errMsg));
      return {
        ok: false,
        fallback: recoverable ? 'webspeech' : undefined,
        error: errMsg || `Fish Audio sidecar HTTP ${res.status}`,
      };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, buffer, contentType: 'audio/mpeg' };
  } catch (e) {
    const msg = e.message || 'Fish Audio synthesis failed';
    const recoverable = /reference not found|invalid.*voice|not found/i.test(msg);
    return { ok: false, fallback: recoverable ? 'webspeech' : undefined, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeElevenLabs({ text, apiKey, voiceId }) {
  if (!apiKey) return { ok: false, error: 'ElevenLabs API key is required' };
  if (!voiceId) return { ok: false, error: 'ElevenLabs voiceId is required' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errMsg = errText;
      try { errMsg = JSON.parse(errText)?.detail?.message || JSON.parse(errText).error || errText; } catch { /* keep */ }
      throw new Error(errMsg || `ElevenLabs HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, buffer, contentType: 'audio/mpeg', engine: 'elevenlabs' };
  } catch (e) {
    return { ok: false, error: e.message || 'ElevenLabs synthesis failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeAltTts({ text, engine, voice, rate }) {
  const eng = String(engine || 'edgetts').toLowerCase();
  if (eng === 'edgetts') {
    const direct = await voiceSidecarManager.synthesizeEdgeTtsDirect({ text, voice, rate });
    if (direct.ok) return direct;
    console.warn('[voice/synthesize] EdgeTTS direct failed, trying sidecar:', direct.error);
  }

  await voiceSidecarManager.ensureAltTtsSidecarAsync();
  let altHealth = await voiceSidecarManager.probeAltTtsHealth(3000);
  if (!altHealth.ready) {
    try {
      await voiceSidecarManager.ensureAltTtsSidecar();
      altHealth = await voiceSidecarManager.probeAltTtsHealth(8000);
    } catch (e) {
      return {
        ok: false,
        fallback: 'webspeech',
        error: e.message || 'Alt TTS sidecar failed to start',
      };
    }
  }
  if (!altHealth.up) {
    return { ok: false, fallback: 'webspeech', error: 'Alt TTS sidecar is not running' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(`${ALT_TTS_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, engine, voice, rate }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let errText = await res.text().catch(() => '');
      try {
        const parsed = JSON.parse(errText);
        errText = parsed.error || errText;
      } catch {
        /* keep */
      }
      throw new Error(errText || `Alt TTS HTTP ${res.status}`);
    }
    const contentType = res.headers.get('content-type') || 'audio/mpeg';
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, buffer, contentType, engine };
  } catch (e) {
    return { ok: false, fallback: 'webspeech', error: e.message || 'Alt TTS synthesis failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeCosyVoice({ text, profileId }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Text is required');
  void profileId;
  return synthesizeAltTts({
    text: trimmed,
    engine: 'edgetts',
    voice: 'en-GB-RyanNeural',
    rate: 1.0,
  });
}

async function synthesizeSpeech({ text, profileId, engine, voice, rate, apiKey, voiceId }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Text is required');

  const chosen = String(engine || 'fishaudio').toLowerCase();
  if (chosen === 'elevenlabs') {
    return synthesizeElevenLabs({ text: trimmed, apiKey, voiceId });
  }
  if (chosen === 'fishaudio') {
    const r = await synthesizeFishAudio({ text: trimmed, apiKey, referenceId: voiceId });
    return r.ok ? { ...r, engine: 'fishaudio' } : r;
  }
  if (chosen === 'edgetts' || chosen === 'kokoro') {
    return synthesizeAltTts({
      text: trimmed,
      engine: chosen,
      voice: voice || (chosen === 'kokoro' ? 'bm_george' : 'en-GB-RyanNeural'),
      rate: Number(rate) || 1.0,
    });
  }
  if (chosen === 'webspeech') {
    return { ok: false, fallback: 'webspeech', error: 'Use browser speech' };
  }
  if (chosen === 'cosyvoice') {
    return synthesizeAltTts({
      text: trimmed,
      engine: 'edgetts',
      voice: voice || 'en-GB-RyanNeural',
      rate: Number(rate) || 1.0,
    });
  }
  return synthesizeCosyVoice({ text: trimmed, profileId });
}

async function setListenerSpeaking(speaking, bargeIn = false) {
  try {
    await voiceListenerManager.setListenerSpeaking(speaking, bargeIn);
  } catch {
    /* ignore */
  }
}

async function handleListenerEvent(body = {}) {
  const type = String(body.type || '');
  const config = voiceListenerManager.getListenerConfig();
  const published = voiceListenerManager.publishListenerEvent(body);

  if (type === 'wake') {
    console.log('[summon] server wake event', {
      phrase: body.phrase || null,
      mode: body.mode || 'active',
      source: body.source || 'listener',
    });
    await voiceListenerManager.setListenerMode('active');
    return { ok: true, event: published };
  }

  if (type === 'idle') {
    await voiceListenerManager.setListenerMode('sleep');
    return { ok: true, event: published };
  }

  if (type === 'transcript') {
    const text = String(body.text || '').trim();
    if (!text) return { ok: true, event: published, skipped: true };

    if (voiceListenerManager.isWakeOnlyPhrase(text)) {
      console.log('[summon] transcript skipped (wake-only):', text.slice(0, 80));
      return { ok: true, event: published, skipped: true, reason: 'wake_only' };
    }

    if (config.realtimeSessionActive) {
      return { ok: true, event: published, dispatched: false, reason: 'realtime_active' };
    }

    if (String(body.mode || '').toLowerCase() === 'sleep') {
      return { ok: true, event: published, dispatched: false, reason: 'listener_sleep' };
    }

    if (!config.autoDispatch) {
      return { ok: true, event: published, dispatched: false };
    }

    const playback = voiceListenerManager.getStandupPlaybackState();
    if (playback.active) {
      const result = await voiceCommandService.runStandupPlaybackCommand({
        text,
        deliverableId: playback.deliverableId,
        sectionIndex: playback.sectionIndex,
        ownerKey: config.ownerKey,
        interrupted: playback.interrupted,
      });
      const commandEvent = voiceListenerManager.publishListenerEvent({
        type: 'command_result',
        text,
        result,
        playback: true,
        at: Date.now(),
      });
      return { ok: true, event: published, command: commandEvent, result, playback: true };
    }

    const result = await voiceCommandService.runVoiceCommand({
      text,
      ownerKey: config.ownerKey,
      ownerName: config.ownerName,
      personaEnabled: config.personaEnabled,
      honorific: config.honorific,
      personaPrompt: config.personaPrompt,
      replyLanguage: config.replyLanguage === 'zh' ? 'zh' : config.replyLanguage === 'en' ? 'en' : null,
      agentId: 'main',
    });

    const commandEvent = voiceListenerManager.publishListenerEvent({
      type: 'command_result',
      text,
      result,
      at: Date.now(),
    });

    return { ok: true, event: published, command: commandEvent, result };
  }

  return { ok: true, event: published };
}

function registerVoiceRoutes(app, upload, opts = {}) {
  const voicePersona = require('./voice-persona');
  const resolveBossOwner = typeof opts.resolveBossOwner === 'function' ? opts.resolveBossOwner : null;

  function ownerFromReq(req) {
    const bodyKey = String(req.body?.ownerKey || '').trim();
    const ip = String(req.socket?.remoteAddress || '');
    const loopback =
      ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.endsWith('127.0.0.1');
    if (bodyKey && loopback && /^[a-zA-Z0-9:_@.-]+$/.test(bodyKey)) {
      return {
        ownerKey: bodyKey,
        ownerName: String(req.body?.ownerName || 'Boss').trim() || 'Boss',
      };
    }
    if (resolveBossOwner) return resolveBossOwner(req);
    return { ownerKey: 'local:boss', ownerName: 'Boss' };
  }

  app.get('/api/voice/persona/template', (req, res) => {
    try {
      const lang = String(req.query?.lang || '').trim().toLowerCase();
      res.json({ ok: true, template: voicePersona.getJarvisTemplate(lang === 'zh' ? 'zh' : undefined) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/voice/status', async (_req, res) => {
    try {
      res.json(await getVoiceStatus());
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/voice/profiles', (_req, res) => {
    try {
      res.json({ ok: true, ...voiceProfiles.listProfiles() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/profiles', upload.single('audio'), (req, res) => {
    try {
      const file = req.file;
      if (!file?.buffer?.length) {
        return res.status(400).json({ ok: false, error: 'audio file is required' });
      }
      const durationSec = req.body?.durationSec ? Number(req.body.durationSec) : null;
      const profile = voiceProfiles.createProfile({
        name: req.body?.name,
        buffer: file.buffer,
        originalName: file.originalname,
        mimeType: file.mimetype,
        durationSec: Number.isFinite(durationSec) ? durationSec : null,
        refText: req.body?.refText,
        lang: req.body?.lang,
      });
      res.json({ ok: true, profile });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // NOTE: /active must be before /:id to avoid Express matching 'active' as an id param.
  app.patch('/api/voice/profiles/active', (req, res) => {
    try {
      const id = req.body?.profileId || null;
      const activeProfileId = voiceProfiles.setActiveProfile(id);
      res.json({ ok: true, activeProfileId });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.patch('/api/voice/profiles/:id', (req, res) => {
    try {
      const profile = voiceProfiles.updateProfile(req.params.id, {
        name: req.body?.name,
        refText: req.body?.refText,
      });
      res.json({ ok: true, profile });
    } catch (e) {
      res.status(404).json({ ok: false, error: e.message });
    }
  });

  app.delete('/api/voice/profiles/:id', (req, res) => {
    try {
      const result = voiceProfiles.deleteProfile(req.params.id);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(404).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/voice/profiles/:id/ref', (req, res) => {
    try {
      const refPath = voiceProfiles.getRefAudioPath(req.params.id);
      if (!refPath) return res.status(404).json({ ok: false, error: 'Reference audio not found' });
      const ext = path.extname(refPath).toLowerCase();
      const mime =
        ext === '.wav' ? 'audio/wav'
        : ext === '.webm' ? 'audio/webm'
        : ext === '.mp3' ? 'audio/mpeg'
        : ext === '.m4a' ? 'audio/mp4'
        : 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      const stream = fs.createReadStream(refPath);
      stream.on('error', () => {
        if (!res.headersSent) res.status(404).json({ ok: false, error: 'Reference audio not found' });
      });
      stream.pipe(res);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/voice/setup', (_req, res) => {
    res.json({ ok: true, ...voiceSidecarManager.getSetupStatus() });
  });

  app.post('/api/voice/setup/start', async (_req, res) => {
    res.status(410).json({
      ok: false,
      error: 'CosyVoice clone setup has been removed. Use EdgeTTS in Voice settings.',
      ...voiceSidecarManager.getSetupStatus(),
    });
  });

  app.post('/api/voice/setup/retry', async (_req, res) => {
    res.status(410).json({
      ok: false,
      error: 'CosyVoice clone setup has been removed. Use EdgeTTS in Voice settings.',
      ...voiceSidecarManager.getSetupStatus(),
    });
  });

  app.get('/api/voice/api-preferences', (req, res) => {
    try {
      const { ownerKey } = ownerFromReq(req);
      const prefs = voiceApiPrefs.getPreferences(ownerKey);
      res.json({
        ok: true,
        preferences: prefs,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.patch('/api/voice/api-preferences', (req, res) => {
    try {
      const { ownerKey } = ownerFromReq(req);
      const body = req.body || {};
      const prefs = voiceApiPrefs.setPreferences(ownerKey, {
        sttApiKey: body.sttApiKey,
        openaiSttModel: body.openaiSttModel,
        clearSttKey: body.clearSttKey === true,
      });
      res.json({
        ok: true,
        preferences: prefs,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/transcribe', upload.single('audio'), async (req, res) => {
    try {
      const file = req.file;
      if (!file?.buffer?.length) {
        return res.status(400).json({ ok: false, error: 'audio file is required' });
      }
      const { ownerKey } = ownerFromReq(req);
      const resolved = voiceApiPrefs.resolveSttApiKey(ownerKey, req.body?.openaiApiKey);
      const sttModel =
        String(req.body?.openaiSttModel || '').trim() || voiceApiPrefs.getSttModel(ownerKey);
      const result = await transcribeAudio(file.buffer, file.originalname, file.mimetype, {
        apiKey: resolved.apiKey,
        openaiSttModel: sttModel,
        keySource: resolved.source,
        language: String(req.body?.language || '').trim() || undefined,
        prompt: String(req.body?.prompt || '').trim() || undefined,
      });
      if (result.ok) return res.json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/synthesize', async (req, res) => {
    try {
      const { text, profileId, engine, voice, rate, apiKey, voiceId } = req.body || {};
      const result = await synthesizeSpeech({
        text,
        profileId,
        engine,
        voice,
        rate,
        apiKey,
        voiceId,
      });
      if (result.ok) {
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('X-Voice-Engine', result.engine);
        if (result.timings) res.setHeader('X-Voice-Timing', JSON.stringify(result.timings));
        return res.send(result.buffer);
      }
      if (result.fallback) {
        return res.status(200).json(result);
      }
      res.status(503).json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Fish Audio blocks browser CORS — proxy via Node → Python alt-tts sidecar.
  app.post('/api/voice/tts/fishaudio', async (req, res) => {
    try {
      const { text, apiKey, referenceId, latency } = req.body || {};
      const result = await synthesizeFishAudio({ text, apiKey, referenceId, latency });
      if (result.ok) {
        res.setHeader('Content-Type', result.contentType || 'audio/mpeg');
        res.setHeader('X-Voice-Engine', 'fishaudio');
        return res.send(result.buffer);
      }
      res.status(503).json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // OpenAI TTS — server resolves key (voice override → OpenClaw onboarding key).
  app.post('/api/voice/tts/openai', async (req, res) => {
    try {
      const { ownerKey } = ownerFromReq(req);
      const body = req.body || {};
      const result = await synthesizeOpenAiSpeech({
        text: body.text,
        voice: body.voice,
        model: body.model,
        ownerKey,
        apiKey: body.openaiApiKey,
      });
      if (result.ok) {
        res.setHeader('Content-Type', result.contentType || 'audio/mpeg');
        res.setHeader('X-Voice-Engine', 'openai');
        if (result.keySource) res.setHeader('X-Voice-Key-Source', result.keySource);
        return res.send(result.buffer);
      }
      res.status(503).json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/voice/listener/status', async (_req, res) => {
    try {
      const config = voiceListenerManager.getListenerConfig();
      let health = await voiceListenerManager.probeListenerHealth(1500);
      if (!health.up && config.globalListenEnabled) {
        voiceListenerManager.ensureListenerSidecarAsync().catch((e) => {
          console.warn('[voice/listener] auto-restart failed:', e.message);
        });
        health = await voiceListenerManager.probeListenerHealth(800, { force: true });
      }
      res.json({
        ok: true,
        health,
        config,
        starting: !health.up && config.globalListenEnabled,
      });
    } catch (e) {
      console.warn('[voice/listener] status error:', e.message);
      res.json({
        ok: false,
        health: { up: false, ready: false },
        config: voiceListenerManager.getListenerConfig(),
        error: e.message,
      });
    }
  });

  app.get('/api/voice/listener/devices', async (_req, res) => {
    try {
      const health = await voiceListenerManager.probeListenerHealth(2000);
      if (!health.up) {
        return res.json({ ok: false, devices: [], error: 'listener down' });
      }
      const r = await fetch(`${voiceListenerManager.LISTENER_URL}/devices`);
      const data = await r.json();
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, devices: [] });
    }
  });

  app.post('/api/voice/listener/config', async (req, res) => {
    try {
      const config = voiceListenerManager.updateListenerConfig(req.body || {});
      if (config.globalListenEnabled) {
        voiceListenerManager.ensureListenerSidecarAsync().catch(() => {});
      }
      res.json({ ok: true, config });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/listener/mode', async (req, res) => {
    try {
      const mode = req.body?.mode;
      const data = await voiceListenerManager.setListenerMode(mode);
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/listener/wake', async (req, res) => {
    try {
      const source = String(req.body?.source || 'api').trim() || 'api';
      console.log('[summon] manual wake request', { source });
      const health = await voiceListenerManager.probeListenerHealth();
      if (health.up) {
        await fetch(`${voiceListenerManager.LISTENER_URL}/wake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      }
      const data = await voiceListenerManager.setListenerMode('active');
      const event = voiceListenerManager.publishListenerEvent({
        type: 'wake',
        mode: 'active',
        source,
      });
      console.log('[summon] manual wake published', event);
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/listener/speaking', async (req, res) => {
    try {
      await setListenerSpeaking(!!req.body?.speaking, !!req.body?.bargeIn);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/listener/standup-playback', async (req, res) => {
    try {
      const { active, deliverableId, sectionIndex, interrupted } = req.body || {};
      if (!active) {
        voiceListenerManager.clearStandupPlaybackState();
        return res.json({ ok: true, playback: voiceListenerManager.getStandupPlaybackState() });
      }
      const state = voiceListenerManager.setStandupPlaybackState({
        active: true,
        deliverableId: deliverableId || null,
        sectionIndex: Number.isFinite(sectionIndex) ? sectionIndex : 0,
        interrupted: !!interrupted,
      });
      res.json({ ok: true, playback: state });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/listener/event', async (req, res) => {
    try {
      const out = await handleListenerEvent(req.body || {});
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/voice/wake-clips', (_req, res) => {
    try {
      res.json({ ok: true, clips: wakeClipsStore.listClips() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/wake-clips', upload.single('audio'), (req, res) => {
    try {
      const file = req.file;
      if (!file?.buffer?.length) {
        return res.status(400).json({ ok: false, error: 'audio file is required' });
      }
      const clip = wakeClipsStore.createClip({
        phrase: req.body?.phrase,
        buffer: file.buffer,
        mimeType: file.mimetype,
        originalName: file.originalname,
      });
      res.json({ ok: true, clip });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.delete('/api/voice/wake-clips/:id', (req, res) => {
    try {
      res.json(wakeClipsStore.deleteClip(req.params.id));
    } catch (e) {
      res.status(404).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/voice/wake-clips/:id/audio', (req, res) => {
    try {
      const audioPath = wakeClipsStore.getClipAudioPath(req.params.id);
      if (!audioPath) return res.status(404).json({ ok: false, error: 'clip not found' });
      const ext = path.extname(audioPath).toLowerCase();
      const mime =
        ext === '.wav' ? 'audio/wav'
        : ext === '.webm' ? 'audio/webm'
        : ext === '.mp3' ? 'audio/mpeg'
        : 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      fs.createReadStream(audioPath).pipe(res);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/voice/listener/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (payload) => { res.write(`data: ${JSON.stringify(payload)}\n\n`); };
    send({ type: 'connected', at: Date.now() });
    const unsubscribe = voiceListenerManager.subscribeListenerEvents(send);
    const heartbeat = setInterval(() => { res.write(': ping\n\n'); }, 25000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  voiceDebug.registerVoiceDebugRoutes(app);
}

module.exports = {
  registerVoiceRoutes,
  getVoiceStatus,
  transcribeAudio,
  synthesizeSpeech,
  handleListenerEvent,
  setListenerSpeaking,
};
