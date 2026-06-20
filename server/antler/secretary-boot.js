/**
 * Install Secretary skills into OpenClaw main workspace + MCP binding.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentCatalog = require('./agent-catalog');
const defaultMcpPack = require('./default-mcp-pack');

const SKILL_FOLDER = 'antleroffice-secretary-fb-login';
const ROUTING_SKILL_FOLDER = 'antleroffice-secretary-routing';
const AGENTS_MARKER = '<!-- antleroffice-secretary-routing -->';

const SECRETARY_AGENTS_BLOCK = `${AGENTS_MARKER}

## Secretary routing (AntlerOffice)

You are the **Secretary** — boss talks to you only.

**Facebook login** → you open Chrome; boss logs in manually; 登好了 → ask if they want to post.

**Facebook group posting** → you pass to **CEO** → CEO assigns **Marketing Junior** to post (you never schedule posts yourself).

**IT Guys / dev pipeline** → if not configured, guide boss to **Settings → Dev tools** (API keys + CLI); when ready, pass dev work to **CEO**.

**Other work** → pass to **CEO**.

**Weather / news / quick facts** → answer yourself with **web search** (never exec for weather).

Never say you cannot log into Facebook — open the browser instead.
`;

function resolveMainWorkspace() {
  try {
    const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
      const cfg = JSON.parse(raw);
      const ws = cfg?.agents?.defaults?.workspace;
      if (ws) {
        return ws.replace(/^~/, os.homedir());
      }
    }
  } catch {
    /* fall through */
  }
  return path.join(os.homedir(), '.openclaw', 'workspace');
}

function ensureSecretaryAgentsMd(workspace) {
  if (!workspace) return { ok: false, error: 'missing workspace' };
  const p = path.join(workspace, 'AGENTS.md');
  let content = '';
  try {
    content = fs.readFileSync(p, 'utf8');
  } catch {
    content = '# Agents\n';
  }
  if (content.includes(AGENTS_MARKER)) return { ok: true, dest: p, skipped: true };
  const next = `${content.trim()}\n\n${SECRETARY_AGENTS_BLOCK}\n`;
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(p, next, 'utf8');
  return { ok: true, dest: p };
}

function installSecretarySkills(workspace) {
  const fb = agentCatalog.installOpenClawSkill(workspace, SKILL_FOLDER);
  const routing = agentCatalog.installOpenClawSkill(workspace, ROUTING_SKILL_FOLDER);
  const agents = ensureSecretaryAgentsMd(workspace);
  return { fb, routing, agents };
}

function installSecretaryFbSkill() {
  const workspace = resolveMainWorkspace();
  return installSecretarySkills(workspace);
}

async function ensureSecretaryMcpBinding() {
  const mcp = await defaultMcpPack.ensureAntlerofficeToolsBinding();
  if (!mcp?.id) return null;

  const existing = defaultMcpPack.getBuiltinRoleBindings('secretary') || [];
  const ids = new Set(existing.map((b) => b.mcpId));
  if (!ids.has(mcp.id)) {
    defaultMcpPack.setBuiltinRoleBindings('secretary', [
      ...existing,
      { mcpId: mcp.id, accountIds: [] },
    ]);
  }
  return mcp.id;
}

async function bootSecretaryFbAssets() {
  const skill = installSecretaryFbSkill();
  let mcpId = null;
  try {
    mcpId = await ensureSecretaryMcpBinding();
  } catch (e) {
    return { ok: false, skill, mcpId, error: e.message };
  }
  const ok = skill.fb?.ok !== false && skill.routing?.ok !== false;
  return { ok, skill, mcpId };
}

module.exports = {
  bootSecretaryFbAssets,
  installSecretaryFbSkill,
  installSecretarySkills,
  ensureSecretaryMcpBinding,
  resolveMainWorkspace,
  SKILL_FOLDER,
  ROUTING_SKILL_FOLDER,
};
