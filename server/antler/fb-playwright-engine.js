/**
 * Facebook group posting — Playwright (ByamB4-style) + persistent Chrome profile.
 * No SnapPost / :3090. Session lives under ~/.antleroffice2/fb-profiles/{email}/
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const store = require('./store');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

const _sessions = new Map();
const _timers = new Map();

function engineRoot() {
  const root = path.join(store.getDataDir(), 'fb-engine');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(store.getDataDir(), 'fb-profiles'), { recursive: true });
  return root;
}

function accFile() {
  return path.join(engineRoot(), 'accounts.json');
}

function artFile() {
  return path.join(engineRoot(), 'articles.json');
}

function jobFile() {
  return path.join(engineRoot(), 'jobs.json');
}

function groupsFile(email) {
  return path.join(engineRoot(), 'groups', `${safeEmail(email)}.json`);
}

function safeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, '_');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function ensurePlaywright() {
  if (!chromium) {
    throw new Error(
      'Playwright not installed. Run: cd AntlerOffice2 && npm install && npx playwright install chrome',
    );
  }
}

const DEFAULT_FB_ACCOUNT = 'default';

function resolveAccountKey(username) {
  const u = String(username || '').trim();
  return u || DEFAULT_FB_ACCOUNT;
}

function primaryAccountKey() {
  const accounts = listAccounts();
  const logged = accounts.find((a) => a.loggedInAt);
  if (logged) return logged.username;
  return accounts[0]?.username || DEFAULT_FB_ACCOUNT;
}

function pendingBindFile() {
  return path.join(engineRoot(), 'pending-bind.json');
}

function setPendingBind(username) {
  writeJson(pendingBindFile(), {
    username: resolveAccountKey(username),
    at: new Date().toISOString(),
  });
}

function getPendingBind() {
  const data = readJson(pendingBindFile(), null);
  if (!data?.username) return '';
  return String(data.username).trim();
}

function clearPendingBind() {
  try {
    fs.unlinkSync(pendingBindFile());
  } catch {
    /* */
  }
}

function resolveActiveAccountKey(username = '') {
  const explicit = String(username || '').trim();
  if (explicit) return resolveAccountKey(explicit);
  const pending = getPendingBind();
  if (pending) return resolveAccountKey(pending);
  return DEFAULT_FB_ACCOUNT;
}

function registerAccount(username, note = '') {
  const email = resolveAccountKey(username);
  const accounts = readJson(accFile(), []);
  let acc = accounts.find((a) => a.username.toLowerCase() === email.toLowerCase());
  if (!acc) {
    acc = {
      id: randomUUID(),
      username: email,
      note: note || '',
      displayName: '',
      createdAt: new Date().toISOString(),
    };
    accounts.push(acc);
    writeJson(accFile(), accounts);
  } else if (note && !acc.note) {
    acc.note = note;
    writeJson(accFile(), accounts);
  }
  return accounts.find((a) => a.username.toLowerCase() === email.toLowerCase());
}

function updateAccountRecord(username, patch = {}) {
  const key = resolveAccountKey(username);
  registerAccount(key);
  const accounts = readJson(accFile(), []);
  const idx = accounts.findIndex((a) => a.username.toLowerCase() === key.toLowerCase());
  if (idx < 0) return null;
  accounts[idx] = { ...accounts[idx], ...patch, updatedAt: new Date().toISOString() };
  writeJson(accFile(), accounts);
  return accounts[idx];
}

async function captureFacebookIdentity(username = '') {
  const accountKey = resolveActiveAccountKey(username);
  const key = safeEmail(accountKey);
  if (!_sessions.has(key)) return null;
  const { page } = _sessions.get(key);
  try {
    const info = await page.evaluate(() => {
      const nameLink =
        document.querySelector('[aria-label="Your profile"] span') ||
        document.querySelector('[aria-label="你的个人主页"] span') ||
        document.querySelector('a[href*="/me/"] span') ||
        document.querySelector('[data-pagelet="ProfileTilesFeed"] h1');
      const displayName = (nameLink?.textContent || '').trim();
      const profileHref =
        document.querySelector('a[aria-label="Profile"], a[aria-label="个人主页"], a[href*="/me/"]')
          ?.getAttribute('href') || '';
      return { displayName, profileHref };
    });
    if (!info?.displayName) return null;
    return updateAccountRecord(accountKey, {
      displayName: info.displayName,
      profileUrl: info.profileHref || '',
      note: info.displayName,
    });
  } catch {
    return null;
  }
}

