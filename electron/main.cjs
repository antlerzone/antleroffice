const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');

const PORT = Number(process.env.PORT) || 3020;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const isDev = process.env.ELECTRON_DEV === '1';

function readDevPort() {
  if (process.env.DEV_PORT) return Number(process.env.DEV_PORT) || 3001;
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^DEV_PORT=(\d+)/m);
    if (match) return Number(match[1]) || 3001;
  } catch {
    /* no .env */
  }
  return 3001;
}

const DEV_PORT = readDevPort();
const DEV_URL = `http://127.0.0.1:${DEV_PORT}`;
/** Dev loads Vite (live source); production loads backend static dist on PORT. */
function appBaseUrl() {
  return isDev ? DEV_URL : SERVER_URL;
}

let mainWindow = null;
let tray = null;
let serverProcess = null;
let pendingAuthUrl = null;

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
  return waitForHttp(`${DEV_URL}/`, timeoutMs);
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

function attachNavigationGuards(win) {
  function isInAppUrl(raw) {
    try {
      const u = new URL(raw);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
      const port = u.port || (u.protocol === 'https:' ? '443' : '80');
      if (port === String(PORT)) return true;
      if (isDev && port === String(DEV_PORT)) return true;
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open AntlerOffice', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]),
  );
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
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const proto = extractProtocolUrl(argv);
    if (proto) handleAuthProtocol(proto);
    mainWindow?.show();
    mainWindow?.focus();
  });

  app.whenReady().then(async () => {
    registerAntlerofficeProtocol();

    // Dev: backend runs via `npm run dev:electron` (system Node). Packaged: spawn from Electron.
    if (!isDev) startServer();
    try {
      await waitForServer();
      if (isDev) {
        await waitForVite();
        console.log(`[AntlerOffice] Dev UI at ${DEV_URL} (API proxy → ${SERVER_URL})`);
      }
    } catch (e) {
      console.error('[AntlerOffice] Server failed to start:', e.message);
    }
    createWindow();
    createTray();
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
  });

  app.on('window-all-closed', (e) => {
    e.preventDefault();
  });
}
