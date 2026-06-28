// COO skill-update notifications (流程一 — system push).
//
// Built-in skills carry an integer version (see skill-meta.js). When a role gains
// a new built-in skill *after* a worker was hired, this module has the COO post a
// one-time message in Boss Chat asking whether the boss wants that worker to learn
// the new (free) skill. The boss can accept by opening the worker's detail page and
// clicking "Learn skill" (流程二).
//
// Design rules honoured here:
//   - Notify ONCE per (worker, skill, version). If the boss ignores it, we never
//     nag again — they can still self-serve from the detail page.
//   - Built-in skills are free, so the notice never mentions price.
//   - "New since hire" = the role's current catalog skills minus the snapshot of
//     skills the worker had at hire (baselineSkillIds). Workers with no baseline
//     snapshot fall back to their current skills, so nothing old is mis-flagged.

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');
const store = require('./store');
const registry = require('./registry-store');
const orgRoles = require('./org-roles');
const bossChat = require('./boss-chat-store');
const agentCatalog = require('./agent-catalog');
const ecsCatalog = require('./ecs-catalog');
const debugLog = require('./debug-log');
const { runBrain } = require('./llm');
const { asVersion } = require('./skill-meta');

const NOTIFIED_FILE = 'skill-update-notified.json';

function notifiedPath() {
  return path.join(getDataDir(), NOTIFIED_FILE);
}

