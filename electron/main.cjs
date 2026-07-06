const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');

const PORT = Number(process.env.PORT) || 3020;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const isDev = process.env.ELECTRON_DEV === '1';

function readDevPort() {
  if (process.env.DEV_PORT) return Number(process.env.DEV_PORT) || 3300;
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^DEV_PORT=(\d+)/m);
    if (match) return Number(match[1]) || 3300;
  } catch {
    /* no .env */
  }
  return 3300;
}

const DEV_PORT = readDevPort();
let resolvedDevUrl = `http://localhost:${DEV_PORT}`;
/** Dev loads Vite (live source); production loads backend static dist on PORT. */
function appBaseUrl() {
  return isDev ? resolvedDevUrl : SERVER_URL;
}

function probeAntlerVitePort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(!!data && typeof data.gateway === 'string');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function discoverViteDevUrl() {
  const candidates = [DEV_PORT, 3301, 3302, 3303, 3304, 3305];
  const seen = new Set();
  for (const port of candidates) {
    if (!port || seen.has(port)) continue;
    seen.add(port);
    if (await probeAntlerVitePort(port)) {
      return `http://localhost:${port}`;
    }
  }
  return `http://localhost:${DEV_PORT}`;
}

let mainWindow = null;
let tray = null;
let voiceWakeService = null;
let serverProcess = null;
let openclawProcess = null;
let pendingAuthUrl = null;

const OPENCLAW_GATEWAY_PORT = 18789;

function projectRoot() {
  return path.join(__dirname, '..');
}

function appIconPath() {
  const ico = path.join(projectRoot(), 'build', 'icon.ico');
  const blackPng = path.join(projectRoot(), 'public', 'antleroffice-logo-black.png');
  const buildPng = path.join(projectRoot(), 'build', 'icon.png');
  const png = path.join(projectRoot(), 'public', 'antleroffice-logo.png');
  if (fs.existsSync(ico)) return ico;
  if (fs.existsSync(blackPng)) return blackPng;
  if (fs.existsSync(buildPng)) return buildPng;
  if (fs.existsSync(png)) return png;
  return null;
}

function loadAppIcon() {
  const p = appIconPath();
  if (!p) return nativeImage.createEmpty();
  return nativeImage.createFromPath(p);
}

function envFilePath() {
  return path.join(projectRoot(), '.env');
}

function extractProtocolUrl(argv = process.argv) {
  return argv.find((a) => String(a).startsWith('antleroffice://')) || null;
}

function protocolUrlToAuthTarget(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'auth') return null;
    const accessToken = u.searchParams.get('accessToken');
    const next = u.searchParams.get('next') || '/portal';
    if (!accessToken) return null;
    return `${appBaseUrl()}/auth/desktop-complete?accessToken=${encodeURIComponent(accessToken)}&next=${encodeURIComponent(next)}`;
  } catch {
    return null;
  }
}

const startupProtocolUrl = extractProtocolUrl();
if (startupProtocolUrl) {
  const target = protocolUrlToAuthTarget(startupProtocolUrl);
  if (target) pendingAuthUrl = target;
}

function registerAntlerofficeProtocol() {
  if (process.platform === 'win32') {
    const args = process.defaultApp && process.argv.length >= 2 ? [path.resolve(process.argv[1])] : [];
    if (!app.isDefaultProtocolClient('antleroffice', process.execPath, args)) {
      app.setAsDefaultProtocolClient('antleroffice', process.execPath, args);
    }
    return;
  }
  if (!app.isDefaultProtocolClient('antleroffice')) {
    app.setAsDefaultProtocolClient('antleroffice');
  }
}

function waitForHttp(url, timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else if (Date.now() - started > timeoutMs) reject(new Error(`Timeout waiting for ${url}`));
        else setTimeout(tick, 400);
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error(`Timeout waiting for ${url}`));
        else setTimeout(tick, 400);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

