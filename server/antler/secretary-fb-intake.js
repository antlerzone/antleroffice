/**
 * Secretary front-door intents for Facebook login vs group posting.
 * Login is Secretary-only; posting is delegated to CEO → Marketing Junior.
 */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

const LOGIN_PATTERNS = [
  /\b(log\s*in|login|sign\s*in)\b.*\bfaceboo?k\b/i,
  /\bfaceboo?k\b.*\b(log\s*in|login|sign\s*in)\b/i,
  /\blet\s+login\b.*\bfaceboo?k\b/i,
  /登[录入].*faceboo?k/i,
  /faceboo?k.*登[录入]/i,
  /我要.*登[录入].*faceboo?k/i,
  /faceboo?k.*我要.*登[录入]/i,
  /我要登[录入]/i,
  /先登[录入]/i,
  /连接\s*faceboo?k/i,
  /faceboo?k\s*账号/i,
  /fb\s*登[录入]/i,
  /登[录入]\s*fb\b/i,
];

/** Questions like「我们登入好了吗」— check status only, do NOT reopen Chrome or scrape. */
const LOGIN_STATUS_PATTERNS = [
  /登(入|录)?好了[吗嘛？?]/,
  /登(入|录)了吗/,
  /登录了吗/,
  /我们登(入|录)/,
  /有没有登(入|录)/,
  /are we logged in/i,
  /did (i|we) log in/i,
  /logged in yet/i,
];

/** Boss confirms login is complete — verify home, scrape groups, close Chrome. */
const LOGIN_DONE_PATTERNS = [
  /^登好了[。.!！]?$/,
  /^登(入|录)好了[。.!！]?$/,
  /^登录好了[。.!！]?$/,
  /已经登(入|录)好了/,
  /登(入|录)完成了/,
  /到首页了/,
  /看到首页了/,
  /进到\s*home了/i,
  /\b(logged\s*in|login\s*done|done\s*logging)\b/i,
  /\b(i'?m\s+in|finished\s+login)\b/i,
];

const POST_PATTERNS = [
  /\bpost\b.*\b(group|groups|fb|faceboo?k)\b/i,
  /\b(group|groups|faceboo?k|fb)\b.*\bpost\b/i,
  /\b(want\s+(to\s+)?)?post\b.*\bfaceboo?k\b/i,
  /帮我.*post.*facebook/i,
  /post.*facebook/i,
  /facebook.*(发帖|发文|post)/i,
  /发(到|去|帖?).*群/,
  /群.*发(帖|文|布)/,
  /发到\s*facebook/i,
  /schedule.*post/i,
  /fb.*发帖/,
  /发帖/,
  /要发/,
  /帮我发/,
  /文案/,
  /帮.*post/i,
  /post.*群/i,
  /群.*post/i,
  /在.*群(组)?(里|里面|中)?.*(发|post|试试)/i,
  /发.*群(组)?.*试试/i,
];

function normalize(text) {
  return String(text || '').trim();
}

function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

function extractEmail(text) {
  const m = normalize(text).match(EMAIL_RE);
  return m ? m[0].toLowerCase() : '';
}

function slugAccountKey(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  return s
    .replace(/[^\w@.\u4e00-\u9fff-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 48);
}

/** Email, or「账号 mom」「户口 2」— each maps to a separate Chrome profile. */
function extractAccountKey(text) {
  const email = extractEmail(text);
  if (email) return email;
  const raw = normalize(text);
  const patterns = [
    /账号[：:\s]+([a-zA-Z0-9@._\u4e00-\u9fff-]{2,32})/,
    /帐号[：:\s]+([a-zA-Z0-9@._\u4e00-\u9fff-]{2,32})/,
    /户口[：:\s]+([a-zA-Z0-9@._\u4e00-\u9fff-]{2,32})/,
    /account[：:\s]+([a-zA-Z0-9@._-]{2,32})/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1]) return slugAccountKey(m[1]);
  }
  return '';
}

const LIST_ACCOUNT_PATTERNS = [
  /绑定了几个.*faceboo?k/i,
  /几个.*faceboo?k.*账号/i,
  /faceboo?k.*账号.*(列表|几个|多少|清单)/i,
  /我的.*faceboo?k.*账号/i,
  /列出.*faceboo?k/i,
  /list.*faceboo?k.*account/i,
  /how many.*faceboo?k/i,
  /查看.*faceboo?k.*账号/i,
];

/**
 * @returns {'fb_login' | 'fb_login_status' | 'fb_login_done' | 'fb_list_accounts' | 'fb_post' | null}
 */
function classifySecretaryMessage(text) {
  const raw = normalize(text);
  if (!raw) return null;

  if (matchesAny(raw, LIST_ACCOUNT_PATTERNS)) return 'fb_list_accounts';
  if (matchesAny(raw, LOGIN_STATUS_PATTERNS)) return 'fb_login_status';
  if (matchesAny(raw, LOGIN_DONE_PATTERNS)) return 'fb_login_done';

  const wantsLoginFirst =
    /\b(login\b.*\bfirst|first\b.*\blogin)\b/i.test(raw) || /先登/.test(raw);
  const isLogin =
    matchesAny(raw, LOGIN_PATTERNS) ||
    /\b(let\s+)?login\b.*\bfaceboo?k\b/i.test(raw) ||
    (/\bfaceboo?k\b/i.test(raw) && /\blogin\b/i.test(raw));
  const isPost =
    matchesAny(raw, POST_PATTERNS) || /\b(want\s+(to\s+)?)?post\b.*\bfaceboo?k\b/i.test(raw);

  if (wantsLoginFirst && isLogin) return 'fb_login';
  if (isLogin && !isPost) return 'fb_login';
  if (isPost && !isLogin) return 'fb_post';
  if (isLogin && isPost) return wantsLoginFirst ? 'fb_login' : 'fb_post';

  return null;
}