function readNotified() {
  try {
    const d = JSON.parse(fs.readFileSync(notifiedPath(), 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

function writeNotified(data) {
  try {
    fs.writeFileSync(notifiedPath(), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* best-effort */
  }
}

function notifyKey(agentId, skillId, version) {
  return `${agentId}::${skillId}::v${asVersion(version)}`;
}

// Resolve the role's latest built-in skill set for a hired agent.
async function latestRoleSkillIds(agent) {
  let catalog = null;
  try {
    const templates = await ecsCatalog.loadCatalogMerged();
    const tid = agent.templateId;
    catalog =
      templates.find(
        (t) =>
          t.id === tid ||
          t.departmentId === tid ||
          t.bundleTemplateId === tid ||
          t.templateId === tid ||
          (agent.role && t.role === agent.role),
      ) || null;
    if (!catalog && tid) catalog = agentCatalog.getTemplate(tid);
    if (!catalog && agent.role) catalog = agentCatalog.getTemplate(agent.role);
  } catch {
    catalog =
      (agent.templateId && agentCatalog.getTemplate(agent.templateId)) ||
      (agent.role && agentCatalog.getTemplate(agent.role)) ||
      null;
  }
  if (catalog && Array.isArray(catalog.skillIds) && catalog.skillIds.length) {
    return catalog.skillIds;
  }
  return [];
}

function skillDef(skillId, agent) {
  const managed = registry.listSkills().find((s) => s.id === skillId);
  if (managed) return managed;
  return agentCatalog.bundledSkillDef(skillId, agent.templateId) || null;
}

// Find new-since-hire built-in skills a worker has not learned yet and that we
// have not already notified about at their current version.
async function findUpdatesForAgent(agent, notified) {
  const latest = await latestRoleSkillIds(agent);
  if (!latest.length) return [];
  // Legacy workers hired before skill-versioning carry no baseline snapshot.
  // Adopt the role's current skill set as their baseline (once) so we only ever
  // notify about skills added *after* now — never nag about pre-existing ones.
  if (!Array.isArray(agent.baselineSkillIds) || !agent.baselineSkillIds.length) {
    try {
      registry.updateAgent(agent.id, { baselineSkillIds: latest });
    } catch {
      /* best-effort backfill */
    }
    return [];
  }
  const baselineSet = new Set(agent.baselineSkillIds);
  const learnedSet = new Set(agent.skillIds || []);
  const out = [];

  // (a) Brand-new built-in skills added to the role after this worker was hired.
  for (const sid of latest) {
    if (baselineSet.has(sid)) continue; // existed at hire — not new
    if (learnedSet.has(sid)) continue; // already learned
    const def = skillDef(sid, agent);
    const version = asVersion(def?.version);
    if (notified[notifyKey(agent.id, sid, version)]) continue; // already told once
    out.push({
      kind: 'new',
      skillId: sid,
      name: def?.name || String(sid).replace(/_/g, ' '),
      description: typeof def?.description === 'string' ? def.description : '',
      version,
    });
  }

  // (b) Already-learned skills that have since been upgraded to a newer version.
  // Workers with no recorded learned-version (legacy) are adopted at the current
  // version once, so we never falsely flag a skill as "upgraded".
  const learnedVersions = agent.skillVersions && typeof agent.skillVersions === 'object'
    ? agent.skillVersions
    : {};
  let backfill = null;
  for (const sid of learnedSet) {
    const def = skillDef(sid, agent);
    if (!def) continue;
    const latestV = asVersion(def.version);
    const learnedV = learnedVersions[sid];
    if (learnedV == null) {
      backfill = backfill || { ...learnedVersions };
      backfill[sid] = latestV;
      continue;
    }
    if (asVersion(learnedV) >= latestV) continue; // already on the latest
    if (notified[notifyKey(agent.id, sid, latestV)]) continue;
    out.push({
      kind: 'upgrade',
      skillId: sid,
      name: def.name || String(sid).replace(/_/g, ' '),
      description: typeof def.description === 'string' ? def.description : '',
      version: latestV,
      fromVersion: asVersion(learnedV),
    });
  }
  if (backfill) {
    try {
      registry.updateAgent(agent.id, { skillVersions: backfill });
    } catch {
      /* best-effort */
    }
  }

  return out;
}

function defaultMessage({ cooName, agentName, name, description, version, kind }) {
  const desc = description ? `——${description}` : '';
  if (kind === 'upgrade') {
    return (
      `**${cooName}：** ${agentName} 学过的「${name}」升级到 v${version} 了${desc}（免费）。` +
      `要让 ${agentName} 更新到最新版吗？打开 ${agentName} 的详情页，点「Update」就行。`
    );
  }
  return (
    `**${cooName}：** ${agentName} 有个新本领可以学了：「${name}」${desc}（v${version}，免费）。` +
    `要让 ${agentName} 学起来吗？打开 ${agentName} 的详情页，点「Learn skill」就行。`
  );
}

async function cooCopy(ctx) {
  try {
    const settings = store.readSettings();
    const brain =
      settings.npcBrains?.coo ||
      settings.npcBrains?.secretary || { mode: 'ai', provider: settings.defaultProvider };
    const provider = brain?.provider || settings.defaultProvider;
    const cfg = settings.providers?.[provider];
    if (!provider || provider === 'demo' || !cfg?.apiKey) {
      return defaultMessage(ctx);
    }
    const isUpgrade = ctx.kind === 'upgrade';
    const { text } = await runBrain({
      settings,
      brain,
      system: isUpgrade
        ? '你是公司的 COO，用一句自然、口语化的中文提醒老板：某位员工学过的某技能升级到新版了，可以免费更新。' +
          '要简短友好，不要夸张，结尾轻轻问一句要不要更新到最新版。'
        : '你是公司的 COO，用一句自然、口语化的中文提醒老板：某位员工有个新技能可以免费学。' +
          '要简短友好，不要夸张、不要用感叹号堆砌，结尾轻轻问一句要不要让他学。',
      prompt: isUpgrade
        ? `员工：${ctx.agentName}\n技能：${ctx.name}（已升级到 v${ctx.version}，免费）\n` +
          `更新说明：${ctx.description || '（暂无说明）'}\n` +
          `提示老板：可在该员工详情页点「Update」更新到最新版。`
        : `员工：${ctx.agentName}\n新技能：${ctx.name}（v${ctx.version}，免费）\n` +
          `技能说明：${ctx.description || '（暂无说明）'}\n` +
          `提示老板：可在该员工详情页点「Learn skill」学习。`,
    });
    const line = String(text || '').trim();
    return line ? `**${ctx.cooName}：** ${line}` : defaultMessage(ctx);
  } catch {
    return defaultMessage(ctx);
  }
}

async function runSkillUpdateNotifications({ trigger = 'manual' } = {}) {
  const notified = readNotified();
  const coo = orgRoles.cooAgentOrFallback();
  const cooName = coo?.label || coo?.name || 'COO';
  const ownerKey = 'local:boss';
  const ownerName = 'Boss';

  let posted = 0;
  const agents = registry.listAgents().filter((a) => !a.fireAt || a.fireAt > Date.now());

  for (const agent of agents) {
    if (orgRoles.isCooRole(agent.role)) continue; // don't pester the boss about the COO itself
    let updates = [];
    try {
      updates = await findUpdatesForAgent(agent, notified);
    } catch {
      updates = [];
    }
    if (!updates.length) continue;

    const threadId = bossChat.resolveThreadId(coo.id, null, ownerKey, ownerName);
    if (!threadId) continue;

    for (const u of updates) {
      const text = await cooCopy({
        cooName,
        agentName: agent.name,
        name: u.name,
        description: u.description,
        version: u.version,
        kind: u.kind,
      });
      try {
        bossChat.addMessage(threadId, coo.id, text, { authorName: cooName });
        notified[notifyKey(agent.id, u.skillId, u.version)] = Date.now();
        posted += 1;
      } catch {
        /* keep going */
      }
    }
  }

  if (posted) writeNotified(notified);
  debugLog.logInfo('coo-skill-update', 'posted', posted, trigger);
  return { ok: true, posted };
}

module.exports = {
  runSkillUpdateNotifications,
  findUpdatesForAgent,
  readNotified,
};
