const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const voiceSidecarManager = require('./voice-sidecar-manager');

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

const listenerConfig = {
  globalListenEnabled: true,
  wakePhrases: ['Hey Antler', 'Jarvis', '你好 Antler', '贾维斯'],
  idleTimeoutSec: 300,
  wakeEngine: 'openwakeword',
  sensitivity: 0.5,
  porcupineAccessKey: '',
  personaEnabled: true,
  honorific: 'boss',
  personaPrompt: '',
  ownerKey: 'local:boss',
  ownerName: 'Boss',
  autoDispatch: true,
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

async function probeListenerHealth(timeoutMs = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${LISTENER_URL}/health`, { signal: ctrl.signal });
    if (!res.ok) return { up: false, ready: false };
    const data = await res.json();
    return { up: true, ready: data.ready === true, data };
  } catch {
    return { up: false, ready: false };
  } finally {
    clearTimeout(timer);
  }
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

async function pushConfigToListener() {
  const health = await probeListenerHealth();
  if (!health.up) return;
  try {
    await fetch(`${LISTENER_URL}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(listenerConfig),
    });
  } catch {
    /* ignore */
  }
}

async function ensureListenerDeps(py) {
  const req = path.join(bundledSidecarRoot(), 'requirements-listener.txt');
  if (!fs.existsSync(req)) return;
  try {
    await execFileAsync(py, ['-m', 'pip', 'install', '-q', '-r', req], {
      cwd: bundledSidecarRoot(),
      windowsHide: true,
    });
  } catch (e) {
    console.warn('[voice/listener] pip install:', e.message);
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
  Object.assign(listenerConfig, patch || {});
  void pushConfigToListener();
  return { ...listenerConfig };
}

function getListenerConfig() {
  return { ...listenerConfig };
}

function publishListenerEvent(event) {
  const payload = { ...event, at: Date.now() };
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
};
