const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('antlerDesktop', {
  platform: process.platform,
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  approveUpdate: () => ipcRenderer.invoke('updater:approve'),
  scheduleUpdate: (isoTime, preApproved = false) =>
    ipcRenderer.invoke('updater:schedule', { isoTime, preApproved }),
  skipUpdateVersion: (version) => ipcRenderer.invoke('updater:skip', version),
  remindLater: (minutes = 60) => ipcRenderer.invoke('updater:remind-later', minutes),
  onUpdateStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('updater:status', handler);
    return () => ipcRenderer.removeListener('updater:status', handler);
  },
});