function waitForServer(timeoutMs = 60000) {
  return waitForHttp(`${SERVER_URL}/api/health`, timeoutMs);
}

function waitForVite(timeoutMs = 60000) {
  return waitForHttp(`${resolvedDevUrl}/`, timeoutMs);
}

function startServer() {
  if (serverProcess) return;
  const root = projectRoot();
  const nodeBin = process.execPath;
  const serverEntry = path.join(root, 'server', 'index.js');
  const env = {
    ...process.env,
    PORT: String(PORT),
    ANTLEROFFICE_PACKAGED: '1',
    ELECTRON_RUN_AS_NODE: '1',
    VOICE_SIDECAR_ROOT: path.join(process.resourcesPath, 'voice-sidecar'),
  };
  if (fs.existsSync(envFilePath())) {
    serverProcess = spawn(nodeBin, ['--env-file', envFilePath(), serverEntry], {
      cwd: root,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
  } else {
    serverProcess = spawn(nodeBin, [serverEntry], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  }
  serverProcess.on('exit', (code) => {
    serverProcess = null;
    if (code && code !== 0) console.error('[AntlerOffice] server exited', code);
  });
}

/**
 * Returns true only if a HEALTHY OpenClaw gateway is answering on the port.
 * A live gateway also serves HTTP (canvas host) on the same port, so any HTTP
 * response means it's up. A dead/zombie listener that squats the port but
 * resets connections will error/timeout here and be treated as unhealthy.
 */
function isGatewayHealthy(port = OPENCLAW_GATEWAY_PORT, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__openclaw__/canvas/' }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

/**
 * Start the local OpenClaw gateway (ws://localhost:18789) that holds the agents
 * and data AntlerOffice connects to. Runs in both dev and packaged mode so the
 * app and its gateway come up together. Skips only if a healthy gateway already
 * answers; otherwise starts with --force to clear any dead listener on the port.
 * Requires the global openclaw CLI (npm i -g openclaw).
 */
async function startOpenClaw() {
  if (openclawProcess) return;
  if (await isGatewayHealthy()) {
    console.log(`[AntlerOffice] OpenClaw gateway already healthy on ${OPENCLAW_GATEWAY_PORT}, skipping launch.`);
    return;
  }
  try {
    console.log('[AntlerOffice] Starting OpenClaw gateway (openclaw gateway run --force)...');
    openclawProcess = spawn('openclaw gateway run --force', {
      cwd: projectRoot(),
      env: { ...process.env },
      stdio: 'inherit',
      shell: true,
      windowsHide: true,
    });
    openclawProcess.on('exit', (code) => {
      openclawProcess = null;
      if (code && code !== 0) console.error('[AntlerOffice] OpenClaw gateway exited', code);
    });
    openclawProcess.on('error', (err) => {
      openclawProcess = null;
      console.error('[AntlerOffice] Could not launch OpenClaw. Is it installed? Run: npm i -g openclaw. Detail:', err.message);
    });
  } catch (e) {
    openclawProcess = null;
    console.error('[AntlerOffice] Could not start OpenClaw:', e.message);
  }
}

/** Stop the OpenClaw gateway, but only if WE started it (leave a pre-existing one alone). */
function stopOpenClaw() {
  if (!openclawProcess) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(openclawProcess.pid), '/T', '/F'], { windowsHide: true });
    } else {
      openclawProcess.kill();
    }
  } catch { /* */ }
  openclawProcess = null;
}

function attachNavigationGuards(win) {
  function isInAppUrl(raw) {
    try {
      const u = new URL(raw);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
      const port = u.port || (u.protocol === 'https:' ? '443' : '80');
      if (port === String(PORT)) return true;
      if (isDev && port === String(new URL(resolvedDevUrl).port || DEV_PORT)) return true;
      return false;
    } catch {
      return false;
    }
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isInAppUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });
}

