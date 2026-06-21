/**
 * Secretary front-door intents for Website Learning Mode (IT Junior).
 */

const LEARN_START_PATTERNS = [
  /网站学习模式/,
  /website\s*learning\s*mode/i,
  /进入学习模式/,
  /学习模式/,
  /学\s*.+\s*流程/,
  /learn\s+.+\s*workflow/i,
  /record\s+.+\s*website/i,
];

const LEARN_DONE_PATTERNS = [
  /^学习结束[。.!！]?$/,
  /^结束学习[。.!！]?$/,
  /学习完成/,
  /录制完成/,
  /learning\s*done/i,
  /done\s*learning/i,
];

const SIMULATE_PATTERNS = [
  /模拟一次/,
  /跑一遍给我看看/,
  /dry\s*run/i,
  /simulate\s*once/i,
];

const BATCH_PATTERNS = [
  /批量跑/,
  /批量执行/,
  /用\s*.+\s*跑/,
  /batch\s*run/i,
  /run\s*.+\.xlsx/i,
  /run\s*.+\.csv/i,
];

const LIST_WORKFLOWS_PATTERNS = [
  /有哪些\s*workflow/i,
  /workflow\s*列表/,
  /列出\s*workflow/i,
  /list\s*workflow/i,
];

const PROFILE_CHOICE_RE = /^[123]$/;

const WORKFLOW_NAME_PATTERNS = [
  /workflow[：:\s]+([a-zA-Z0-9._-]{2,64})/i,
  /流程[：:\s]+([a-zA-Z0-9._\u4e00-\u9fff-]{2,64})/,
  /名叫\s*([a-zA-Z0-9._\u4e00-\u9fff-]{2,64})/,
  /session[：:\s]+([a-zA-Z0-9._-]{2,64})/i,
];

const URL_RE = /https?:\/\/[^\s<>"']+/i;

function normalize(text) {
  return String(text || '').trim();
}

function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

function extractWorkflowName(text) {
  const raw = normalize(text);
  for (const re of WORKFLOW_NAME_PATTERNS) {
    const m = raw.match(re);
    if (m?.[1]) return m[1].trim();
  }
  const slug = raw.match(/\b([a-z][a-z0-9-]{2,48})\b/i);
  if (slug && /invoice|download|portal|login|search|batch/i.test(slug[1])) return slug[1];
  return '';
}

function extractStartUrl(text) {
  const m = normalize(text).match(URL_RE);
  return m ? m[0] : '';
}

function extractBatchPath(text) {
  const m = normalize(text).match(/(?:[\w./\\-]+)\.(csv|xlsx|json)/i);
  return m ? m[0] : '';
}

function profileModeFromChoice(choice) {
  if (choice === '1') return 'ephemeral';
  if (choice === '2') return 'persistent';
  if (choice === '3') return 'workflow';
  return '';
}

function buildProfilePrompt(workflowName) {
  const wf = workflowName || '(未命名)';
  return (
    `要开始 **${wf}** 网站学习。请回复 Chrome 打开方式（**1 / 2 / 3**）：\n\n` +
    `**1** — 全新（不保留 cookie，适合第一次登录）\n` +
    `**2** — 绑定 profile（保留 cookie，下次还用这份登录态）\n` +
    `**3** — 继续已有 workflow（在 \`${wf}\` 的 profile 上接着学）`
  );
}

/**
 * @returns {'learn_start'|'learn_done'|'simulate_once'|'batch_run'|'list_workflows'|'profile_choice'|null}
 */
function classifyWebsiteLearnMessage(text) {
  const raw = normalize(text);
  if (!raw) return null;
  if (PROFILE_CHOICE_RE.test(raw) && require('./website-learn-engine').getPendingIntake()?.waitingForProfile) {
    return 'profile_choice';
  }
  if (matchesAny(raw, LEARN_DONE_PATTERNS)) return 'learn_done';
  if (matchesAny(raw, SIMULATE_PATTERNS)) return 'simulate_once';
  if (matchesAny(raw, BATCH_PATTERNS)) return 'batch_run';
  if (matchesAny(raw, LIST_WORKFLOWS_PATTERNS)) return 'list_workflows';
  if (matchesAny(raw, LEARN_START_PATTERNS)) return 'learn_start';
  return null;
}

function buildWorkflowListReply() {
  const engine = require('./website-learn-engine');
  const list = engine.listWorkflows();
  if (!list.length) {
    return '目前还没有已保存的 website workflow。说「进入学习模式 workflow invoice-download」开始。';
  }
  const lines = list.map(
    (w, i) => `${i + 1}. **${w.workflow_name}** — ${w.status}${w.completed_at ? ` (${w.completed_at.slice(0, 10)})` : ''}`,
  );
  return `已保存 **${list.length}** 个 workflow：\n\n${lines.join('\n')}`;
}

module.exports = {
  classifyWebsiteLearnMessage,
  extractWorkflowName,
  extractStartUrl,
  extractBatchPath,
  profileModeFromChoice,
  buildProfilePrompt,
  buildWorkflowListReply,
  PROFILE_CHOICE_RE,
};
