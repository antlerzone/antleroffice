const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');
const office = require('./office-state');
const roster = require('./roster');

const CONFIG_FILE = 'daily-standup.json';

const DEFAULT_PROMPTS = {
  department:
    'You are {{departmentLabel}}. Write a concise department standup report for {{periodLabel}} ({{fromDate}} to {{toDate}}). ' +
    'Cover: completed work, work in progress, blockers, and decisions needed. Use bullet points. ' +
    'Do not greet the boss — this will be read aloud in a meeting.',
  cooSummary:
    'You are the CEO. Below are standup reports from each department for {{periodLabel}}. ' +
    'Write an executive summary: key wins, risks, blockers needing boss decision, and recommended priorities. Keep it concise.',
  ceoSummary:
    'You are the CEO. Below are standup reports from each department for {{periodLabel}}. ' +
    'Write an executive summary: key wins, risks, blockers needing boss decision, and recommended priorities. Keep it concise.',
};

function configPath() {
  return path.join(getDataDir(), CONFIG_FILE);
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeRaw(data) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function listOfficeStandupCandidates() {
  const skip = new Set(['ceo', 'coo', 'secretary']);
  const rosterOrder = roster.DEPARTMENTS.map((d) => d.role);
  const agents = office.state.agents.filter((a) => !skip.has(a.role) && !a.external);
  agents.sort((a, b) => {
    const ai = rosterOrder.indexOf(a.role);
    const bi = rosterOrder.indexOf(b.role);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
  return agents.map((a, index) => ({
    agentId: a.id,
    role: a.role,
    label: a.label || roster.byRole(a.role)?.label || a.role,
    order: index,
  }));
}

function defaultVoice() {
  return { engine: 'edgetts', ttsVoice: '', profileId: '' };
}

function normalizeParticipant(p, fallbackOrder = 0) {
  if (!p || !p.agentId) return null;
  const agent = office.getAgent(p.agentId);
  const dept = agent ? roster.byRole(agent.role) : roster.byRole(p.role);
  return {
    agentId: String(p.agentId),
    role: p.role || agent?.role || dept?.role || 'worker',
    label: p.label || agent?.label || dept?.label || 'Department',
    order: Number.isFinite(p.order) ? p.order : fallbackOrder,
    enabled: p.enabled !== false,
    voice: {
      engine: p.voice?.engine || defaultVoice().engine,
      ttsVoice: p.voice?.ttsVoice || '',
      profileId: p.voice?.profileId || '',
    },
  };
}

function seedParticipants(saved = []) {
  const byId = new Map(saved.map((p) => [p.agentId, p]));
  const candidates = listOfficeStandupCandidates();
  const merged = candidates.map((c, index) => {
    const prev = byId.get(c.agentId);
    return normalizeParticipant(
      prev
        ? { ...prev, label: prev.label || c.label, role: prev.role || c.role }
        : { ...c, enabled: true, voice: defaultVoice() },
      index,
    );
  });
  for (const p of saved) {
    if (!merged.find((m) => m.agentId === p.agentId)) {
      const norm = normalizeParticipant(p, merged.length);
      if (norm) merged.push(norm);
    }
  }
  return merged.sort((a, b) => a.order - b.order).map((p, i) => ({ ...p, order: i }));
}

function defaultConfig() {
  return {
    enabled: false,
    schedule: { cron: '0 8 * * *', tz: '' },
    defaultPeriod: 'yesterday',
    participants: seedParticipants([]),
    prompts: { ...DEFAULT_PROMPTS },
    hostVoice: defaultVoice(),
    ceoVoice: defaultVoice(),
  };
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  const src = raw && typeof raw === 'object' ? raw : {};
  const participants = seedParticipants(
    Array.isArray(src.participants) ? src.participants.map(normalizeParticipant).filter(Boolean) : [],
  );
  return {
    enabled: !!src.enabled,
    schedule: {
      cron: String(src.schedule?.cron || base.schedule.cron),
      tz: String(src.schedule?.tz || ''),
    },
    defaultPeriod: ['yesterday', 'last_week', 'last_7_days'].includes(src.defaultPeriod)
      ? src.defaultPeriod
      : base.defaultPeriod,
    participants,
    hostVoice: {
      engine: src.hostVoice?.engine || base.hostVoice.engine,
      ttsVoice: src.hostVoice?.ttsVoice || '',
      profileId: src.hostVoice?.profileId || '',
    },
    ceoVoice: {
      engine: src.ceoVoice?.engine || base.ceoVoice.engine,
      ttsVoice: src.ceoVoice?.ttsVoice || '',
      profileId: src.ceoVoice?.profileId || '',
    },
    prompts: {
      department: String(src.prompts?.department || DEFAULT_PROMPTS.department),
      cooSummary: String(src.prompts?.cooSummary || src.prompts?.ceoSummary || DEFAULT_PROMPTS.ceoSummary),
      ceoSummary: String(src.prompts?.ceoSummary || src.prompts?.cooSummary || DEFAULT_PROMPTS.ceoSummary),
    },
  };
}

function getConfig() {
  return normalizeConfig(readRaw());
}

function patchConfig(patch = {}) {
  const current = getConfig();
  const next = normalizeConfig({
    ...current,
    ...patch,
    schedule: { ...current.schedule, ...(patch.schedule || {}) },
    prompts: { ...current.prompts, ...(patch.prompts || {}) },
    participants: patch.participants !== undefined ? patch.participants : current.participants,
  });
  writeRaw(next);
  return next;
}

function enabledParticipants(participantIds) {
  const config = getConfig();
  let list = config.participants.filter((p) => p.enabled);
  if (Array.isArray(participantIds) && participantIds.length) {
    const wanted = new Set(participantIds.map(String));
    list = list.filter((p) => wanted.has(p.agentId));
  }
  return list.sort((a, b) => a.order - b.order);
}

function applyTemplate(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

module.exports = {
  getConfig,
  patchConfig,
  enabledParticipants,
  listOfficeStandupCandidates,
  applyTemplate,
  DEFAULT_PROMPTS,
};
