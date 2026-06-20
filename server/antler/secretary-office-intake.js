/**
 * Secretary office status intake — who's working, hired team (no exec / no CEO).
 */

const office = require('./office-state');

const OFFICE_STATUS_PATTERNS = [
  /谁.*(在做工|上班|工作|忙)/,
  /今天.*谁.*(做|上班|工作)/,
  /谁在.*(office|办公室|公司)/,
  /(有谁|哪些人).*(在工作|上班)/,
  /\bwho.*(working|on duty|in the office)\b/i,
  /team.*(working|status)/i,
];

function classifyOfficeStatusMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  return OFFICE_STATUS_PATTERNS.some((re) => re.test(raw));
}

function agentStatusLine(a) {
  const label = a.label || a.role || a.id;
  const state = a.npcState || 'resting';
  const job = a.currentJob?.label || a.bubbleText || '';
  if (state === 'working' || job) {
    return `- **${label}**：${job || '工作中'}`;
  }
  if (state === 'resting' || !job) {
    return `- ${label}：待命`;
  }
  return `- ${label}：${state}${job ? ` — ${job}` : ''}`;
}

function buildOfficeStatusReply() {
  const agents = (office.state.agents || []).filter((a) => !a.external);
  const onTeam = agents.filter((a) => a.role === 'secretary' || a.userAgentId);
  if (!onTeam.length) {
    return '办公室里还没有聘请同事。可以在 Browse 页面 Hire CEO、Marketing 等角色。';
  }

  const working = onTeam.filter(
    (a) => a.npcState === 'working' || a.bubbleText || a.currentJob?.label,
  );
  const resting = onTeam.filter((a) => !working.includes(a));

  const lines = ['**今天办公室状态**', ''];
  if (working.length) {
    lines.push('**正在工作：**');
    working.forEach((a) => lines.push(agentStatusLine(a)));
    lines.push('');
  } else {
    lines.push('目前没有人正在执行任务，全员待命。', '');
  }

  if (resting.length) {
    lines.push('**待命：**');
    resting.forEach((a) => lines.push(agentStatusLine(a)));
  }

  return lines.join('\n');
}

module.exports = {
  classifyOfficeStatusMessage,
  buildOfficeStatusReply,
  OFFICE_STATUS_PATTERNS,
};
