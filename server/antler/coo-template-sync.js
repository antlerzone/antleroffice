// Auto-sync in-service workers to their role's latest template spec.
//
// The skill-versioning flow (coo-skill-update-notify.js) only covers built-in
// `skillIds` and requires the boss to click "Learn/Update". This module covers
// the other two ways a role can gain capability after a worker was hired:
//   - openclawSkillNames  (e.g. the frontend-taste workflow added to IT roles)
//   - devScope            (e.g. the IT Engineer gaining self-review / canReview)
//
// These are FREE, additive capability expansions, so the heartbeat applies them
// automatically and the COO posts an FYI. SAFETY: serverAccess is NEVER synced
// here (it isn't even in the registry update whitelist) — the CTO's ECS access
// always stays behind the manual SSH setup + per-action approval gates.

const registry = require('./registry-store');
const orgRoles = require('./org-roles');
const bossChat = require('./boss-chat-store');
const agentCatalog = require('./agent-catalog');
const ecsCatalog = require('./ecs-catalog');
const office = require('./office-state');
const debugLog = require('./debug-log');

// Friendly labels for known bundled openclaw workflows (fallback: prettified id).
const OPENCLAW_LABELS = {
  'antleroffice-frontend-taste': '前端审美技能',
  'antleroffice-it-dev-pipeline': 'IT 开发流程',
};

function openclawLabel(name) {
  return OPENCLAW_LABELS[name] || String(name || '').replace(/^antleroffice-/, '').replace(/-/g, ' ');
}

async function resolveTemplate(agent) {
  const tid = agent.templateId;
  try {
    const templates = await ecsCatalog.loadCatalogMerged();
    const found = templates.find(
      (t) =>
        t.id === tid ||
        t.departmentId === tid ||
        t.bundleTemplateId === tid ||
        t.templateId === tid ||
        (agent.role && t.role === agent.role),
    );
    if (found) return found;
  } catch {
    /* fall through to local catalog */
  }
  return (
    (tid && agentCatalog.getTemplate(tid)) ||
    (agent.role && agentCatalog.getTemplate(agent.role)) ||
    null
  );
}

function devScopeEqual(a, b) {
  const na = { canWrite: a?.canWrite !== false, canReview: a?.canReview !== false };
  const nb = { canWrite: b?.canWrite !== false, canReview: b?.canReview !== false };
  return na.canWrite === nb.canWrite && na.canReview === nb.canReview;
}

function describeDevScope(from, to) {
  const parts = [];
  const f = { canWrite: from?.canWrite !== false, canReview: from?.canReview !== false };
  const t = { canWrite: to?.canWrite !== false, canReview: to?.canReview !== false };
  if (!f.canReview && t.canReview) parts.push('开启自审/复查权限');
  if (f.canReview && !t.canReview) parts.push('收回复查权限');
  if (!f.canWrite && t.canWrite) parts.push('开启写代码权限');
  if (f.canWrite && !t.canWrite) parts.push('收回写代码权限');
  return parts.join('、');
}

// Compute (and optionally apply) the drift between a hired worker and its
// role's latest template. Returns { changed, addedOpenclaw[], devScope:{from,to}|null, summary }.
async function syncAgentToTemplate(agent, { apply = true } = {}) {
  const template = await resolveTemplate(agent);
  if (!template) return { changed: false, addedOpenclaw: [], devScope: null, summary: '' };

  const patch = {};
  const addedOpenclaw = [];
  let devScopeChange = null;

  // (1) openclaw workflows — add any bundled by the template that the worker lacks.
  const tplOpenclaw = Array.isArray(template.openclawSkillNames) ? template.openclawSkillNames : [];
  if (tplOpenclaw.length) {
    const current = Array.isArray(agent.openclawSkillNames) ? agent.openclawSkillNames : [];
    const currentSet = new Set(current);
    const missing = tplOpenclaw.filter((n) => !currentSet.has(n));
    if (missing.length) {
      addedOpenclaw.push(...missing);
      const merged = [...current, ...missing];
      patch.openclawSkillNames = merged;
      // Treat synced bundled workflows as "included" going forward.
      const baseline = Array.isArray(agent.baselineOpenclawSkillNames)
        ? agent.baselineOpenclawSkillNames
        : [];
      patch.baselineOpenclawSkillNames = [...new Set([...baseline, ...missing])];
    }
  }

  // (2) devScope — match the template default (NEVER serverAccess).
  if (template.devScopeDefault && typeof template.devScopeDefault === 'object') {
    const to = {
      canWrite: template.devScopeDefault.canWrite !== false,
      canReview: template.devScopeDefault.canReview !== false,
    };
    const from = agent.devScope || {};
    if (!devScopeEqual(from, to)) {
      patch.devScope = to;
      devScopeChange = { from: { canWrite: from.canWrite !== false, canReview: from.canReview !== false }, to };
    }
  }

  const changed = Object.keys(patch).length > 0;
  if (!changed) return { changed: false, addedOpenclaw: [], devScope: null, summary: '' };

  // Build a human summary for the COO notice.
  const bits = [];
  if (addedOpenclaw.length) bits.push(`新增${addedOpenclaw.map(openclawLabel).join('、')}`);
  if (devScopeChange) {
    const d = describeDevScope(devScopeChange.from, devScopeChange.to);
    if (d) bits.push(d);
  }
  const summary = bits.join('；');

  if (apply) {
    const updated = registry.updateAgent(agent.id, patch);
    // Mirror into the live office adapter (same shape learn-skill uses).
    try {
      const isCoo = orgRoles.isCooRole(updated.role);
      const cooStation = isCoo ? office.getAgent('coo') || office.getAgent('ceo') : null;
      const officeTarget =
        isCoo && cooStation?.userAgentId === updated.id ? cooStation.id : `user:${updated.id}`;
      office.setAgent(officeTarget, {
        skillIds: updated.skillIds,
        openclawSkillNames: updated.openclawSkillNames || [],
        devScope: updated.devScope,
      });
    } catch {
      /* office mirror is best-effort */
    }
  }

  return { changed: true, addedOpenclaw, devScope: devScopeChange, summary };
}

// Heartbeat entry: auto-sync every in-service worker, post a COO FYI per change.
async function runTemplateSync({ trigger = 'manual' } = {}) {
  const coo = orgRoles.cooAgentOrFallback();
  const cooName = coo?.label || coo?.name || 'COO';
  let synced = 0;

  const agents = registry.listAgents().filter((a) => !a.fireAt || a.fireAt > Date.now());
  for (const agent of agents) {
    if (orgRoles.isCooRole(agent.role)) continue;
    let res;
    try {
      res = await syncAgentToTemplate(agent, { apply: true });
    } catch (e) {
      debugLog.logInfo('coo-template-sync', 'sync-error', agent.id, e?.message || 'failed');
      continue;
    }
    if (!res.changed) continue;
    synced += 1;

    try {
      const threadId = bossChat.resolveThreadId(coo.id, null, 'local:boss', 'Boss');
      if (threadId) {
        const text =
          `**${cooName}：** ${agent.name} 已自动同步最新能力：${res.summary}（免费，已生效）。`;
        bossChat.addMessage(threadId, coo.id, text, { authorName: cooName });
      }
    } catch {
      /* notice is best-effort */
    }
    debugLog.logInfo('coo-template-sync', 'synced', agent.id, res.summary);
  }

  return { ok: true, synced, trigger };
}

module.exports = { runTemplateSync, syncAgentToTemplate };