function listAccountsForBoss() {
  return listAccounts().map((a) => {
    const groups = listGroups(a.username);
    const groupCount = a.club_count || groups.length || 0;
    return {
      id: a.id,
      username: a.username,
      label: a.displayName || a.note || a.username,
      displayName: a.displayName || '',
      loggedIn: !!a.loggedInAt,
      loggedInAt: a.loggedInAt || null,
      groupCount,
      profileReady: accountIsLoggedIn(a.username),
      isDefault: a.username === DEFAULT_FB_ACCOUNT,
    };
  });
}

function formatAccountsSummary() {
  const accounts = listAccountsForBoss();
  if (!accounts.length) {
    return '目前还没有绑定的 Facebook 账号。说「我要登入 facebook」开始绑定第一个。';
  }
  const lines = accounts.map((a, i) => {
    const status = a.loggedIn ? '已登录' : '未登录';
    const groups = a.groupCount ? `${a.groupCount} 个群` : '群组未抓取';
    return `${i + 1}. **${a.label}**（id: \`${a.username}\`）— ${status}，${groups}`;
  });
  return (
    `您已绑定 **${accounts.length}** 个 Facebook 账号：\n\n${lines.join('\n')}\n\n` +
    `绑定新账号：说「登入 facebook 账号 妈妈」或「登入 facebook your@email.com」。发帖时可指定 \`account_username\`。`
  );
}

function markLoggedIn(username) {
  const key = resolveAccountKey(username);
  const note = key === DEFAULT_FB_ACCOUNT ? 'Boss default profile' : '';
  registerAccount(key, note);
  const accounts = readJson(accFile(), []);
  const acc = accounts.find((a) => a.username.toLowerCase() === key.toLowerCase());
  if (acc) {
    acc.loggedInAt = new Date().toISOString();
    writeJson(accFile(), accounts);
  }
  return acc;
}

function listAccounts() {
  return readJson(accFile(), []);
}

function listArticles() {
  return readJson(artFile(), []);
}

