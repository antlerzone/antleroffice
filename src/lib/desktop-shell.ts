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

export function showItemInFolder(filePath: string) {
  const desktop = (
    window as Window & { antlerDesktop?: { showItemInFolder?: (p: string) => Promise<void> } }
  ).antlerDesktop
  if (desktop?.showItemInFolder) {
    void desktop.showItemInFolder(filePath)
  }
}
