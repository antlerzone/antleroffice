// Detect when an agent turn should stay open and ask the boss for credentials
// instead of posting "finished — done".

const { mcpHasCredentials } = require('./mcp-runtime-helper');

const BOSS_INPUT_PATTERNS = [
  /missing api key/i,
  /api keys? (are |is )?(required|needed|missing)/i,
  /need(s)? (an? )?api key/i,
  /no api key/i,
  /invalid api key/i,
  /unauthorized/i,
  /permission denied/i,
  /access denied/i,
  /credentials? required/i,
  /oauth/i,
  /set up api key/i,
  /configure.*api key/i,
  /do you have.*(api )?key/i,
  /do you have.*token/i,
  /paste.*(api )?key/i,
  /provide.*(api )?key/i,
  /settings.*integrations/i,
  /you may want to set up/i,
  /alternatively.*set up/i,
  /manually review.*visit/i,
  /can't access.*due to/i,
  /cannot access.*due to/i,
  /tools? (meant |required ).*api key/i,
];

const GIVE_UP_PATTERNS = [
  /let me know if you/i,
  /if you have specific/i,
  /if there are specific/i,
  /feel free to/i,
  /you can manually/i,
];

function needsBossInput(text, { authError, error, toolAuthBlocked } = {}) {
  if (authError || toolAuthBlocked) return true;
  const blob = `${text || ''}\n${error || ''}`;
  if (BOSS_INPUT_PATTERNS.some((re) => re.test(blob))) return true;
  if (GIVE_UP_PATTERNS.some((re) => re.test(blob)) && /api key|permission|unauthorized|credentials/i.test(blob)) {
    return true;
  }
  return false;
}

function formatUnconfiguredMcpAskBlock(allMcpServers) {
  const missing = (Array.isArray(allMcpServers) ? allMcpServers : []).filter((s) => s && !mcpHasCredentials(s));
  if (!missing.length) return '';
  const lines = missing.map((s) => `- ${s.name || s.slug || s.id} (needs API key in Settings → Integrations → MCP)`);
  return (
    'Optional MCP tools not configured yet:\n' +
    `${lines.join('\n')}\n` +
    'If built-in OpenClaw tools (exec, browser) cannot finish the task and one of the above would help, ' +
    'ASK THE BOSS in chat: "Do you have a [service] API key? Paste it here or add it under Settings → Integrations → MCP." ' +
    'Stay in the conversation — do NOT mark the task complete or tell the boss to go do it alone.'
  );
}

function bossInputEscalationBlock() {
  return (
    'Credential & permission policy:\n' +
    '1. Try OpenClaw built-in tools (exec, browser) first.\n' +
    '2. If a skill/MCP fails for missing API key, OAuth, or permission — ASK THE BOSS whether they have the key. ' +
    'Offer: paste in chat OR Settings → Accounts → MCP (or OpenClaw model key under Models).\n' +
    '3. Do NOT reply as if the job is finished when you are blocked on credentials. Ask one clear question and wait.\n' +
    '4. Do NOT deflect with "visit the site manually" while a configured tool could work after the boss provides a key.'
  );
}

function bossInputAskMessage({ agentLabel = 'CEO', provider } = {}) {
  const name = agentLabel || 'Agent';
  const via = provider ? ` (${provider})` : '';
  return `${name} needs your input${via} — reply with the API key or add it under Settings → Models, then send your message again.`;
}

function scanMessagesForToolAuthBlock(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    const role = String(m?.role || '').toLowerCase();
    if (role !== 'toolresult' && role !== 'tool_result') continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    const blob = parts.map((p) => p?.text || '').join('\n');
    if (/api key|unauthorized|401|permission|forbidden|credentials? required|missing.*key/i.test(blob)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  needsBossInput,
  formatUnconfiguredMcpAskBlock,
  bossInputEscalationBlock,
  bossInputAskMessage,
  scanMessagesForToolAuthBlock,
};
