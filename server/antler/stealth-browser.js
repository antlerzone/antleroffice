// Stealth browser entry — Line A "指纹加固" (fingerprint hardening).
//
// Why this file exists:
//   Plain Playwright leaves several tell-tale automation leaks (the
//   Runtime.enable CDP signal, a detectable closed-shadow-root, console.debug
//   hooks, etc.) that sites like reCAPTCHA / Cloudflare use to flag the browser
//   as a bot before any captcha is even shown. Patchright is a drop-in
//   replacement for Playwright that patches those leaks at the driver level, so
//   the automated browser looks like a real human's Chrome.
//
// What it does:
//   Prefer Patchright → fall back to plain Playwright → fall back to null.
//   The API surface is identical to `require('playwright')`, so every engine
//   only changes ONE line:
//       const { chromium } = require('./stealth-browser');
//   ...and all existing launch / launchPersistentContext / newContext calls
//   keep working unchanged. Falling back to null keeps the office booting even
//   before any browser dependency is installed.

let chromium = null;
let driver = 'none';

try {
  // Patchright is API-compatible with Playwright; this is the hardened path.
  ({ chromium } = require('patchright'));
  driver = 'patchright';
} catch {
  try {
    ({ chromium } = require('playwright'));
    driver = 'playwright';
  } catch {
    chromium = null;
    driver = 'none';
  }
}

// Whether the hardened (Patchright) driver is active. Engines can log this so
// the boss can see, at a glance, whether stealth is on.
const isHardened = driver === 'patchright';

// One-time visibility on startup (no-op if logging is unavailable).
try {
  if (driver === 'patchright') {
    console.log('[stealth-browser] Patchright active — fingerprint hardening ON');
  } else if (driver === 'playwright') {
    console.log('[stealth-browser] Patchright not found — using plain Playwright (no hardening). Run: npm install');
  } else {
    console.log('[stealth-browser] No browser driver installed — browser features disabled until deps are installed');
  }
} catch {
  /* logging optional */
}

// Launch args that are SAFE for the hardened path. Note: with Patchright you
// should NOT pass `--disable-blink-features=AutomationControlled` — Patchright
// masks automation itself and that flag can re-expose the very signal we're
// hiding. These two flags are always fine and just suppress first-run noise.
function hardenedArgs() {
  return ['--no-first-run', '--no-default-browser-check'];
}

// Recommended persistent-context options for a real-Chrome, low-fingerprint
// profile. Engines may opt into this for consistent hardening; pass overrides
// to tweak (extra args are merged, not replaced).
function stealthContextOptions(overrides = {}) {
  const { args: extraArgs = [], ...rest } = overrides;
  return {
    channel: 'chrome', // use the real installed Chrome, not bundled Chromium
    headless: false,
    viewport: null,
    ...rest,
    args: [...hardenedArgs(), ...extraArgs],
  };
}

module.exports = { chromium, driver, isHardened, hardenedArgs, stealthContextOptions };
