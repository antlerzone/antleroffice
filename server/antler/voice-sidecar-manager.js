const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const store = require('./store');
const voiceGpu = require('./voice-gpu-check');

const execFileAsync = promisify(execFile);

const TTS_PORT = Number(process.env.VOICE_TTS_PORT || process.env.VOICE_QWEN_PORT) || 8765;
const TTS_HOST = process.env.VOICE_TTS_HOST || process.env.VOICE_QWEN_HOST || '127.0.0.1';
const TTS_URL = (process.env.VOICE_TTS_URL || process.env.VOICE_QWEN_URL || `http://${TTS_HOST}:${TTS_PORT}`).replace(
  /\/+$/,
  '',
);

const ALT_TTS_PORT = Number(process.env.VOICE_ALT_TTS_PORT) || 8766;
const ALT_TTS_HOST = process.env.VOICE_ALT_TTS_HOST || '127.0.0.1';
const ALT_TTS_URL = (process.env.VOICE_ALT_TTS_URL || `http://${ALT_TTS_HOST}:${ALT_TTS_PORT}`).replace(/\/+$/, '');

const COSYVOICE_REPO = 'https://github.com/FunAudioLLM/CosyVoice.git';
const COSYVOICE_MODEL = process.env.COSYVOICE_MODEL || 'FunAudioLLM/Fun-CosyVoice3-0.5B-2512';

let ttsProcess = null;
let altTtsProcess = null;
let altTtsSetupPromise = null;
let setupPromise = null;
const recentLogs = [];
const MAX_LOG_LINES = 120;

function pushLog(line, level = 'info') {
  const entry = { at: Date.now(), level, line: String(line || '').trim() };
  if (!entry.line) return;
  recentLogs.push(entry);
  while (recentLogs.length > MAX_LOG_LINES) recentLogs.shift();
}

function getRecentLogs(limit = 80) {
  return recentLogs.slice(-limit);
}

function loadPersistedState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const data = JSON.parse(raw);
    if (data.phase) setupState.phase = data.phase;
    if (data.message) setupState.message = data.message;
    if (data.error) setupState.error = data.error;
  } catch {
    /* no prior state */
  }
}

const setupState = {
  phase: 'idle',
  message: '',
  error: null,
  startedAt: null,
  updatedAt: null,
};

function runtimeRoot() {
  return path.join(store.getDataDir(), 'voice-runtime');
}

function cosyvoiceRepoDir() {
  return path.join(runtimeRoot(), 'CosyVoice');
}

function modelCacheDir() {
  const dir = path.join(store.getDataDir(), 'voice-models', 'cosyvoice');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath() {
  return path.join(runtimeRoot(), 'state.json');
}

function venvDir() {
  return path.join(runtimeRoot(), 'venv');
}

function venvPython() {
  return process.platform === 'win32'
    ? path.join(venvDir(), 'Scripts', 'python.exe')
    : path.join(venvDir(), 'bin', 'python3');
}

function bundledSidecarRoot() {
  if (process.env.VOICE_SIDECAR_ROOT && fs.existsSync(process.env.VOICE_SIDECAR_ROOT)) {
    return process.env.VOICE_SIDECAR_ROOT;
  }
  const candidates = [
    path.join(process.resourcesPath || '', 'voice-sidecar'),
    path.join(__dirname, '..', 'voice-sidecar'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'cosyvoice_server.py'))) return p;
  }
  return candidates[1];
}

function sidecarScript() {
  return path.join(bundledSidecarRoot(), 'cosyvoice_server.py');
}

function setupScript() {
  return path.join(bundledSidecarRoot(), 'setup_cosyvoice.py');
}

function cosyvoiceReadyMarker() {
  return path.join(cosyvoiceRepoDir(), 'cosyvoice', 'cli', 'cosyvoice.py');
}