function addArticle({ title, content = '', images = '', note = '' }) {
  const articles = listArticles();
  const entry = {
    id: randomUUID(),
    title: String(title || '').trim(),
    content: String(content || ''),
    images: String(images || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    note: String(note || ''),
    createdAt: new Date().toISOString(),
  };
  if (!entry.title) throw new Error('title is required');
  articles.push(entry);
  writeJson(artFile(), articles);
  return entry;
}

function resolveContent(content, articleId) {
  const text = String(content || '').trim();
  if (text) return text;
  if (!articleId) return '';
  const art = listArticles().find((a) => a.id === articleId);
  if (!art) return '';
  return [art.title, art.content, art.note].filter(Boolean).join('\n\n');
}

function profileDir(email) {
  return path.join(store.getDataDir(), 'fb-profiles', safeEmail(email), 'chrome');
}

async function getSession(email, { navigateLogin = false } = {}) {
  ensurePlaywright();
  const accountKey = resolveAccountKey(email);
  const key = safeEmail(accountKey);
  if (_sessions.has(key)) {
    const hit = _sessions.get(key);
    try {
      if (!hit.context?.browser()?.isConnected()) {
        _sessions.delete(key);
      } else {
        if (hit.page.isClosed()) {
          hit.page = hit.context.pages()[0] || (await hit.context.newPage());
        }
        if (navigateLogin) {
          await hit.page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
        }
        return hit;
      }
    } catch {
      _sessions.delete(key);
    }
  }

  const dir = profileDir(accountKey);
  fs.mkdirSync(dir, { recursive: true });

  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(60000);
  const session = { context, page, email: accountKey };
  _sessions.set(key, session);

  context.on('close', () => {
    _sessions.delete(key);
  });

  if (navigateLogin) {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  }

  return session;
}

async function detectFacebookHome(username = '') {
  const accountKey = resolveActiveAccountKey(username);
  const key = safeEmail(accountKey);
  if (!_sessions.has(key)) {
    const acc = listAccounts().find((a) => a.username.toLowerCase() === accountKey.toLowerCase());
    return { onHome: !!acc?.loggedInAt, url: '', account_username: accountKey };
  }

  const { page } = _sessions.get(key);
  await page.waitForTimeout(800);
  const url = page.url();
  if (/facebook\.com\/login/i.test(url)) {
    return { onHome: false, url, account_username: accountKey };
  }

  const onHome = await page.evaluate(() => {
    if (document.querySelector('input[name="email"], input[name="pass"], input#email')) return false;
    const p = (location.pathname || '/').replace(/\/$/, '') || '/';
    const host = (location.hostname || '').toLowerCase();
    if (!host.includes('facebook.com')) return false;
    if (/login|checkpoint|recover|two_step/.test(p)) return false;
    if (p === '/' || p === '/home.php' || p.startsWith('/home')) return true;
    return !!document.querySelector('[role="feed"], [aria-label="Facebook"], [aria-label="首页"]');
  });

  return { onHome, url, account_username: accountKey };
}

async function closeSession(username = '') {
  const key = safeEmail(resolveAccountKey(username));
  const hit = _sessions.get(key);
  if (!hit) return;
  try {
    await hit.context.close();
  } catch {
    /* */
  }
  _sessions.delete(key);
}

async function confirmLogin(username = '') {
  const result = await completeLoginFlow(username);
  return {
    ok: result.ok,
    onHome: result.onHome,
    account_username: result.account_username,
    groupCount: result.groupCount,
    message: result.message,
  };
}

/**
 * Boss replied 登好了: verify home feed → scrape groups → close Chrome → report result.
 */
async function completeLoginFlow(username = '') {
  const accountKey = resolveActiveAccountKey(username);
  registerAccount(
    accountKey,
    accountKey === DEFAULT_FB_ACCOUNT ? 'Boss default profile' : accountKey,
  );

  const check = await detectFacebookHome(accountKey);
  if (!check.onHome) {
    return {
      ok: false,
      onHome: false,
      account_username: accountKey,
      groupCount: 0,
      message:
        '尚未进入 Facebook **首页（Home）**。\n\n请继续在 Chrome 完成登录（自行输入账号密码），看到首页后再回复「登好了」。',
    };
  }

  markLoggedIn(accountKey);
  await captureFacebookIdentity(accountKey);

  let scrape;
  try {
    scrape = await scrapeGroups(accountKey);
  } catch (e) {
    return {
      ok: false,
      onHome: true,
      account_username: accountKey,
      groupCount: 0,
      message:
        `已进入 Facebook 首页，但**抓取群组失败**：${e.message}\n\nChrome 仍保持打开，请检查网络或权限后再次回复「登好了」。`,
    };
  }

  const count = scrape.count || 0;
  const identity = listAccountsForBoss().find((a) => a.username === accountKey);
  const label = identity?.label || accountKey;
  await closeSession(accountKey);
  clearPendingBind();

  if (count === 0) {
    return {
      ok: false,
      onHome: true,
      account_username: accountKey,
      groupCount: 0,
      message:
        '已进入 Facebook 首页，但**未抓到任何群组**。\n\n请确认账号已加入群组，重新登录后再回复「登好了」。',
    };
  }

  const all = listAccountsForBoss();
  const bindNote =
    all.length > 1
      ? `\n\n您现在共绑定 **${all.length}** 个 Facebook 账号。说「我绑定了几个 facebook」可查看列表。`
      : '';

  const scrapeNote = scrape.scrape?.source
    ? `（${scrape.scrape.source} 页面，已自动滚动加载）`
    : '';

  return {
    ok: true,
    onHome: true,
    account_username: accountKey,
    groupCount: count,
    boundCount: all.length,
    message:
      `**Facebook 登录成功！**\n\n` +
      `账号 **${label}** 已进入首页并抓取到 **${count}** 个群组${scrapeNote}，Chrome 已关闭。${bindNote}\n\n` +
      `**要不要现在发到 Facebook 群组？** 若要发帖，请告诉我要发的内容、群名筛选和发布时间。`,
  };
}

function hasOpenSession(username = '') {
  const key = safeEmail(resolveActiveAccountKey(username));
  const hit = _sessions.get(key);
  if (!hit) return false;
  try {
    return !!hit.context?.browser()?.isConnected();
  } catch {
    return false;
  }
}

async function openAccount(username = '') {
  const accountKey = resolveActiveAccountKey(username);
  registerAccount(
    accountKey,
    accountKey === DEFAULT_FB_ACCOUNT ? 'Boss default profile' : accountKey,
  );
  setPendingBind(accountKey);

  if (hasOpenSession(accountKey)) {
    const check = await detectFacebookHome(accountKey);
    const label = accountKey === DEFAULT_FB_ACCOUNT ? '默认账号' : accountKey;
    return {
      status: 'ok',
      alreadyOpen: true,
      onHome: !!check.onHome,
      message: check.onHome
        ? `Chrome 已打开（${label}），已在 Facebook 首页。回复「登好了」抓取群组并结束。`
        : `Chrome 已打开（${label}）。完成登录、进入首页后回复「登好了」。`,
      account_username: accountKey,
      profileDir: profileDir(accountKey),
    };
  }

  await getSession(accountKey, { navigateLogin: true });
  const label = accountKey === DEFAULT_FB_ACCOUNT ? '默认账号' : accountKey;
  const bound = listAccountsForBoss();
  const isNew = !bound.find((a) => a.username === accountKey);
  const multiHint =
    isNew && bound.length > 0
      ? `\n\n（新档案 \`${accountKey}\`，完成后您将共有 ${bound.length + 1} 个 Facebook 账号。）`
      : bound.length > 1
        ? `\n\n（档案 \`${accountKey}\`）`
        : '';
  return {
    status: 'ok',
    message:
      `已为您打开 Facebook（**${label}**）。请在 Chrome **自行输入账号密码**；进入首页后回复「登好了」。${multiHint}`,
    account_username: accountKey,
    profileDir: profileDir(accountKey),
  };
}

const FB_GROUP_SKIP_IDS = new Set([
  'feed',
  'discover',
  'joins',
  'create',
  'search',
  'categories',
  'pending',
  'requests',
  'notifications',
]);

/** DOM snapshot — only links currently rendered (no pagination by itself). */
async function collectGroupsFromDom(page) {
  return page.evaluate((skipIds) => {
    const skip = new Set(skipIds);
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/groups/"]')) {
      const href = a.href || '';
      const parts = href.split('/groups/');
      if (parts.length < 2) continue;
      const id = parts[1].split('/')[0].split('?')[0];
      if (!id || skip.has(id) || seen.has(id)) continue;
      const name = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!name || name.length < 2) continue;
      if (/^(see all|查看全部|所有群组|groups?)$/i.test(name)) continue;
      seen.add(id);
      out.push({ id, name, url: `https://www.facebook.com/groups/${id}/` });
    }
    return out;
  }, [...FB_GROUP_SKIP_IDS]);
}