function getFbPostingReadiness() {
  try {
    return require('./fb-playwright-engine').postingReadiness();
  } catch {
    return { ready: false, reason: 'engine_unavailable', accounts: [] };
  }
}

function summarizeBossPostRequest(text) {
  const raw = normalize(text);
  if (!raw) return '';
  const preview = raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
  return preview;
}

function buildLoginRequiredReply(taskText, readiness) {
  const preview = summarizeBossPostRequest(taskText);
  const noted = preview ? `\n\n我已记下您的发帖需求：\n> ${preview}` : '';

  if (readiness?.reason === 'no_account') {
    return (
      `老板，发 Facebook 群组需要先登录。${noted}\n\n` +
      `**您现在方便登录吗？** 我会为您打开 Facebook，您在 Chrome **自行输入账号和密码**即可。\n` +
      `**看到 Facebook 首页（Home）后**回复「登好了」，我再帮您安排发帖。`
    );
  }

  return (
    `老板，发 Facebook 群组需要先完成 Facebook 登录。${noted}\n\n` +
    `**您现在方便登录吗？** 我会打开 Facebook，您自行输入账号密码；**进到首页后**回复「登好了」。`
  );
}

function secretaryFbSystem(secName) {
  return (
    `You are ${secName}, the executive secretary — the boss's only front-door contact.\n\n` +
    `## Facebook login (YOU handle this — do NOT forward to CEO)\n` +
    `When the boss wants to log into Facebook:\n` +
    `1. Call \`fb_poster_open_account\` (optional account_username from email or「账号 xxx」) → Chrome opens.\n` +
    `2. Boss enters username & password themselves (2FA ok). Do NOT ask for password in chat.\n` +
    `3. When boss reaches Facebook **home feed** on https://www.facebook.com/, they reply「登好了」.\n` +
    `4. System verifies home → scrapes groups → closes Chrome → replies success/failure in chat.\n` +
    `5. Multiple FB accounts: each gets its own Chrome profile (e.g.「登入 facebook 账号 mom」).\n` +
    `6. Boss can ask「我绑定了几个 facebook」to list bound accounts.\n` +
    `7. Do NOT reload groups or schedule posts yourself before boss confirms 登好了.\n\n` +
    `## After boss says 登好了 / login done\n` +
    `Confirm login saved. Ask clearly: 「要不要现在发到 Facebook 群组？」\n` +
    `Wait for boss answer. Only if they want posting, say you will pass it to the CEO.\n\n` +
    `## Facebook group posting (route — do NOT execute yourself)\n` +
    `When boss wants to post to FB groups and login is ready:\n` +
    `1. Say: 「好的，我交给 CEO 安排 Marketing 发到群组。」\n` +
    `2. Pass to **CEO** — CEO delegates to **Marketing Junior**\n` +
    `3. Junior runs posting tools — you never call fb_poster_schedule yourself\n\n` +
    `## Tools you may use\n` +
    `fb_poster_open_account · antlerhub_list_fb_accounts\n` +
    `(Posting tools are for Marketing Junior after CEO delegation.)`
  );
}

function buildLoginStatusReply(check = {}, { hasOpenSession = false } = {}) {
  let bindNote = '';
  try {
    const { listAccountsForBoss } = require('./fb-playwright-engine');
    const n = listAccountsForBoss().length;
    if (n > 0) bindNote = `\n\n（已绑定 **${n}** 个 Facebook 账号，说「我绑定了几个 facebook」可查看列表。）`;
  } catch {
    /* */
  }
  if (check.onHome) {
    return (
      '是的，Chrome 里**已经在 Facebook 首页**。\n\n' +
      '请回复「**登好了**」（不要加「吗」），我会抓取群组、关闭 Chrome，并告诉您成功或失败。' +
      bindNote
    );
  }
  if (hasOpenSession) {
    return (
      'Chrome 还开着，但**尚未进入 Facebook 首页**。\n\n' +
      '请继续在 Chrome 完成登录，看到 Home 后回复「**登好了**」。'
    );
  }
  return (
    '目前**尚未确认 Facebook 登录**。\n\n' +
    '若需要登录，请说「我要登入 facebook」；若已在 Chrome 里进到首页，请回复「**登好了**」。'
  );
}

function buildFbAccountsListReply() {
  try {
    const { formatAccountsSummary } = require('./fb-playwright-engine');
    return formatAccountsSummary();
  } catch {
    return '暂时无法读取 Facebook 账号列表，请稍后再试。';
  }
}

module.exports = {
  classifySecretaryMessage,
  extractEmail,
  extractAccountKey,
  getFbPostingReadiness,
  buildLoginRequiredReply,
  buildLoginStatusReply,
  buildFbAccountsListReply,
  summarizeBossPostRequest,
  secretaryFbSystem,
  LOGIN_PATTERNS,
  LOGIN_STATUS_PATTERNS,
  LOGIN_DONE_PATTERNS,
  LIST_ACCOUNT_PATTERNS,
  POST_PATTERNS,
};