function persistState() {
  try {
    fs.mkdirSync(runtimeRoot(), { recursive: true });
    fs.writeFileSync(
      statePath(),
      JSON.stringify(
        {
          ...setupState,
          engine: 'cosyvoice',
          ttsPort: TTS_PORT,
          ttsUrl: TTS_URL,
          bundledRoot: bundledSidecarRoot(),
          cosyvoiceRepo: cosyvoiceRepoDir(),
          savedAt: Date.now(),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    /* ignore */
  }
}

function setPhase(phase, message, error = null) {
  setupState.phase = phase;
  setupState.message = message || '';
  setupState.error = error;
  setupState.updatedAt = Date.now();
  if (!setupState.startedAt && phase !== 'idle') setupState.startedAt = Date.now();
  persistState();
}

async function probeHealth(timeoutMs = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${TTS_URL}/health`, { signal: ctrl.signal });
    if (!res.ok) return { up: false, ready: false };
    const data = await res.json().catch(() => ({}));
    return { up: true, ready: data.ready === true, data };
  } catch {
    return { up: false, ready: false };
  } finally {
    clearTimeout(timer);
  }
}

async function pythonVersionOk(exe) {
  try {
    const { stdout } = await execFileAsync(
      exe,
      ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],
      { timeout: 8000, windowsHide: true },
    );
    const [maj, min] = String(stdout || '').trim().split('.').map(Number);
    return maj === 3 && min >= 10 && min <= 12;
  } catch {
    return false;
  }
}

async function findSystemPython() {
  const localApp = process.env.LOCALAPPDATA || '';
  const fixedCandidates = [
    path.join(localApp, 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(localApp, 'Programs', 'Python', 'Python311', 'python.exe'),
    path.join(localApp, 'Programs', 'Python', 'Python310', 'python.exe'),
  ];
  for (const exe of fixedCandidates) {
    if (fs.existsSync(exe) && (await pythonVersionOk(exe))) return exe;
  }

  const cmds =
    process.platform === 'win32'
      ? [
          ['py', ['-3.12', '-c', 'import sys; print(sys.executable)']],
          ['py', ['-3.11', '-c', 'import sys; print(sys.executable)']],
          ['py', ['-3.10', '-c', 'import sys; print(sys.executable)']],
        ]
      : [
          ['python3.12', ['-c', 'import sys; print(sys.executable)']],
          ['python3.11', ['-c', 'import sys; print(sys.executable)']],
          ['python3.10', ['-c', 'import sys; print(sys.executable)']],
        ];
  for (const [cmd, args] of cmds) {
    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 8000, windowsHide: true });
      const exe = String(stdout || '').trim();
      if (exe && fs.existsSync(exe) && (await pythonVersionOk(exe))) return exe;
    } catch {
      /* try next */
    }
  }
  return null;
}

function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: opts.inherit ? 'inherit' : 'pipe',
      windowsHide: true,
      ...opts,
    });
    let stderr = '';
    if (!opts.inherit && child.stderr) {
      child.stderr.on('data', (c) => {
        stderr += c.toString();
      });
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ code, stderr });
      else reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
    });
  });
}

async function ensureGitAvailable() {
  try {
    await runProcess('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

async function ensureCosyVoiceSource() {
  const repoDir = cosyvoiceRepoDir();
  if (fs.existsSync(cosyvoiceReadyMarker())) return repoDir;

  const hasGit = await ensureGitAvailable();
  if (!hasGit) {
    throw new Error(
      'Git is required to install CosyVoice. Install Git for Windows from https://git-scm.com/ then retry setup.',
    );
  }

  fs.mkdirSync(runtimeRoot(), { recursive: true });
  if (fs.existsSync(repoDir)) {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      /* continue */
    }
  }

  setPhase('installing_deps', 'Downloading CosyVoice source (first run)');
  await runProcess('git', ['clone', '--depth', '1', COSYVOICE_REPO, repoDir], { inherit: true });
  setPhase('installing_deps', 'Downloading CosyVoice submodules');
  await runProcess('git', ['submodule', 'update', '--init', '--depth', '1', 'third_party/Matcha-TTS'], {
    cwd: repoDir,
    inherit: true,
  });

  const matchaPkg = path.join(repoDir, 'third_party', 'Matcha-TTS', 'matcha', '__init__.py');
  if (!fs.existsSync(matchaPkg)) {
    const matchaDir = path.join(repoDir, 'third_party', 'Matcha-TTS');
    try {
      fs.rmSync(matchaDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    setPhase('installing_deps', 'Downloading Matcha-TTS dependency');
    await runProcess(
      'git',
      ['clone', '--depth', '1', 'https://github.com/shivammehta25/Matcha-TTS.git', matchaDir],
      { inherit: true },
    );
  }
  if (!fs.existsSync(matchaPkg)) {
    throw new Error('Matcha-TTS install incomplete — matcha module not found');
  }

  if (!fs.existsSync(cosyvoiceReadyMarker())) {
    throw new Error('CosyVoice source install incomplete — cosyvoice module not found');
  }
  return repoDir;
}

async function ensurePip(py) {
  try {
    await runProcess(py, ['-m', 'pip', '--version']);
    return;
  } catch {
    /* bootstrap pip */
  }
  setPhase('creating_venv', 'Bootstrapping pip in Python environment');
  await runProcess(py, ['-m', 'ensurepip', '--upgrade'], { inherit: true });
  await runProcess(py, ['-m', 'pip', '--version']);
}

async function ensureVenv(basePython) {
  const py = venvPython();
  if (!fs.existsSync(py)) {
    setPhase('creating_venv', 'Creating Python environment for CosyVoice');
    fs.mkdirSync(runtimeRoot(), { recursive: true });
    await runProcess(basePython, ['-m', 'venv', venvDir()], { cwd: runtimeRoot() });
    if (!fs.existsSync(py)) throw new Error('Failed to create Python venv');
  }
  await ensurePip(py);
  return py;
}

async function installTorch(py) {
  const gpu = await voiceGpu.checkGpuForVoiceClone();
  if (gpu.meetsRequirements) {
    setPhase('installing_deps', 'Installing PyTorch with CUDA (GPU acceleration)');
    await runProcess(
      py,
      [
        '-m',
        'pip',
        'install',
        'torch==2.3.1',
        'torchaudio==2.3.1',
        '--index-url',
        'https://download.pytorch.org/whl/cu121',
      ],
      { inherit: true },
    );
    return;
  }
  setPhase('installing_deps', 'Installing PyTorch (CPU)');
  await runProcess(py, ['-m', 'pip', 'install', 'torch==2.3.1', 'torchaudio==2.3.1'], { inherit: true });
}

async function pipInstall(py) {
  const setupPy = setupScript();
  if (!fs.existsSync(setupPy)) throw new Error(`Missing setup script: ${setupPy}`);

  setPhase('installing_deps', 'Installing CosyVoice (first run may take several minutes)');
  const repoDir = await ensureCosyVoiceSource();
  await installTorch(py);
  await runProcess(py, [setupPy], {
    inherit: true,
    env: { ...process.env, COSYVOICE_REPO_DIR: repoDir },
  });
}

function startCosyVoiceProcess(py) {
  if (ttsProcess) return;
  const script = sidecarScript();
  if (!fs.existsSync(script)) throw new Error(`Sidecar script not found: ${script}`);

  const repoDir = cosyvoiceRepoDir();
  if (!fs.existsSync(cosyvoiceReadyMarker())) {
    throw new Error('CosyVoice source not installed — run setup first');
  }

  setPhase('starting', 'Starting CosyVoice engine (downloading model on first run)');

  const env = {
    ...process.env,
    VOICE_TTS_PORT: String(TTS_PORT),
    VOICE_TTS_HOST: TTS_HOST,
    COSYVOICE_ROOT: repoDir,
    COSYVOICE_MODEL,
    COSYVOICE_MODEL_CACHE: modelCacheDir(),
    PYTHONUNBUFFERED: '1',
  };

  ttsProcess = spawn(py, [script], {
    cwd: bundledSidecarRoot(),
    env,
    stdio: 'pipe',
    windowsHide: true,
  });

  ttsProcess.stdout?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) {
      console.log('[voice/cosyvoice]', line);
      pushLog(line, 'info');
    }
  });
  ttsProcess.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) {
      console.warn('[voice/cosyvoice]', line);
      pushLog(line, 'warn');
    }
  });
  ttsProcess.on('exit', (code) => {
    console.warn('[voice/cosyvoice] process exited', code);
    pushLog(`process exited with code ${code}`, 'error');
    ttsProcess = null;
    if (setupState.phase === 'running') {
      setPhase('error', 'CosyVoice engine stopped unexpectedly', `exit ${code}`);
    }
  });
}

async function waitForReady(timeoutMs = 45 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = await probeHealth(3000);
    if (health.ready) {
      setPhase('running', 'CosyVoice engine running');
      return true;
    }
    if (health.up && health.data?.phase === 'loading') {
      setPhase('starting', 'Loading CosyVoice model (first run downloads ~2–4 GB)');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Timed out waiting for CosyVoice to become ready');
}

async function ensureCosyVoiceSidecar(opts = {}) {
  const force = opts.force === true;

  if (force) {
    stopCosyVoiceSidecar();
    try {
      fs.rmSync(path.join(runtimeRoot(), '.cosyvoice-deps-installed'), { force: true });
    } catch {
      /* ignore */
    }
  }

  const existing = await probeHealth();
  if (existing.ready) {
    setPhase('running', 'CosyVoice engine running');
    return { ok: true, alreadyRunning: true };
  }

  if (ttsProcess && !force) {
    return { ok: true, starting: true };
  }

  const gpu = await voiceGpu.checkGpuForVoiceClone();
  if (!gpu.meetsRequirements) {
    setPhase('skipped_no_gpu', gpu.reason || 'GPU requirements not met');
    return { ok: false, skipped: true, reason: gpu.reason };
  }

  setPhase('finding_python', 'Locating Python for CosyVoice');
  const basePython = await findSystemPython();
  if (!basePython) {
    const err =
      'Python 3.10–3.12 not found. Install Python 3.10+ for GPU voice clone (Python 3.14 is not supported yet).';
    setPhase('error', err, err);
    return { ok: false, error: err };
  }

  const py = await ensureVenv(basePython);

  const marker = path.join(runtimeRoot(), '.cosyvoice-deps-installed');
  if (!fs.existsSync(marker) || force) {
    await pipInstall(py);
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  } else if (!fs.existsSync(cosyvoiceReadyMarker())) {
    await ensureCosyVoiceSource();
  }

  startCosyVoiceProcess(py);
  await waitForReady();
  return { ok: true };
}

function ensureCosyVoiceSidecarAsync(opts = {}) {
  if (!setupPromise || opts.force) {
    setupPromise = ensureCosyVoiceSidecar(opts)
      .catch((e) => {
        setPhase('error', e.message || String(e), e.message || String(e));
        return { ok: false, error: e.message };
      })
      .finally(() => {
        setupPromise = null;
      });
  }
  return setupPromise;
}

function getSetupStatus() {
  return {
    ...setupState,
    engine: 'cosyvoice',
    ttsUrl: TTS_URL,
    bundledRoot: bundledSidecarRoot(),
    runtimeRoot: runtimeRoot(),
    cosyvoiceRepo: cosyvoiceRepoDir(),
    processRunning: Boolean(ttsProcess),
  };
}

function stopCosyVoiceSidecar() {
  if (ttsProcess) {
    try {
      ttsProcess.kill();
    } catch {
      /* ignore */
    }
    ttsProcess = null;
  }
}

function altTtsScript() {
  return path.join(bundledSidecarRoot(), 'alt_tts_server.py');
}

async function probeAltTtsHealth(timeoutMs = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ALT_TTS_URL}/health`, { signal: ctrl.signal });
    if (!res.ok) return { up: false, ready: false };
    const data = await res.json();
    return { up: true, ready: data.ready === true, data };
  } catch {
    return { up: false, ready: false };
  } finally {
    clearTimeout(timer);
  }
}

function startAltTtsProcess(py) {
  if (altTtsProcess) return;
  const script = altTtsScript();
  if (!fs.existsSync(script)) throw new Error(`Missing alt TTS script: ${script}`);
  altTtsProcess = spawn(py, [script], {
    cwd: bundledSidecarRoot(),
    env: {
      ...process.env,
      VOICE_ALT_TTS_PORT: String(ALT_TTS_PORT),
      VOICE_ALT_TTS_HOST: ALT_TTS_HOST,
      PYTHONUNBUFFERED: '1',
    },
    stdio: 'pipe',
    windowsHide: true,
  });
  altTtsProcess.stdout?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) console.log('[voice/alt-tts]', line);
  });
  altTtsProcess.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) console.warn('[voice/alt-tts]', line);
  });
  altTtsProcess.on('exit', () => {
    altTtsProcess = null;
  });
}

