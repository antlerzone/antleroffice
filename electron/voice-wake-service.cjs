const SERVER_URL = process.env.SERVER_URL || `http://127.0.0.1:${process.env.PORT || 3020}`;

function createVoiceWakeService({ ipcMain, getMainWindow, getTray, onStateChange }) {
  let voiceWakeState = { mode: 'sleep', listening: false };

  async function postJson(path, body) {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.json().catch(() => ({}));
  }

  async function syncListenerMode(mode) {
    try {
      await postJson('/api/voice/listener/mode', { mode });
    } catch {
      /* ignore */
    }
  }

  function broadcastState() {
    const win = getMainWindow();
    win?.webContents.send('voiceWake:state', voiceWakeState);
    onStateChange?.(voiceWakeState);
    updateTrayMenu();
  }

  function updateTrayMenu() {
    const tray = getTray?.();
    if (!tray) return;
    const { Menu } = require('electron');
    const modeLabel =
      voiceWakeState.mode === 'active' ? 'Voice: Active (listening)' : 'Voice: Sleep (wake word)';
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open AntlerOffice', click: () => getMainWindow()?.show() },
        { type: 'separator' },
        {
          label: modeLabel,
          enabled: false,
        },
        {
          label: 'Wake / Go Active',
          click: async () => {
            voiceWakeState = { ...voiceWakeState, mode: 'active' };
            await postJson('/api/voice/listener/wake', {});
            await syncListenerMode('active');
            broadcastState();
          },
        },
        {
          label: 'Sleep (wake word only)',
          click: async () => {
            voiceWakeState = { ...voiceWakeState, mode: 'sleep' };
            await syncListenerMode('sleep');
            broadcastState();
          },
        },
        {
          label: 'Open Settings',
          click: () => {
            const win = getMainWindow();
            win?.show();
            win?.focus();
            win?.webContents.send('voiceWake:openSettings');
          },
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            const { app } = require('electron');
            app.isQuitting = true;
            app.quit();
          },
        },
      ]),
    );
    const tip =
      voiceWakeState.mode === 'active'
        ? 'AntlerOffice — listening'
        : 'AntlerOffice — wake word';
    tray.setToolTip(tip);
  }

  ipcMain.handle('voiceWake:getStatus', async () => ({ ok: true, state: voiceWakeState }));

  ipcMain.handle('voiceWake:setMode', async (_e, mode) => {
    if (mode !== 'sleep' && mode !== 'active') return { ok: false };
    voiceWakeState = { ...voiceWakeState, mode };
    await syncListenerMode(mode);
    broadcastState();
    return { ok: true };
  });

  ipcMain.handle('voiceWake:wake', async () => {
    voiceWakeState = { ...voiceWakeState, mode: 'active' };
    await postJson('/api/voice/listener/wake', {});
    await syncListenerMode('active');
    broadcastState();
    return { ok: true };
  });

  return {
    getState: () => voiceWakeState,
    updateTrayMenu,
    broadcastState,
  };
}

module.exports = { createVoiceWakeService };
