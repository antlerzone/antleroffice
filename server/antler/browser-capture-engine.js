/**
 * Browser-capture engine — generic platform login via Playwright.
 *
 * Flow:
 *   1. Call startCapture({ url, website, displayName, profileId })
 *      → Opens Chrome to the given URL (persistent profile so cookies survive across logins)
 *      → Returns a sessionId
 *   2. Boss logs in manually inside the Chrome window
 *   3. Call finishCapture(sessionId, { username?, displayName? })
 *      → Extracts all cookies from the browser context
 *      → Saves them (encrypted) to web-accounts-store as a cookie-auth account
 *      → Closes Chrome
 *      → Returns the created account alias
 *   4. Call cancelCapture(sessionId) to abort and close Chrome without saving
 *
 * Chrome profiles are stored under ~/.antleroffice2/browser-profiles/{website}_{profileId}/
 * so each account keeps its own persistent session across future automation runs.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const store = require('./store');
const webAccounts = require('./web-accounts-store');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

/** In-memory map of live capture sessions */
const _sessions = new Map(); // sessionId → { context, page, meta, startedAt, timer }

const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// ── Helpers ───────────────────────────────────────────────────────────────────

function profilesRoot() {
  const root = path.join(store.getDataDir(), 'browser-profiles');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function safeSlug(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function profileDir(website, profileId) {
  const wSlug = safeSlug(website) || 'generic';
  const pSlug = safeSlug(profileId) || randomUUID().slice(0, 8);
  return path.join(profilesRoot(), `${wSlug}_${pSlug}`);
}

function ensurePlaywright() {
  if (!chromium) {
    throw new Error(
      'Playwright is not installed. Run:\n  cd AntlerOffice2 && npm install && npx playwright install chrome',
    );
  }
}

function cookiesToString(cookies) {
  return cookies
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Open Chrome to `url` so the boss can log in manually.
 *
 * @param {object} opts
 * @param {string} opts.url           Target platform URL (e.g. "https://www.facebook.com")
 * @param {string} opts.website       Short platform key (e.g. "facebook")
 * @param {string} opts.displayName   Label for the account (e.g. "Company FB Page")
 * @param {string} [opts.profileId]   Reuse an existing Chrome profile by id; auto-generated if omitted
 * @param {string[]} [opts.allowedActions]  Actions the agent is allowed to perform with this account
 * @returns {{ sessionId: string, profileId: string }}
 */
async function startCapture({ url, website, displayName, profileId, allowedActions } = {}) {
  ensurePlaywright();

  if (!url) throw new Error('url is required');
  if (!website) throw new Error('website is required');
  if (!displayName) throw new Error('displayName is required');

  const resolvedProfileId = profileId || randomUUID().slice(0, 12);
  const dir = profileDir(website, resolvedProfileId);
  fs.mkdirSync(dir, { recursive: true });

  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions-except',
    ],
  });

  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();

  // Navigate; don't throw if the page has an issue — let the boss see whatever state it's in
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});

  const sessionId = randomUUID();

  // Auto-expire after timeout
  const timer = setTimeout(async () => {
    const s = _sessions.get(sessionId);
    if (s) {
      await s.context.close().catch(() => {});
      _sessions.delete(sessionId);
    }
  }, SESSION_TIMEOUT_MS);

  _sessions.set(sessionId, {
    context,
    page,
    meta: {
      url,
      website,
      displayName,
      profileId: resolvedProfileId,
      allowedActions: Array.isArray(allowedActions) ? allowedActions : [],
    },
    startedAt: Date.now(),
    timer,
  });

  return { sessionId, profileId: resolvedProfileId };
}

/**
 * Finish a capture session: extract cookies, save account, close Chrome.
 *
 * @param {string} sessionId
 * @param {object} [overrides]
 * @param {string} [overrides.username]     Optional username / handle to record
 * @param {string} [overrides.displayName]  Override the display name set at start
 * @returns {{ ok: boolean, alias: string, account: object }}
 */
async function finishCapture(sessionId, overrides = {}) {
  const session = _sessions.get(sessionId);
  if (!session) throw new Error('Browser session not found or has already expired (15 min limit)');

  clearTimeout(session.timer);
  const { context, page, meta } = session;

  // Extract all cookies from the browser context
  let cookieStr = '';
  try {
    const cookies = await context.cookies();
    cookieStr = cookiesToString(cookies);
  } catch {
    // Partial — still save what we have
  }

  // Try to grab useful info from the page if no username was given
  let detectedName = overrides.displayName || meta.displayName;
  const username = String(overrides.username || '').trim();

  // Close Chrome
  await context.close().catch(() => {});
  _sessions.delete(sessionId);

  // Persist to web-accounts-store (cookie-only account)
  const account = webAccounts.importBrowserAccount({
    displayName: detectedName,
    website: meta.website,
    websiteUrl: meta.url,
    username,
    cookie: cookieStr,
    browserProfile: meta.profileId,
    allowedActions: meta.allowedActions,
  });

  return { ok: true, alias: account.alias, account };
}

/**
 * Cancel a capture session: close Chrome without saving anything.
 */
async function cancelCapture(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session) return { ok: true, message: 'session not found (may have already closed)' };

  clearTimeout(session.timer);
  await session.context.close().catch(() => {});
  _sessions.delete(sessionId);

  return { ok: true };
}

/**
 * List currently active capture sessions (for debugging / admin).
 */
function listActiveSessions() {
  return Array.from(_sessions.entries()).map(([id, s]) => ({
    sessionId: id,
    website: s.meta.website,
    displayName: s.meta.displayName,
    profileId: s.meta.profileId,
    startedAt: s.startedAt,
    expiresAt: s.startedAt + SESSION_TIMEOUT_MS,
  }));
}

module.exports = {
  startCapture,
  finishCapture,
  cancelCapture,
  listActiveSessions,
};
