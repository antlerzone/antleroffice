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

const TYPEWHISPER_URL = (process.env.VOICE_TYPEWHISPER_URL || 'http://127.0.0.1:8978').replace(/\/+$/, '');
const TTS_URL = (process.env.VOICE_TTS_URL || process.env.VOICE_QWEN_URL || 'http://127.0.0.1:8765').replace(
  /\/+$/,
  '',
);
const ALT_TTS_URL = (process.env.VOICE_ALT_TTS_URL || 'http://127.0.0.1:8766').replace(/\/+$/, '');

const MAX_REF_TEXT_CHARS = Number(process.env.VOICE_MAX_REF_TEXT_CHARS || process.env.QWEN_MAX_REF_TEXT_CHARS) || 48;

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
  const [gpu, typewhisperUp, ttsHealth, altTtsHealth, listenerHealth, setup] = await Promise.all([
    voiceGpu.checkGpuForVoiceClone(),
    probeUrl(TYPEWHISPER_URL),
    voiceSidecarManager.probeHealth(),
    voiceSidecarManager.probeAltTtsHealth(),
    voiceListenerManager.probeListenerHealth(),
    Promise.resolve(voiceSidecarManager.getSetupStatus()),
  ]);
  const ttsUp = ttsHealth.ready;
  return {
    ok: true,
    gpu,
    setup,
    stt: {
      engine: 'typewhisper',
      url: TYPEWHISPER_URL,
      available: typewhisperUp,
    },
    tts: {
      engine: 'cosyvoice',
      url: TTS_URL,
      available: ttsUp && gpu.meetsRequirements,
      sidecarRunning: ttsUp,
      sidecarUp: ttsHealth.up,
      gpuReady: gpu.meetsRequirements,
      gpuRequired: true,
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
      config: voiceListenerManager.getListenerConfig(),
    },
  };
}

