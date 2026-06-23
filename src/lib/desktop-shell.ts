/** Open URLs in the user's default browser (Chrome when set as default). */
export function openExternalUrl(url: string) {
  const desktop = (window as Window & { antlerDesktop?: { openExternal?: (u: string) => Promise<void> } })
    .antlerDesktop
  if (desktop?.openExternal) {
    void desktop.openExternal(url)
    return
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (!opened) window.location.assign(url)
}

export function isElectronApp() {
  return !!(window as Window & { antlerDesktop?: { isElectron?: boolean } }).antlerDesktop?.isElectron
}

/** Chrome / Edge on localhost — same API stack as Electron, without the desktop shell. */
export function isLocalDevHost() {
  if (typeof window === 'undefined') return false
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1'
}

/**
 * Voice summon + listener sidecar work on Electron and on localhost dev (Chrome).
 * Production website embed does not run the Python listener.
 */
export function isSummonHost() {
  return isElectronApp() || isLocalDevHost()
}

export function showItemInFolder(filePath: string) {
  const desktop = (
    window as Window & { antlerDesktop?: { showItemInFolder?: (p: string) => Promise<void> } }
  ).antlerDesktop
  if (desktop?.showItemInFolder) {
    void desktop.showItemInFolder(filePath)
  }
}
