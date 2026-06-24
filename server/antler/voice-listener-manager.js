const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const voiceSidecarManager = require('./voice-sidecar-manager');
const wakeClipsStore = require('./wake-clips-store');

function normalizeWakePhraseText(text) {
  return String(text || '')
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bhey\s*jarvis\b/gi, 'hey jarvis')
    .replace(/\bhi\s*jarvis\b/gi, 'hi jarvis')
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Merge phrases saved with onboarding wake clips so STT match uses recorded text. */
function mergeWakePhrasesFromClips(phrases) {
  const merged = [...(phrases || [])];
  const seen = new Set(merged.map((p) => normalizeWakePhraseText(p)).filter(Boolean));
  for (const clip of wakeClipsStore.listClips()) {
    const phrase = String(clip.phrase || '').trim();
    const key = normalizeWakePhraseText(phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(phrase);
  }
  return merged;
}

const execFileAsync = promisify(execFile);

const LISTENER_PORT = Number(process.env.VOICE_LISTENER_PORT) || 8767;
const LISTENER_HOST = process.env.VOICE_LISTENER_HOST || '127.0.0.1';
const LISTENER_URL = (process.env.VOICE_LISTENER_URL || `http://${LISTENER_HOST}:${LISTENER_PORT}`).replace(/\/+$/, '');
const SERVER_CALLBACK = (process.env.VOICE_LISTENER_CALLBACK || `http://127.0.0.1:${process.env.PORT || 3020}/api/voice/listener/event`).replace(
  /\/+$/,
  '',
);

let listenerProcess = null;
let setupPromise = null;
let cachedHealth = { up: false, ready: false };
let cachedHealthAt = 0;
let healthProbePromise = null;
const HEALTH_CACHE_MS = 1200;

const listenerConfig = {
  globalListenEnabled: true,
  wakePhrases: [],
  idleTimeoutSec: 300,
  wakeEngine: 'openwakeword',
  wakeRequireStt: false,
  sensitivity: 0.5,
  porcupineAccessKey: '',
  personaEnabled: true,
  honorific: 'boss',
  personaPrompt: '',
  replyLanguage: 'auto',
  ownerKey: 'local:boss',
  ownerName: 'Boss',
  autoDispatch: true,
  inputDeviceIndex: null,
  realtimeSessionActive: false,
  summonSessionEngaged: false,
};

const eventSubscribers = new Set();

const standupPlaybackState = {
  active: false,
  deliverableId: null,
  sectionIndex: 0,
  interrupted: false,
};

function bundledSidecarRoot() {
  if (process.env.VOICE_SIDECAR_ROOT && fs.existsSync(process.env.VOICE_SIDECAR_ROOT)) {
    return process.env.VOICE_SIDECAR_ROOT;
  }
  const candidates = [
    path.join(process.resourcesPath || '', 'voice-sidecar'),
    path.join(__dirname, '..', 'voice-sidecar'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'listener_server.py'))) return p;
  }
  return candidates[1];
}

function listenerScript() {
  return path.join(bundledSidecarRoot(), 'listener_server.py');
}