function createWindow() {
  const icon = loadAppIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'AntlerOffice',
    icon: icon.isEmpty() ? undefined : icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`${appBaseUrl()}/login`);
  attachNavigationGuards(mainWindow);
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  if (pendingAuthUrl) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.loadURL(pendingAuthUrl);
      pendingAuthUrl = null;
    });
  }
}

function createTray() {
  const icon = loadAppIcon();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('AntlerOffice');
  if (voiceWakeService) voiceWakeService.updateTrayMenu();
  else {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open AntlerOffice', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
      ]),
    );
  }
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

function handleAuthProtocol(url) {
  const target = protocolUrlToAuthTarget(url);
  if (!target) return;
  if (mainWindow) mainWindow.loadURL(target);
  else pendingAuthUrl = target;
  mainWindow?.show();
  mainWindow?.focus();
}

function setupUpdaterIpc() {
  let autoUpdater = null;
  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('updater:status', { type: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', () => {
      mainWindow?.webContents.send('updater:status', { type: 'none' });
    });
    autoUpdater.on('download-progress', (p) => {
      mainWindow?.webContents.send('updater:status', { type: 'progress', percent: p.percent });
    });
    autoUpdater.on('update-downloaded', (info) => {
      mainWindow?.webContents.send('updater:status', { type: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', (err) => {
      mainWindow?.webContents.send('updater:status', { type: 'error', message: err.message });
    });

    ipcMain.handle('updater:check', async () => {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, version: r?.updateInfo?.version || null };
    });
    ipcMain.handle('updater:approve', async () => {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    });
    ipcMain.handle('updater:install', async () => {
      autoUpdater.quitAndInstall();
      return { ok: true };
    });
  } catch {
    ipcMain.handle('updater:check', async () => ({ ok: false, error: 'updater unavailable in dev' }));
    ipcMain.handle('updater:approve', async () => ({ ok: false }));
    ipcMain.handle('updater:install', async () => ({ ok: false }));
  }

  ipcMain.handle('updater:schedule', async (_e, { isoTime, preApproved }) => ({ isoTime, preApproved }));
  ipcMain.handle('updater:skip', async (_e, version) => ({ skipped: version }));
  ipcMain.handle('updater:remind-later', async (_e, minutes) => ({ remindAfterMinutes: minutes }));
  ipcMain.handle('shell:openExternal', async (_e, url) => {
    if (!url || typeof url !== 'string') return { ok: false };
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) return { ok: false };
      await shell.openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
  ipcMain.handle('shell:showItemInFolder', async (_e, filePath) => {
    if (!filePath || typeof filePath !== 'string') return { ok: false };
    try {
      shell.showItemInFolder(path.resolve(filePath));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  // ── Security Worker: environment check / auto-install (Windows-first) ──────
  function runCmd(cmd, args, onData) {
    return new Promise((resolve) => {
      let out = '';
      let p;
      try {
        p = spawn(cmd, args, { shell: true, windowsHide: true });
      } catch (err) {
        return resolve({ code: -1, out: String(err) });
      }
      p.stdout?.on('data', (d) => { out += d; onData?.(String(d)); });
      p.stderr?.on('data', (d) => { out += d; onData?.(String(d)); });
      p.on('close', (code) => resolve({ code, out }));
      p.on('error', (err) => resolve({ code: -1, out: String(err) }));
    });
  }

  ipcMain.handle('env:check', async (_e, tool) => {
    const map = {
      node: ['node', ['-v']],
      appium: ['appium', ['-v']],
      adb: ['adb', ['version']],
    };
    const spec = map[tool];
    if (!spec) return { ok: false, installed: false, reason: 'unknown tool' };
    const r = await runCmd(spec[0], spec[1]);
    return {
      ok: r.code === 0,
      installed: r.code === 0,
      version: r.code === 0 ? r.out.trim().split('\n')[0] : '',
    };
  });

  ipcMain.handle('env:install', async (e, tool) => {
    const send = (line) => {
      try { e.sender.send('env:progress', { tool, line }); } catch {}
    };
    if (tool === 'appium') {
      send('npm i -g appium ...\n');
      const a = await runCmd('npm', ['i', '-g', 'appium'], send);
      if (a.code === 0) {
        send('\nappium driver install uiautomator2 ...\n');
        await runCmd('appium', ['driver', 'install', 'uiautomator2'], send);
      }
      return { ok: a.code === 0, needManual: a.code !== 0, url: 'https://appium.io/' };
    }
    if (tool === 'node') {
      send('winget install OpenJS.NodeJS.LTS ...\n');
      const r = await runCmd('winget', ['install', '-e', '--id', 'OpenJS.NodeJS.LTS'], send);
      return { ok: r.code === 0, needManual: r.code !== 0, url: 'https://nodejs.org/' };
    }
    if (tool === 'adb') {
      // 首版：给下载入口；platform-tools 全自动解压+PATH 留到后续
      const url = 'https://developer.android.com/tools/releases/platform-tools';
      try { await shell.openExternal(url); } catch {}
      return { ok: false, needManual: true, url };
    }
    if (tool === 'android_studio') {
      const url = 'https://developer.android.com/studio';
      try { await shell.openExternal(url); } catch {}
      return { ok: true, openedInstaller: true, url };
    }
    return { ok: false, reason: 'unknown tool' };
  });

  const { createVoiceWakeService } = require('./voice-wake-service.cjs');
  voiceWakeService = createVoiceWakeService({
    ipcMain,
    getMainWindow: () => mainWindow,
    getTray: () => tray,
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.error(
    isDev
      ? '[AntlerOffice] Dev Electron is already running. Close the existing window (tray -> Quit), then retry.'
      : '[AntlerOffice] Another instance is already running. Quit it, then retry.',
  );
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const proto = extractProtocolUrl(argv);
    if (proto) handleAuthProtocol(proto);
    mainWindow?.show();
    mainWindow?.focus();
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const mediaTypes = details?.mediaTypes || [];
      if (permission === 'media' && mediaTypes.includes('audio')) {
        callback(true);
        return;
      }
      if (permission === 'media' && !mediaTypes.length) {
        callback(true);
        return;
      }
      callback(false);
    });

    registerAntlerofficeProtocol();

    // Start the local OpenClaw gateway alongside the app (both dev and packaged).
    startOpenClaw();

    // Dev: backend runs via `npm run dev:electron` (system Node). Packaged: spawn from Electron.
    if (!isDev) startServer();
    try {
      await waitForServer();
      if (isDev) {
        resolvedDevUrl = await discoverViteDevUrl();
        await waitForVite();
        console.log(`[AntlerOffice] Dev UI at ${resolvedDevUrl} (API proxy -> ${SERVER_URL})`);
        if (resolvedDevUrl !== `http://localhost:${DEV_PORT}`) {
          console.warn(
            `[AntlerOffice] Port ${DEV_PORT} is not AntlerOffice - using ${resolvedDevUrl}. Free port ${DEV_PORT} or update DEV_PORT in .env.`,
          );
        }
      }
    } catch (e) {
      console.error('[AntlerOffice] Server failed to start:', e.message);
    }
    createWindow();
    createTray();
    if (voiceWakeService) voiceWakeService.updateTrayMenu();
    setupUpdaterIpc();

    if (!isDev) {
      setTimeout(() => {
        try {
          const { autoUpdater } = require('electron-updater');
          autoUpdater.checkForUpdates().catch(() => {});
        } catch { /* */ }
      }, 8000);
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleAuthProtocol(url);
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (serverProcess) {
      try { serverProcess.kill(); } catch { /* */ }
    }
    stopOpenClaw();
    try {
      const voiceSidecarManager = require(path.join(projectRoot(), 'server', 'antler', 'voice-sidecar-manager'));
      voiceSidecarManager.stopCosyVoiceSidecar();
    } catch { /* */ }
  });

  app.on('window-all-closed', (e) => {
    e.preventDefault();
  });
}
