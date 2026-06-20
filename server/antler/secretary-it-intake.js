/**
 * Secretary intake — dev pipeline setup (like FB login before posting).
 */

const office = require('./office-state');
const devTeamResolver = require('./runtime/dev-team-resolver');
const { getEngine } = require('./runtime/dev-engine-registry');

const SETUP_PATTERNS = [
  /配置.*(it\s*guys|开发工具|dev\s*tools?|cursor|codex|claude|开发团队)/i,
  /(cursor|codex|claude).*(配置|设置|api\s*key|密钥)/i,
  /dev\s*tools?/i,
  /开发凭证/,
  /dev\s*team/i,
  /开发团队/,
];

const SETUP_DONE_PATTERNS = [
  /it\s*(配好|设置好|弄好)了?/i,
  /(配好|设置好|填好).*(it|cursor|codex|claude|开发|key|密钥)/i,
  /keys?\s*(saved|configured)/i,
  /api\s*keys?\s*(saved|done|ready)/i,
  /开发工具.*(好了|就绪|完成)/,
];

const DEV_REQUEST_PATTERNS = [
  /\b(write|implement|fix|build|develop|code|refactor|debug)\b/i,
  /写代码|开发|实现|修\s*bug|编程|改代码|加功能|新功能/,
  /git\s*(push|commit|branch)/i,
  /code\s*review|代码审核/,
  /cursor\s*(cli|agent)?/i,
  /\bcodex\b/i,
  /\bclaude\b/i,
  /dev\s*pipeline/i,
];

const STATUS_PATTERNS = [
  /(开发工具|dev\s*team).*(就绪|准备好|ready|status)/i,
  /cursor.*(装|安装).*(了吗|好)/i,
  /codex.*(装|安装).*(了吗|好)/i,
  /claude.*(装|安装).*(了吗|好)/i,
];

function normalize(text) {
  return String(text || '').trim();
}

function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

function findDevAgents() {
  const ids = new Set(devTeamResolver.listDevAgents().map((a) => a.id));
  return (office.state?.agents || []).filter((a) => {
    if (a.external) return false;
    const regId = a.id?.startsWith('user:') ? a.id.slice(5) : null;
    if (regId && ids.has(regId)) return true;
    return a.role === 'it' && !a.external;
  });
}

function findItAgent() {
  return findDevAgents()[0] || null;
}

async function checkEngineReadiness(engineName) {
  const eng = getEngine(engineName);
  if (!eng) return { engine: engineName, installed: false, authReady: false };
  const probed = await eng.probe();
  const authReady = await eng.hasAuth();
  return { engine: engineName, installed: probed.installed, authReady };
}

async function getItDevReadiness() {
  const devAgents = devTeamResolver.listDevAgents();
  if (!devAgents.length) {
    return { hired: false, ready: false, reason: 'not_hired', missing: ['not_hired'] };
  }

  const team = devTeamResolver.resolveDevTeam();
  const missing = [];
  if (!team.ok) {
    missing.push('dev_team');
    team.errors.forEach((e) => missing.push(`team:${e}`));
  }

  const enginesNeeded = new Set();
  if (team.writer?.devEngine) enginesNeeded.add(team.writer.devEngine);
  for (const r of team.reviewers || []) {
    if (r.devEngine) enginesNeeded.add(r.devEngine);
  }
  if (!enginesNeeded.size) {
    for (const a of devAgents) {
      if (a.devEngine) enginesNeeded.add(a.devEngine);
    }
  }

  const engineStatus = {};
  for (const engine of enginesNeeded) {
    const status = await checkEngineReadiness(engine);
    engineStatus[engine] = status;
    if (!status.installed) missing.push(`${engine}_cli`);
    if (!status.authReady) missing.push(`${engine}_auth`);
  }

  const itAgent = findItAgent();
  return {
    hired: true,
    ready: missing.length === 0,
    missing,
    devAgentCount: devAgents.length,
    itAgentName: itAgent?.label || devAgents[0]?.name || 'Developer',
    teamOk: team.ok,
    teamErrors: team.errors || [],
    writer: team.writer || null,
    reviewers: team.reviewers || [],
    engines: engineStatus,
    reason: missing.length ? missing[0] : 'ready',
  };
}

/**
 * @returns {'it_setup' | 'it_setup_done' | 'it_status' | 'it_dev_request' | null}
 */
function classifyItMessage(text) {
  const raw = normalize(text);
  if (!raw) return null;
  if (!devTeamResolver.listDevAgents().length && !findItAgent()) return null;

  if (matchesAny(raw, SETUP_DONE_PATTERNS)) return 'it_setup_done';
  if (matchesAny(raw, STATUS_PATTERNS)) return 'it_status';
  if (matchesAny(raw, SETUP_PATTERNS)) return 'it_setup';
  if (matchesAny(raw, DEV_REQUEST_PATTERNS)) return 'it_dev_request';

  return null;
}

function summarizeRequest(text) {
  const raw = normalize(text);
  if (!raw) return '';
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

function buildSetupGuide(readiness, { noted = '' } = {}) {
  const name = readiness.itAgentName || 'Developer';
  const lines = [
    `老板，开发流水线需要您在本机配置几项（每人独立，存本机）：${noted}`,
    '',
  ];

  if (readiness.missing.includes('not_hired')) {
    lines.push('• 请先雇佣 **Cursor Developer**、**Claude Developer** 或 **Codex Developer**（至少一个）');
  }
  if (readiness.missing.includes('dev_team')) {
    lines.push('• **Dev Team** 未配置 → **Settings → Dev tools** 选择 Writer 和 Reviewer(s)');
    for (const err of readiness.teamErrors || []) {
      lines.push(`  - ${err}`);
    }
  }
  for (const engine of ['cursor', 'claude', 'codex']) {
    if (readiness.missing.includes(`${engine}_cli`)) {
      lines.push(`• **${engine} CLI** 未安装 → **Settings → Dev tools → Install ${engine} CLI**`);
    }
    if (readiness.missing.includes(`${engine}_auth`)) {
      lines.push(`• **${engine} API Key** → **Settings → Dev tools** 填写`);
    }
  }

  if (readiness.ready) {
    lines.length = 0;
    const writer = readiness.writer?.name || 'Writer';
    const reviewers = (readiness.reviewers || []).map((r) => r.name).join(', ') || writer;
    lines.push(`**开发团队已就绪**：Writer **${writer}**，Reviewer(s) **${reviewers}**`);
    lines.push('有开发任务请直接说需求，我会交给 CEO 安排执行。');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('**不用去 Account & Password** — 那是 Facebook 等网站账号；API Key 在 **Settings → Dev tools**。');
  lines.push('');
  lines.push('配好后回复 **「IT 配好了」**，我帮您确认并交给 CEO。');
  return lines.join('\n');
}

function buildSetupRequiredReply(taskText, readiness) {
  const preview = summarizeRequest(taskText);
  const noted = preview ? `\n\n我已记下您的开发需求：\n> ${preview}` : '';
  return buildSetupGuide(readiness, { noted });
}

module.exports = {
  classifyItMessage,
  getItDevReadiness,
  buildSetupGuide,
  buildSetupRequiredReply,
  findItAgent,
  findDevAgents,
  SETUP_PATTERNS,
  DEV_REQUEST_PATTERNS,
};
