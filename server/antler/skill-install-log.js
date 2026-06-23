/**
 * skill-install-log.js
 *
 * Records every Skill / MCP installation that happens in AntlerOffice.
 * Data is stored locally at ~/.antleroffice2/skill-install-log.json
 * and optionally pushed to the SaaS admin via webhook.
 *
 * Used by:
 *   - NPC onboarding wizard completions
 *   - COO auto-install flow (Phase 2)
 *   - Manual installs from Settings
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

// ── Helpers ──────────────────────────────────────────────────────────────────

function logPath() {
  return path.join(store.getDataDir(), 'skill-install-log.json');
}

function readLog() {
  try {
    const raw = fs.readFileSync(logPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLog(entries) {
  fs.writeFileSync(logPath(), JSON.stringify(entries, null, 2), 'utf8');
}

function generateId() {
  return `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Webhook ──────────────────────────────────────────────────────────────────

async function notifyAdminWebhook(entry) {
  const url = process.env.ANTLER_ADMIN_WEBHOOK_URL;
  if (!url) return;

  // Respect user's consent choice — null (not yet asked) and false both opt out
  const profile = store.readSettings().companyProfile || {};
  if (profile.shareInstallData !== true) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'skill_installed',
        ...entry,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    // Non-fatal — log locally even if webhook fails
    console.warn('[skill-install-log] Webhook failed:', e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a skill installation.
 *
 * @param {object} opts
 * @param {string} opts.skillName          Human-readable name, e.g. "WhatsApp MCP"
 * @param {string} [opts.skillId]          Unique ID from registry, if available
 * @param {string} opts.source             'antleroffice-store' | 'openclaw-registry' | 'github' | 'manual' | 'npc-onboarding'
 * @param {string} [opts.sourceUrl]        URL / repo the skill was fetched from
 * @param {string} [opts.npcTemplateId]    NPC template that triggered the install, e.g. "marketing_junior"
 * @param {string} [opts.npcName]          Display name of the NPC
 * @param {string} [opts.tenantId]         Tenant/user identifier from boss session
 * @param {'user'|'coo-auto'} [opts.triggeredBy]  Who triggered the install
 * @param {'installed'|'failed'|'skipped'} [opts.status]
 * @param {string} [opts.errorMessage]     Only if status === 'failed'
 */
async function recordInstall(opts = {}) {
  const entry = {
    id: generateId(),
    skillName: String(opts.skillName || 'Unknown Skill'),
    skillId: opts.skillId || null,
    source: opts.source || 'manual',
    sourceUrl: opts.sourceUrl || null,
    npcTemplateId: opts.npcTemplateId || null,
    npcName: opts.npcName || null,
    tenantId: opts.tenantId || 'local',
    triggeredBy: opts.triggeredBy || 'user',
    status: opts.status || 'installed',
    errorMessage: opts.errorMessage || null,
    installedAt: new Date().toISOString(),
  };

  const entries = readLog();
  entries.unshift(entry); // newest first
  // Keep last 1000 entries
  if (entries.length > 1000) entries.splice(1000);
  writeLog(entries);

  // Fire-and-forget webhook — don't block the caller
  void notifyAdminWebhook(entry);

  return entry;
}

/**
 * List all recorded installs.
 * @param {object} [opts]
 * @param {number} [opts.limit=100]
 * @param {string} [opts.npcTemplateId]   Filter by NPC
 * @param {string} [opts.source]          Filter by source
 * @param {string} [opts.status]          Filter by status
 */
function listInstalls(opts = {}) {
  let entries = readLog();

  if (opts.npcTemplateId) {
    entries = entries.filter((e) => e.npcTemplateId === opts.npcTemplateId);
  }
  if (opts.source) {
    entries = entries.filter((e) => e.source === opts.source);
  }
  if (opts.status) {
    entries = entries.filter((e) => e.status === opts.status);
  }

  const limit = Number(opts.limit) || 100;
  return entries.slice(0, limit);
}

/**
 * Aggregate: returns a summary of installs grouped by skillName + source.
 * Useful for the admin dashboard to see "X users installed WhatsApp MCP".
 */
function getInstallSummary() {
  const entries = readLog();
  const map = {};

  for (const e of entries) {
    const key = `${e.skillName}::${e.source}`;
    if (!map[key]) {
      map[key] = {
        skillName: e.skillName,
        skillId: e.skillId,
        source: e.source,
        sourceUrl: e.sourceUrl,
        installCount: 0,
        failCount: 0,
        npcTemplates: new Set(),
        lastInstalledAt: null,
      };
    }
    const g = map[key];
    if (e.status === 'installed') g.installCount++;
    if (e.status === 'failed') g.failCount++;
    if (e.npcTemplateId) g.npcTemplates.add(e.npcTemplateId);
    if (!g.lastInstalledAt || e.installedAt > g.lastInstalledAt) {
      g.lastInstalledAt = e.installedAt;
    }
  }

  return Object.values(map).map((g) => ({
    ...g,
    npcTemplates: Array.from(g.npcTemplates),
  })).sort((a, b) => b.installCount - a.installCount);
}

module.exports = {
  recordInstall,
  listInstalls,
  getInstallSummary,
};