async function transcribeAudio(buffer, filename, mimeType) {
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
      fallback: 'browser',
      error: e.message || 'TypeWhisper unavailable',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeAltTts({ text, engine, voice, rate }) {
  await voiceSidecarManager.ensureAltTtsSidecarAsync();
  const altUp = await probeUrl(ALT_TTS_URL);
  if (!altUp) {
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

  const timings = { startedAt: Date.now() };

  const gpuStart = Date.now();
  const gpu = await voiceGpu.checkGpuForVoiceClone();
  timings.gpuCheckMs = Date.now() - gpuStart;
  if (!gpu.meetsRequirements) {
    return {
      ok: false,
      fallback: 'webspeech',
      error: gpu.reason,
      timings,
    };
  }

  const probeStart = Date.now();
  const ttsUp = await probeUrl(TTS_URL);
  timings.healthProbeMs = Date.now() - probeStart;
  if (!ttsUp) {
    return {
      ok: false,
      fallback: 'webspeech',
      error: 'CosyVoice sidecar is not running',
      timings,
    };
  }

  const activeId = profileId || voiceProfiles.getActiveProfile()?.id;
  const profile = activeId ? voiceProfiles.getProfile(activeId) : null;
  let refPath = activeId ? voiceProfiles.getRefAudioPath(activeId) : null;
  if (!refPath) {
    return {
      ok: false,
      fallback: 'webspeech',
      error: 'No voice profile configured',
      timings,
    };
  }

  const wavStart = Date.now();
  try {
    const profileDir = path.dirname(refPath);
    const webmPath = path.join(profileDir, 'ref.webm');
    const sourcePath = fs.existsSync(webmPath) ? webmPath : refPath;
    refPath = await voiceAudioUtils.ensureWavRef(sourcePath);
    if (activeId) voiceProfiles.updateRefFile(activeId, path.basename(refPath));
  } catch (e) {
    return {
      ok: false,
      fallback: 'webspeech',
      error: `Reference audio conversion failed: ${e.message}`,
      timings,
    };
  }
  timings.wavConvertMs = Date.now() - wavStart;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300000);
  const synthStart = Date.now();
  try {
    const res = await fetch(`${TTS_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: trimmed,
        ref_audio: refPath,
        profile_id: activeId,
        ref_text: trimRefTextForClone(profile?.refText),
      }),
      signal: ctrl.signal,
    });
    timings.sidecarSynthMs = Date.now() - synthStart;
    timings.totalMs = Date.now() - timings.startedAt;
    const sidecarMs = res.headers.get('x-synth-ms');
    if (sidecarMs) timings.sidecarReportedMs = Number(sidecarMs);

    if (!res.ok) {
      let errText = await res.text().catch(() => '');
      try {
        const parsed = JSON.parse(errText);
        errText = parsed.error || errText;
      } catch {
        /* keep raw */
      }
      throw new Error(errText || `CosyVoice TTS HTTP ${res.status}`);
    }
    const contentType = res.headers.get('content-type') || 'audio/wav';
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, buffer, contentType, engine: 'cosyvoice', timings };
  } catch (e) {
    timings.sidecarSynthMs = Date.now() - synthStart;
    timings.totalMs = Date.now() - timings.startedAt;
    return {
      ok: false,
      fallback: 'webspeech',
      error: e.message || 'CosyVoice synthesis failed',
      timings,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeSpeech({ text, profileId, engine, voice, rate }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Text is required');

  const chosen = String(engine || 'cosyvoice').toLowerCase();
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

function registerVoiceRoutes(app, upload) {
  const voicePersona = require('./voice-persona');

  app.get('/api/voice/persona/template', (_req, res) => {
    try {
      res.json({ ok: true, template: voicePersona.getJarvisTemplate() });
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

  app.patch('/api/voice/profiles/active', (req, res) => {
    try {
      const id = req.body?.profileId || null;
      const activeProfileId = voiceProfiles.setActiveProfile(id);
      res.json({ ok: true, activeProfileId });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
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
    try {
      voiceSidecarManager.ensureCosyVoiceSidecarAsync({ force: false });
      res.json({ ok: true, ...voiceSidecarManager.getSetupStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/setup/retry', async (_req, res) => {
    try {
      voiceSidecarManager.ensureCosyVoiceSidecarAsync({ force: true });
      res.json({ ok: true, ...voiceSidecarManager.getSetupStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/transcribe', upload.single('audio'), async (req, res) => {
    try {
      const file = req.file;
      if (!file?.buffer?.length) {
        return res.status(400).json({ ok: false, error: 'audio file is required' });
      }
      const result = await transcribeAudio(file.buffer, file.originalname, file.mimetype);
      if (result.ok) return res.json(result);
      res.status(503).json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/synthesize', async (req, res) => {
    try {
      const { text, profileId, engine, voice, rate } = req.body || {};
      const result = await synthesizeSpeech({ text, profileId, engine, voice, rate });
      if (result.ok) {
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('X-Voice-Engine', result.engine);
        if (result.timings) {
          res.setHeader('X-Voice-Timing', JSON.stringify(result.timings));
        }
        return res.send(result.buffer);
      }
      res.status(503).json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/command', async (req, res) => {
    try {
      const { text, threadId, honorific, personaEnabled, personaPrompt, ownerKey, ownerName } = req.body || {};
      const config = voiceListenerManager.getListenerConfig();
      const result = await voiceCommandService.runVoiceCommand({
        text,
        threadId,
        ownerKey: ownerKey || config.ownerKey,
        ownerName: ownerName || config.ownerName,
        honorific: honorific || config.honorific,
        personaEnabled: personaEnabled ?? config.personaEnabled,
        personaPrompt: personaPrompt || config.personaPrompt,
        agentId: 'main',
      });
      if (!result.ok) return res.status(503).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/voice/listener/status', async (_req, res) => {
    try {
      const health = await voiceListenerManager.probeListenerHealth();
      res.json({
        ok: true,
        health,
        config: voiceListenerManager.getListenerConfig(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
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

  app.post('/api/voice/listener/wake', async (_req, res) => {
    try {
      const health = await voiceListenerManager.probeListenerHealth();
      if (health.up) {
        await fetch(`${voiceListenerManager.LISTENER_URL}/wake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      }
      const data = await voiceListenerManager.setListenerMode('active');
      voiceListenerManager.publishListenerEvent({ type: 'wake', mode: 'active' });
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

    const send = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send({ type: 'connected', at: Date.now() });
    const unsubscribe = voiceListenerManager.subscribeListenerEvents(send);

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
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
