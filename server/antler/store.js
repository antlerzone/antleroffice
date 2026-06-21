const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let dataDir = process.env.ANTLEROFFICE_DATA_DIR || path.join(os.homedir(), '.antleroffice2');

function setDataDir(dir) {
  if (dir) dataDir = dir;
  ensureDir(dataDir);
  ensureDir(path.join(dataDir, 'notes'));
  ensureDir(path.join(dataDir, 'deliverables'));
  ensureDir(path.join(dataDir, 'materials'));
  ensureDir(path.join(dataDir, 'voice-profiles'));
  return dataDir;
}

function getDataDir() {
  ensureDir(dataDir);
  return dataDir;
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function settingsPath() {
  return path.join(getDataDir(), 'settings.json');
}

const DEFAULT_SETTINGS = {
  defaultProvider: 'demo',
  providers: {
    openai: { apiKey: '', model: 'gpt-4o-mini' },
    anthropic: { apiKey: '', model: 'claude-3-5-sonnet-latest' },
    gemini: { apiKey: '', model: 'gemini-1.5-flash' },
  },
  // Per-NPC "brain": { mode: 'ai' | 'ecs', provider: 'openai' | ..., ecs: '' }
  npcBrains: {
    customer_service: { mode: 'ai', provider: '' },
    marketing: { mode: 'ai', provider: '' },
    graphic_design: { mode: 'ai', provider: '' },
    accounting: { mode: 'ai', provider: '' },
    admin: { mode: 'ai', provider: '' },
    it: { mode: 'ai', provider: '' },
  },
  // Login / subscription gate. Empty baseUrl => mock mode (see server/auth.js).
  auth: { baseUrl: '', loginPath: '/login' },
  // Outbound notifications to the boss's phone (Telegram). Send is wired in Phase 2.
  notifications: {
    forwardDeliverables: false,
    telegram: { enabled: false, botToken: '', chatId: '' },
  },
  // External runtimes AntlerOffice drives. OpenClaw = executor, Hermes = memory.
  // mode 'cli' spawns the command; 'gateway' calls the HTTP/RPC endpoint.
  // Empty cmd => the runtime adapter falls back to local demo mode.
  runtimes: {
    openclaw: { mode: 'cli', cmd: 'openclaw', baseUrl: 'http://127.0.0.1:18789', agentId: 'main', local: true },
    hermes: { mode: 'cli', cmd: 'hermes', baseUrl: '' },
  },
  // On-demand ECS mirror (poll /api/sync/pending when website requests a snapshot).
  sync: { enabled: true, intervalMs: 0 },
  selectedOfficeId: null,
  activeDesktopId: null,
  // Non-technical users never see JSON/CLI. Turning this on reveals raw logs.
  advanced: { showRawOutput: false },
  // Shared materials library — boss-visible folder OpenClaw can read/write.
  materials: { rootPath: '' },
  // Default MCP pack (Playwright / Perplexity / Firecrawl) — applied by installer or server auto-setup.
  defaultMcpPack: {
    enabled: false,
    version: 0,
    installedAt: null,
    slugToMcpId: {},
    roles: { coo: true, admin: true, it: true },
  },
  // First-run UX — persisted in ~/.antleroffice2/settings.json (survives login/logout).
  onboarding: {
    stackReady: false,
    installerComplete: false,
    aiConfigured: false,
    aiSkipped: false,
  },
  // Boss-facing labels — shown in org chart, boss chat, portal, ECS heartbeat.
  office: {
    bossDisplayName: '',
    desktopDisplayName: '',
    models: {
      cooModel: '',
      workerModel: '',
    },
    companyFramework: {
      enabled: true,
      productName: '',
      productSummary: '',
      inScope: [],
      outOfScope: [],
      futurePlan: [],
      futurePlanCompleted: [],
      primaryRepo: '',
    },
  },
  // Local dev pipeline (Cursor CLI + Codex CLI) — Plan A: AntlerOffice spawn, not OpenClaw MCP.
  dev: {
    projectRootOverride: null,
    cursorCommand: 'cursor-agent',
    cursorVersionDir: null,
    cursorApiKey: '',
    codexApiKey: '',
    claudeApiKey: '',
    claudeCommand: 'claude',
    codexCommand: 'codex',
    maxReviewRounds: 3,
    cursorModel: 'composer-2.5',
    claudeModel: '',
    branchPrefix: 'antleroffice/task-',
    scanBeforeItFix: true,
    cursorTimeoutMs: 600000,
    codexTimeoutMs: 300000,
    claudeTimeoutMs: 600000,
    devTeam: {
      writerAgentId: null,
      reviewerAgentIds: [],
    },
  },
};

function readSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return mergeDefaults(parsed);
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

function mergeDefaults(s) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!s || typeof s !== 'object') return out;
  if (s.defaultProvider) out.defaultProvider = s.defaultProvider;
  if (s.providers) {
    for (const key of Object.keys(out.providers)) {
      if (s.providers[key]) out.providers[key] = { ...out.providers[key], ...s.providers[key] };
    }
  }
  if (s.npcBrains) out.npcBrains = { ...out.npcBrains, ...s.npcBrains };
  if (s.auth) out.auth = { ...out.auth, ...s.auth };
  if (s.notifications) {
    out.notifications = {
      ...out.notifications,
      ...s.notifications,
      telegram: { ...out.notifications.telegram, ...(s.notifications.telegram || {}) },
    };
  }
  if (s.runtimes) {
    out.runtimes = {
      openclaw: { ...out.runtimes.openclaw, ...(s.runtimes.openclaw || {}) },
      hermes: { ...out.runtimes.hermes, ...(s.runtimes.hermes || {}) },
    };
  }
  if (s.sync) out.sync = { ...out.sync, ...s.sync };
  if (s.advanced) out.advanced = { ...out.advanced, ...s.advanced };
  if (s.materials) out.materials = { ...out.materials, ...s.materials };
  if (s.defaultMcpPack) out.defaultMcpPack = { ...out.defaultMcpPack, ...s.defaultMcpPack };
  if (s.onboarding) out.onboarding = { ...out.onboarding, ...s.onboarding };
  if (s.office) {
    out.office = { ...out.office, ...s.office };
    if (s.office.models) out.office.models = { ...out.office.models, ...(s.office.models || {}) };
    if (s.office.companyFramework && typeof s.office.companyFramework === 'object') {
      out.office.companyFramework = {
        ...out.office.companyFramework,
        ...s.office.companyFramework,
      };
    }
  }
  if (s.dev) out.dev = { ...out.dev, ...s.dev };
  if (typeof s.selectedOfficeId === 'string' || s.selectedOfficeId === null) {
    out.selectedOfficeId = s.selectedOfficeId;
  }
  if (typeof s.activeDesktopId === 'string' || s.activeDesktopId === null) {
    out.activeDesktopId = s.activeDesktopId;
  }
  return out;
}

function writeSettings(next) {
  const merged = mergeDefaults(next);
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = {
  setDataDir,
  getDataDir,
  ensureDir,
  readSettings,
  writeSettings,
  DEFAULT_SETTINGS,
};