async function fetchListenerHealth(timeoutMs = 1500) {
  const now = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${LISTENER_URL}/health`, { signal: ctrl.signal });
    if (!res.ok) {
      cachedHealth = { up: false, ready: false };
      cachedHealthAt = now;
      return cachedHealth;
    }
    const data = await res.json();
    cachedHealth = { up: true, ready: data.ready === true, data };
    cachedHealthAt = now;
    return cachedHealth;
  } catch {
    cachedHealth = { up: false, ready: false, stale: cachedHealthAt > 0 };
    cachedHealthAt = now;
    return cachedHealth;
  } finally {
    clearTimeout(timer);
  }
}

async function probeListenerHealth(timeoutMs = 1500, opts = {}) {
  const force = opts.force === true;
  const now = Date.now();
  if (!force && now - cachedHealthAt < HEALTH_CACHE_MS) {
    return cachedHealth;
  }
  if (healthProbePromise) {
    return healthProbePromise;
  }
  healthProbePromise = fetchListenerHealth(timeoutMs).finally(() => {
    healthProbePromise = null;
  });
  return healthProbePromise;
}

function startListenerProcess(py) {
  if (listenerProcess) return;
  const script = listenerScript();
  if (!fs.existsSync(script)) throw new Error(`Missing listener script: ${script}`);

  listenerProcess = spawn(py, [script], {
    cwd: bundledSidecarRoot(),
    env: {
      ...process.env,
      VOICE_LISTENER_PORT: String(LISTENER_PORT),
      VOICE_LISTENER_HOST: LISTENER_HOST,
      VOICE_LISTENER_CALLBACK: SERVER_CALLBACK,
      PYTHONUNBUFFERED: '1',
      VOICE_MIC_GAIN: process.env.VOICE_MIC_GAIN || '8',
      VOICE_MAX_TOTAL_GAIN: process.env.VOICE_MAX_TOTAL_GAIN || '64',
    },
    stdio: 'pipe',
    windowsHide: true,
  });

  listenerProcess.stdout?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) console.log('[voice/listener]', line);
  });
  listenerProcess.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) console.warn('[voice/listener]', line);
  });
  listenerProcess.on('exit', () => {
    listenerProcess = null;
  });
}

function mergeDefaultWakePhrases(phrases) {
  return [...(phrases || [])].filter((p) => String(p || '').trim())
}

/** True when STT text is only wake phrases (echo / prompt bleed) — not a command. */
function isWakeOnlyPhrase(text, phrases) {
  const list = mergeDefaultWakePhrases(mergeWakePhrasesFromClips(phrases || listenerConfig.wakePhrases || []));
  let norm = normalizeWakePhraseText(text);
  if (!norm) return true;
  const sorted = [...list].map((p) => normalizeWakePhraseText(p)).filter(Boolean).sort((a, b) => b.length - a.length);
  let changed = true;
  while (changed && norm) {
    changed = false;
    for (const p of sorted) {
      if (norm === p) {
        norm = '';
        changed = true;
        break;
      }
      if (norm.startsWith(`${p} `)) {
        norm = norm.slice(p.length).trim();
        changed = true;
        break;
      }
      if (` ${norm} `.includes(` ${p} `)) {
        norm = norm.replace(new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ').replace(/\s+/g, ' ').trim();
        changed = true;
        break;
      }
    }
  }
  return !norm;
}

async function pushConfigToListener() {
  const health = await probeListenerHealth();
  if (!health.up) return false;
  const config = {
    ...listenerConfig,
    wakePhrases: mergeDefaultWakePhrases(mergeWakePhrasesFromClips(listenerConfig.wakePhrases || [])),
    realtimeSessionActive: listenerConfig.realtimeSessionActive === true,
    summonSessionEngaged: listenerConfig.summonSessionEngaged === true,
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${LISTENER_URL}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        console.log('[voice/listener] config pushed', {
          wakeBackend: config.wakeEngine,
          wakePhrases: config.wakePhrases,
          attempt,
        });
        return true;
      }
      console.warn('[voice/listener] config push HTTP', res.status, attempt);
    } catch (e) {
      console.warn('[voice/listener] config push failed:', e.message, `(attempt ${attempt})`);
    }
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  return false;
}

async function ensureListenerDeps(py) {
  const req = path.join(bundledSidecarRoot(), 'requirements-listener.txt');
  if (!fs.existsSync(req)) return;
  // Install each package individually so one failure doesn't block the rest
  const lines = fs.readFileSync(req, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  for (const pkg of lines) {
    try {
      await execFileAsync(py, ['-m', 'pip', 'install', '-q', pkg], {
        cwd: bundledSidecarRoot(),
        windowsHide: true,
      });
      console.log(`[voice/listener] installed: ${pkg}`);
    } catch (e) {
      console.warn(`[voice/listener] pip install ${pkg} failed (non-fatal):`, e.message);
    }
  }
}

async function ensureListenerSidecar() {
  const existing = await probeListenerHealth();
  if (existing.ready) {
    await pushConfigToListener();
    return { ok: true, alreadyRunning: true };
  }

  const py = fs.existsSync(voiceSidecarManager.venvPython())
    ? voiceSidecarManager.venvPython()
    : process.platform === 'win32'
      ? 'python'
      : 'python3';

  await ensureListenerDeps(py);
  startListenerProcess(py);

  const started = Date.now();
  while (Date.now() - started < 30000) {
    const health = await probeListenerHealth();
    if (health.ready) {
      await pushConfigToListener();
      return { ok: true };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Timed out waiting for voice listener');
}

function ensureListenerSidecarAsync() {
  if (!setupPromise) {
    setupPromise = ensureListenerSidecar()
      .catch((e) => {
        console.warn('[voice/listener] start failed:', e.message);
        return { ok: false, error: e.message };
      })
      .finally(() => {
        setupPromise = null;
      });
  }
  return setupPromise;
}

function updateListenerConfig(patch) {
  const next = { ...(patch || {}) };
  next.wakeEngine = 'openwakeword';
  next.wakeRequireStt = false;
  next.clapWake = false;
  if (Array.isArray(next.wakePhrases) || wakeClipsStore.listClips().length) {
    next.wakePhrases = mergeWakePhrasesFromClips(next.wakePhrases || listenerConfig.wakePhrases || []);
  }
  Object.assign(listenerConfig, next);
  cachedHealthAt = 0;
  console.log('[voice/listener] config sync', {
    wakeEngine: listenerConfig.wakeEngine,
    wakePhrases: listenerConfig.wakePhrases,
    globalListenEnabled: listenerConfig.globalListenEnabled,
    clipCount: wakeClipsStore.listClips().length,
  });
  void pushConfigToListener();
  return { ...listenerConfig };
}

function getListenerConfig() {
  return { ...listenerConfig };
}

function publishListenerEvent(event) {
  const payload = { ...event, at: Date.now() };
  if (payload.type === 'wake') {
    console.log('[summon] publish wake → SSE', {
      phrase: payload.phrase || null,
      source: payload.source || 'listener',
      mode: payload.mode || 'active',
    });
  }
  for (const fn of eventSubscribers) {
    try {
      fn(payload);
    } catch {
      /* ignore */
    }
  }
  return payload;
}

function subscribeListenerEvents(fn) {
  eventSubscribers.add(fn);
  return () => eventSubscribers.delete(fn);
}

async function setListenerMode(mode) {
  const health = await probeListenerHealth();
  if (!health.up) await ensureListenerSidecarAsync();
  try {
    const res = await fetch(`${LISTENER_URL}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json();
    publishListenerEvent({ type: 'mode', mode, state: data.state });
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function setListenerSpeaking(speaking, bargeIn = false) {
  const health = await probeListenerHealth();
  if (!health.up) return { ok: false };
  try {
    const res = await fetch(`${LISTENER_URL}/speaking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speaking: !!speaking, bargeIn: !!bargeIn }),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function getStandupPlaybackState() {
  return { ...standupPlaybackState };
}

function setStandupPlaybackState(patch = {}) {
  Object.assign(standupPlaybackState, patch || {});
  return getStandupPlaybackState();
}

function clearStandupPlaybackState() {
  standupPlaybackState.active = false;
  standupPlaybackState.deliverableId = null;
  standupPlaybackState.sectionIndex = 0;
  standupPlaybackState.interrupted = false;
  return getStandupPlaybackState();
}

function bootListenerSidecar() {
  listenerConfig.wakePhrases = mergeDefaultWakePhrases(
    mergeWakePhrasesFromClips(listenerConfig.wakePhrases || []),
  );
  if (listenerConfig.globalListenEnabled) {
    ensureListenerSidecarAsync().catch(() => {});
  }
}

module.exports = {
  LISTENER_URL,
  bootListenerSidecar,
  ensureListenerSidecar,
  ensureListenerSidecarAsync,
  probeListenerHealth,
  updateListenerConfig,
  getListenerConfig,
  publishListenerEvent,
  subscribeListenerEvents,
  setListenerMode,
  setListenerSpeaking,
  getStandupPlaybackState,
  setStandupPlaybackState,
  clearStandupPlaybackState,
  isWakeOnlyPhrase,
};