/**
 * Scroll the groups list so Facebook lazy-loads more rows, then merge unique groups.
 */
async function scrollAndCollectGroups(page, { maxRounds = 80, pauseMs = 1400, stagnantLimit = 8 } = {}) {
  const merged = new Map();
  const absorb = (batch) => {
    for (const g of batch || []) merged.set(g.id, g);
  };

  absorb(await collectGroupsFromDom(page));

  let stagnant = 0;
  for (let round = 0; round < maxRounds && stagnant < stagnantLimit; round += 1) {
    const before = merged.size;
    await page.evaluate(() => {
      const main = document.querySelector('[role="main"]');
      if (main && main.scrollHeight > main.clientHeight + 40) {
        main.scrollTop = main.scrollHeight;
      }
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(pauseMs);
    absorb(await collectGroupsFromDom(page));
    stagnant = merged.size === before ? stagnant + 1 : 0;
  }

  return {
    groups: [...merged.values()],
    scrollRounds: maxRounds - stagnant,
    stagnantRounds: stagnant,
  };
}

async function scrapeGroupsFromUrl(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);

  try {
    const seeAll = page
      .locator('a[href*="/groups/joins"], a[href*="/groups/"]')
      .filter({ hasText: /see all|查看全部|所有群组|your groups|你加入的群组/i })
      .first();
    if (await seeAll.isVisible({ timeout: 2000 }).catch(() => false)) {
      await seeAll.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }
  } catch {
    /* optional navigation */
  }

  return scrollAndCollectGroups(page);
}

async function scrapeGroups(username) {
  registerAccount(username);
  const { page } = await getSession(username);

  const sources = [
    { url: 'https://www.facebook.com/groups/joins/', label: 'joins' },
    { url: 'https://www.facebook.com/groups/feed/', label: 'feed' },
  ];

  let best = { groups: [], source: 'feed', scrollRounds: 0, stagnantRounds: 0 };

  for (const src of sources) {
    let result;
    try {
      result = await scrapeGroupsFromUrl(page, src.url);
    } catch (e) {
      console.warn(`[fb-engine] scrape ${src.label} failed:`, e.message);
      continue;
    }
    if (result.groups.length > best.groups.length) {
      best = { ...result, source: src.label };
    }
    if (result.groups.length >= 30 && result.stagnantRounds >= 8) break;
  }

  const groups = best.groups;
  writeJson(groupsFile(username), groups);

  const accounts = listAccounts();
  const hit = accounts.find((a) => a.username.toLowerCase() === username.toLowerCase());
  if (hit) {
    hit.club_count = groups.length;
    hit.groupsUpdatedAt = new Date().toISOString();
    hit.groupsScrapeSource = best.source;
    writeJson(accFile(), accounts);
  }

  return {
    status: 'ok',
    count: groups.length,
    data: groups,
    scrape: {
      source: best.source,
      scrollRounds: best.scrollRounds,
      note: 'Scrolled list until no new groups loaded (lazy-load pagination).',
    },
  };
}

function listGroups(username) {
  return readJson(groupsFile(username), []);
}

function filterGroups(username, nameContains) {
  const needle = String(nameContains || '').trim().toLowerCase();
  const groups = listGroups(username);
  if (!needle) return groups;
  return groups.filter((g) => String(g.name || '').toLowerCase().includes(needle));
}

async function postToGroup(username, groupId, content) {
  const { page } = await getSession(username);
  const gid = String(groupId || '').trim();
  const text = String(content || '').trim();
  if (!gid || !text) throw new Error('group_id and content required');

  await page.goto(`https://www.facebook.com/groups/${gid}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const writeBtn = page.locator('span:has-text("Write something")').first();
  await writeBtn.click({ timeout: 20000 });

  const editor = page.locator('[role="dialog"] [contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  await editor.fill(text);
  await page.waitForTimeout(2000);

  const postBtn = page.locator('[role="dialog"] [aria-label="Post"], [role="dialog"] [aria-label="发布"]').first();
  await postBtn.click({ timeout: 15000 });
  await page.waitForTimeout(5000);

  return { ok: true, group_id: gid, posted_chars: text.length };
}

async function runJob(jobId) {
  const jobs = readJson(jobFile(), []);
  const job = jobs.find((j) => j.id === jobId);
  if (!job || job.status === 'done' || job.status === 'running') return job;

  job.status = 'running';
  job.started_at = new Date().toISOString();
  writeJson(jobFile(), jobs);

  const content = resolveContent(job.content, job.article_id);
  const results = [];
  for (const gid of job.group_ids || []) {
    try {
      results.push(await postToGroup(job.account_username, gid, content));
    } catch (e) {
      results.push({ ok: false, group_id: gid, error: e.message });
    }
  }

  job.status = results.every((r) => r.ok) ? 'done' : 'error';
  job.results = results;
  job.finished_at = new Date().toISOString();
  writeJson(jobFile(), jobs);
  return job;
}

function schedulePost({
  account_username,
  group_ids,
  article_id = '',
  content = '',
  scheduled_at,
}) {
  registerAccount(account_username);
  const gids = String(group_ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!gids.length) throw new Error('group_ids required');

  let runAt = scheduled_at ? new Date(scheduled_at) : new Date(Date.now() + 2 * 60 * 1000);
  if (Number.isNaN(runAt.getTime())) {
    throw new Error('invalid scheduled_at');
  }

  const jobs = readJson(jobFile(), []);
  const job = {
    id: randomUUID(),
    type: 'schedule',
    account_username: String(account_username).trim(),
    group_ids: gids,
    article_id: article_id || '',
    content: content || '',
    scheduled_at: runAt.toISOString(),
    status: 'scheduled',
    created_at: new Date().toISOString(),
  };
  jobs.push(job);
  writeJson(jobFile(), jobs);

  const delay = Math.max(0, runAt.getTime() - Date.now());
  const timer = setTimeout(() => {
    runJob(job.id).catch((e) => {
      const jlist = readJson(jobFile(), []);
      const j = jlist.find((x) => x.id === job.id);
      if (j) {
        j.status = 'error';
        j.error = e.message;
        writeJson(jobFile(), jlist);
      }
    });
  }, delay);
  _timers.set(job.id, timer);

  return { status: 'ok', data: job };
}

function listScheduledJobs() {
  return readJson(jobFile(), []).filter((j) => j.status === 'scheduled' || j.schedule_mode);
}

function listJobResults() {
  return readJson(jobFile(), []);
}

function accountIsLoggedIn(username) {
  const email = resolveAccountKey(username);
  const accounts = listAccounts();
  const acc = accounts.find((a) => a.username.toLowerCase() === email.toLowerCase());
  if (acc?.loggedInAt) return true;
  if (acc?.groupsUpdatedAt) return true;
  if (listGroups(email).length > 0) return true;
  try {
    return fs.existsSync(path.join(profileDir(email), 'Default'));
  } catch {
    return false;
  }
}

function postingReadiness() {
  const accounts = listAccounts();
  if (!accounts.length) {
    return { ready: false, reason: 'no_account', accounts: [] };
  }
  const readyAccounts = accounts.filter((a) => accountIsLoggedIn(a.username));
  if (!readyAccounts.length) {
    return { ready: false, reason: 'login_required', accounts };
  }
  return { ready: true, accounts: readyAccounts };
}

function initScheduler() {
  const jobs = readJson(jobFile(), []);
  const now = Date.now();
  for (const job of jobs) {
    if (job.status !== 'scheduled') continue;
    const at = new Date(job.scheduled_at).getTime();
    const delay = Math.max(0, at - now);
    if (_timers.has(job.id)) continue;
    const timer = setTimeout(() => runJob(job.id).catch(() => {}), delay);
    _timers.set(job.id, timer);
  }
}

module.exports = {
  DEFAULT_FB_ACCOUNT,
  openAccount,
  hasOpenSession,
  scrapeGroups,
  listAccounts,
  listGroups,
  filterGroups,
  addArticle,
  schedulePost,
  listScheduledJobs,
  listJobResults,
  postToGroup,
  initScheduler,
  profileDir,
  resolveAccountKey,
  primaryAccountKey,
  accountIsLoggedIn,
  postingReadiness,
  detectFacebookHome,
  confirmLogin,
  completeLoginFlow,
  closeSession,
  markLoggedIn,
  listAccountsForBoss,
  formatAccountsSummary,
  getPendingBind,
  resolveActiveAccountKey,
};