async function pipInstallAltTts(py) {
  const req = path.join(bundledSidecarRoot(), 'requirements-alt-tts.txt');
  if (!fs.existsSync(req)) return;
  await runProcess(py, ['-m', 'pip', 'install', '-r', req, '--quiet', '--disable-pip-version-check']);
}

async function ensureAltTtsSidecar() {
  const existing = await probeAltTtsHealth();
  if (existing.ready) return { ok: true, alreadyRunning: true };

  const py = fs.existsSync(venvPython()) ? venvPython() : await findSystemPython();
  if (!fs.existsSync(venvPython())) {
    fs.mkdirSync(runtimeRoot(), { recursive: true });
    await runProcess(py, ['-m', 'venv', venvDir()], { cwd: runtimeRoot() });
  }
  const vpy = venvPython();
  await ensurePip(vpy);
  await pipInstallAltTts(vpy);
  startAltTtsProcess(vpy);

  const started = Date.now();
  while (Date.now() - started < 60000) {
    const health = await probeAltTtsHealth();
    if (health.ready) return { ok: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Timed out waiting for alt TTS sidecar');
}

function ensureAltTtsSidecarAsync() {
  if (!altTtsSetupPromise) {
    altTtsSetupPromise = ensureAltTtsSidecar()
      .catch((e) => {
        console.warn('[voice/alt-tts] start failed:', e.message);
        return { ok: false, error: e.message };
      })
      .finally(() => {
        altTtsSetupPromise = null;
      });
  }
  return altTtsSetupPromise;
}

function bootVoiceSidecars() {
  try {
    loadPersistedState();
  } catch {
    /* ignore */
  }
  ensureCosyVoiceSidecarAsync().catch((e) => {
    console.warn('[voice] auto-start failed:', e.message);
  });
  ensureAltTtsSidecarAsync().catch(() => {});
  try {
    const voiceListenerManager = require('./voice-listener-manager');
    voiceListenerManager.bootListenerSidecar();
  } catch (e) {
    console.warn('[voice] listener boot:', e.message);
  }
}

module.exports = {
  bootVoiceSidecars,
  ensureCosyVoiceSidecar,
  ensureCosyVoiceSidecarAsync,
  ensureAltTtsSidecar,
  ensureAltTtsSidecarAsync,
  getSetupStatus,
  stopCosyVoiceSidecar,
  probeHealth,
  probeAltTtsHealth,
  getRecentLogs,
  venvPython,
  venvDir,
  runtimeRoot,
  modelCacheDir,
  sidecarScript,
  TTS_URL,
  ALT_TTS_URL,
};
