const OFFICE_WEB_URL =
  import.meta.env.VITE_OFFICE_WEB_URL?.replace(/\/+$/, '') || 'https://office.antlerzone.com'

export function officeWebUrl(path = '') {
  const p = path.startsWith('/') ? path : `/${path}`
  return `${OFFICE_WEB_URL}${p}`
}

export function desktopReturnUrl() {
  if (typeof window === 'undefined') return 'http://127.0.0.1:3020/auth/desktop-complete'
  return `${window.location.origin}/auth/desktop-complete`
}

export function buildDesktopSignInUrl() {
  const params = new URLSearchParams({
    signin: '1',
    desktop: '1',
    return: desktopReturnUrl(),
  })
  return officeWebUrl(`/?${params.toString()}`)
}

export function buildDesktopSignUpUrl() {
  const params = new URLSearchParams({
    signin: '1',
    mode: 'signup',
    desktop: '1',
    return: desktopReturnUrl(),
  })
  return officeWebUrl(`/?${params.toString()}`)
}

/** Top-up credits on the AntlerZone office web app. */
export function buildOfficeAddCreditUrl() {
  return officeWebUrl('/credits')
}

/** Opens office.antlerzone.com with desktop handoff, then auto-starts Google/Facebook OAuth in the browser. */
export function buildDesktopOAuthUrl(provider: 'google' | 'facebook') {
  const params = new URLSearchParams({
    signin: '1',
    desktop: '1',
    return: desktopReturnUrl(),
    oauth: provider,
  })
  return officeWebUrl(`/?${params.toString()}`)
}
