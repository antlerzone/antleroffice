/**
 * tool-intake.js
 *
 * COO intelligence layer for processing incoming GitHub repos, API PDFs and
 * API detail text that the boss drops into BossChat.
 *
 * Flow:
 *   1. Boss pastes GitHub URLs / PDF / API text → handleInstruction() calls us
 *   2. We analyse every item: type, description, relevance, already-installed?
 *   3. We inject a formatted analysis block back into the COO instruction
 *   4. COO presents the analysis to the boss and asks which to install
 *   5. Boss confirms → POST /api/tool-intake/install-selected
 *   6. We register the MCP in AntlerOffice registry + log the install
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const registry = require('./registry-store');
const skillInstallLog = require('./skill-install-log');

// ── Constants ─────────────────────────────────────────────────────────────────

const GITHUB_RE =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?\/?/g;

const RAW_BASE = 'https://raw.githubusercontent.com';

/** Keyword → companyProfile goal mapping for relevance scoring */
const KEYWORD_GOAL_MAP = {
  accounting: ['invoice', 'receipt', 'accounting', 'bookkeep', 'expense', 'tax', 'financial', 'ledger', 'bukku', 'quickbooks', 'xero', 'wave'],
  marketing: ['marketing', 'email', 'campaign', 'mailchimp', 'sendgrid', 'newsletter', 'ads', 'facebook', 'instagram', 'twitter', 'linkedin', 'seo', 'analytics'],
  content: ['content', 'blog', 'notion', 'wordpress', 'cms', 'article', 'copywriting', 'social media post'],
  sales: ['sales', 'crm', 'hubspot', 'salesforce', 'pipedrive', 'lead', 'pipeline', 'deal', 'prospect'],
  customer_service: ['customer service', 'support', 'whatsapp', 'telegram', 'zendesk', 'intercom', 'chat', 'helpdesk', 'ticket'],
  admin: ['calendar', 'email', 'gmail', 'outlook', 'schedule', 'meeting', 'admin', 'document', 'spreadsheet'],
  dev: ['github', 'gitlab', 'code', 'repository', 'git', 'deploy', 'ci/cd', 'developer', 'api'],
  hr: ['payroll', 'hr', 'employee', 'onboarding', 'bamboo', 'workday', 'leave', 'attendance'],
};

// ── Pending installs store (in-memory + persisted to disk) ───────────────────

function pendingPath() {
  return path.join(store.getDataDir(), 'tool-intake-pending.json');
}

function readPending() {
  try {
    const raw = fs.readFileSync(pendingPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePending(items) {
  fs.writeFileSync(pendingPath(), JSON.stringify(items, null, 2), 'utf8');
}

function stagePendingInstalls(items) {
  writePending(items);
}

function getPendingInstalls() {
  return readPending();
}

function clearPendingInstalls() {
  writePending([]);
}

// ── URL / text extraction ─────────────────────────────────────────────────────

/**
 * Extract { owner, repo, url } tuples from raw text.
 * Deduplicated by owner/repo.
 */
function extractGitHubUrls(text) {
  const seen = new Set();
  const results = [];
  const re = new RegExp(GITHUB_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const [url, owner, repo] = m;
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ owner, repo, url: `https://github.com/${owner}/${repo}` });
    }
  }
  return results;
}

/**
 * Check if text contains any GitHub URLs.
 */
function hasGitHubUrls(text) {
  const re = new RegExp(GITHUB_RE.source, 'gi');
  return re.test(text);
}

/**
 * Check if attachments include PDFs that look like API docs.
 */
function extractApiPdfs(attachments = []) {
  return attachments.filter((a) => {
    const name = String(a?.name || a?.path || '').toLowerCase();
    return name.endsWith('.pdf');
  });
}

// ── GitHub analysis ───────────────────────────────────────────────────────────

/**
 * Fetch a URL with a short timeout. Returns text or null on failure.
 */
async function fetchText(url, timeoutMs = 8000) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AntlerOffice/2.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Detect tool type from package.json content.
 * Returns: 'mcp_server' | 'cli_tool' | 'npm_library' | 'unknown'
 */
function detectTypeFromPackageJson(pkg) {
  if (!pkg || typeof pkg !== 'object') return 'unknown';

  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
  };

  const keywords = (pkg.keywords || []).map((k) => String(k).toLowerCase());
  const desc = String(pkg.description || '').toLowerCase();
  const name = String(pkg.name || '').toLowerCase();

  const isMcp =
    '@modelcontextprotocol/sdk' in deps ||
    keywords.includes('mcp') ||
    keywords.includes('mcp-server') ||
    keywords.includes('model-context-protocol') ||
    name.includes('mcp') ||
    desc.includes('mcp server') ||
    desc.includes('model context protocol');

  if (isMcp) return 'mcp_server';

  const isCli = pkg.bin && Object.keys(pkg.bin).length > 0;
  if (isCli) return 'cli_tool';

  return 'npm_library';
}

/**
 * Try to extract a short description from README text.
 */
function extractReadmeDescription(readmeText, maxLen = 300) {
  if (!readmeText) return '';
  // Strip markdown headers and badges, get first paragraph
  const clean = readmeText
    .replace(/!\[.*?\]\(.*?\)/g, '') // images
    .replace(/\[!\[.*?\]\(.*?\)\]\(.*?\)/g, '') // badge links
    .replace(/#{1,6}\s+.+/g, '') // headers
    .replace(/```[\s\S]*?```/g, '') // code blocks
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1)) // inline code
    .trim();

  // Find first non-empty paragraph
  const paras = clean.split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  return (paras[0] || '').slice(0, maxLen);
}

/**
 * Extract npm package name from package.json or README install instructions.
 */
function extractNpmPackageName(pkg, readmeText) {
  if (pkg?.name) return pkg.name;
  // Look for `npm install <package>` in README
  const m = String(readmeText || '').match(/npm\s+install\s+(?:-g\s+)?([^\s"'`\n]+)/i);
  if (m) return m[1];
  return null;
}

/**
 * Extract npx command from README.
 */
function extractNpxCommand(readmeText) {
  const m = String(readmeText || '').match(/npx\s+(?:-y\s+)?([^\s"'`\n]+)/i);
  if (m) return m[1];
  return null;
}

/**
 * Detect if it's a Python-based tool.
 */
async function isPythonProject(owner, repo) {
  const setupPy = await fetchText(`${RAW_BASE}/${owner}/${repo}/main/setup.py`, 3000);
  const pyproject = await fetchText(`${RAW_BASE}/${owner}/${repo}/main/pyproject.toml`, 3000);
  const requirementsTxt = await fetchText(`${RAW_BASE}/${owner}/${repo}/main/requirements.txt`, 3000);
  return !!(setupPy || pyproject || requirementsTxt);
}

/**
 * Full GitHub repo analysis.
 */
async function analyzeGitHubRepo({ owner, repo, url }) {
  const result = {
    url,
    owner,
    repo,
    name: repo,
    type: 'unknown', // 'mcp_server' | 'cli_tool' | 'npm_library' | 'python_tool' | 'unknown'
    language: 'unknown',
    description: '',
    npmPackage: null,
    npxCommand: null,
    installCommand: null,
    relevanceScore: 0,
    relevantGoals: [],
    alreadyInstalled: false,
    alreadyInstalledAs: null,
    canAutoInstall: false,
    error: null,
  };

  try {
    // 1. Try package.json (main branch, then master)
    let pkgText = await fetchText(`${RAW_BASE}/${owner}/${repo}/main/package.json`);
    if (!pkgText) pkgText = await fetchText(`${RAW_BASE}/${owner}/${repo}/master/package.json`);
    let pkg = null;
    if (pkgText) {
      try { pkg = JSON.parse(pkgText); } catch { /* ignore */ }
    }

    // 2. README
    let readmeText = await fetchText(`${RAW_BASE}/${owner}/${repo}/main/README.md`);
    if (!readmeText) readmeText = await fetchText(`${RAW_BASE}/${owner}/${repo}/master/README.md`);

    // 3. Detect type
    if (pkg) {
      result.language = 'node';
      result.type = detectTypeFromPackageJson(pkg);
      result.name = pkg.name || repo;
      result.description = pkg.description || extractReadmeDescription(readmeText);
      result.npmPackage = extractNpmPackageName(pkg, readmeText);
      result.npxCommand = extractNpxCommand(readmeText);
    } else {
      // Check Python
      const isPython = await isPythonProject(owner, repo);
      if (isPython) {
        result.language = 'python';
        result.type = 'python_tool';
        result.description = extractReadmeDescription(readmeText);
        // Python MCPs often mentioned explicitly
        const readmeLower = String(readmeText || '').toLowerCase();
        if (readmeLower.includes('mcp server') || readmeLower.includes('model context protocol')) {
          result.type = 'mcp_server';
        }
      } else {
        result.description = extractReadmeDescription(readmeText);
        const readmeLower = String(readmeText || '').toLowerCase();
        if (readmeLower.includes('mcp server') || readmeLower.includes('model context protocol')) {
          result.type = 'mcp_server';
        } else if (readmeLower.includes('command line') || readmeLower.includes('cli tool')) {
          result.type = 'cli_tool';
        }
      }
    }

    // 4. Build install command
    if (result.language === 'node') {
      if (result.npxCommand) {
        result.installCommand = `npx -y ${result.npxCommand}`;
      } else if (result.npmPackage) {
        result.installCommand = `npm install -g ${result.npmPackage}`;
      }
      result.canAutoInstall = !!(result.npmPackage || result.npxCommand);
    } else if (result.language === 'python') {
      result.installCommand = `pip install git+${url}`;
      result.canAutoInstall = false; // Needs human review
    } else {
      result.canAutoInstall = false;
    }

    // 5. Check already installed
    const installed = checkInstalledTools();
    const nameLower = result.name.toLowerCase();
    const repoLower = repo.toLowerCase();
    const match = installed.find(
      (t) =>
        t.nameLower.includes(nameLower) ||
        nameLower.includes(t.nameLower) ||
        t.nameLower.includes(repoLower) ||
        repoLower.includes(t.nameLower),
    );
    if (match) {
      result.alreadyInstalled = true;
      result.alreadyInstalledAs = match.name;
    }

    // 6. Score relevance
    const scored = scoreRelevance(result.name, result.description, readmeText || '');
    result.relevanceScore = scored.score;
    result.relevantGoals = scored.goals;

  } catch (e) {
    result.error = e.message;
  }

  return result;
}

// ── Installed tools check ─────────────────────────────────────────────────────

/**
 * Return list of installed MCPs from AntlerOffice registry.
 * Each item: { id, name, nameLower }
 */
function checkInstalledTools() {
  try {
    return registry.listMcps().map((m) => ({
      id: m.id,
      name: m.name || '',
      nameLower: String(m.name || m.id || '').toLowerCase(),
    }));
  } catch {
    return [];
  }
}

// ── Relevance scoring ─────────────────────────────────────────────────────────

function scoreRelevance(name, description, readmeText) {
  const s = store.readSettings();
  const goals = Array.isArray(s.companyProfile?.goals) ? s.companyProfile.goals : [];

  if (!goals.length) return { score: 0, goals: [] };

  const searchText = `${name} ${description} ${readmeText}`.toLowerCase();
  let totalScore = 0;
  const matchedGoals = [];

  for (const goal of goals) {
    const keywords = KEYWORD_GOAL_MAP[goal] || [];
    const hits = keywords.filter((kw) => searchText.includes(kw)).length;
    if (hits > 0) {
      totalScore += hits;
      matchedGoals.push(goal);
    }
  }

  return { score: totalScore, goals: matchedGoals };
}

// ── Batch analysis ────────────────────────────────────────────────────────────

/**
 * Analyse all GitHub URLs found in the boss's message.
 * Returns array of analysis results, sorted: relevant first, already-installed last.
 */
async function analyzeMessage(text, attachments = []) {
  const urls = extractGitHubUrls(text);
  const pdfs = extractApiPdfs(attachments);

  if (!urls.length && !pdfs.length) return null;

  const [repoResults] = await Promise.all([
    Promise.all(urls.map(analyzeGitHubRepo)),
  ]);

  // Soft-sort: high relevance → low relevance → already installed → unknown type
  repoResults.sort((a, b) => {
    if (a.alreadyInstalled !== b.alreadyInstalled) return a.alreadyInstalled ? 1 : -1;
    return b.relevanceScore - a.relevanceScore;
  });

  const pdfItems = pdfs.map((p) => ({
    url: null,
    name: path.basename(p.name || p.path || 'document.pdf', '.pdf'),
    type: 'api_pdf',
    description: 'API documentation PDF — COO will extract endpoints and create MCP wrapper',
    filePath: p.path,
    alreadyInstalled: false,
    canAutoInstall: false,
    relevanceScore: 0,
    relevantGoals: [],
    language: null,
    error: null,
  }));

  return [...repoResults, ...pdfItems];
}

// ── COO injection block ───────────────────────────────────────────────────────

/**
 * Format analysis results into a structured block to inject into the COO instruction.
 * The COO will read this and present it naturally to the boss.
 */
function buildIntakeBlock(items) {
  if (!items || !items.length) return '';

  const s = store.readSettings();
  const goals = Array.isArray(s.companyProfile?.goals) ? s.companyProfile.goals : [];

  const lines = [
    '## 🔍 TOOL INTAKE ANALYSIS (auto-analysed — present this to the boss)',
    `Boss's stated goals: ${goals.length ? goals.join(', ') : 'not set'}`,
    '',
    'Items detected:',
    '',
  ];

  items.forEach((item, i) => {
    const idx = i + 1;
    const typeLabel = {
      mcp_server: '🔧 MCP Server',
      cli_tool: '⌨️ CLI Tool',
      npm_library: '📦 NPM Library',
      python_tool: '🐍 Python Tool',
      api_pdf: '📄 API PDF Doc',
      unknown: '❓ Unknown',
    }[item.type] || '❓ Unknown';

    const statusLabel = item.alreadyInstalled
      ? `✅ Already installed as "${item.alreadyInstalledAs}"`
      : item.error
        ? `❌ Could not fetch (${item.error})`
        : '🆕 Not installed';

    const relevanceLabel =
      item.alreadyInstalled
        ? ''
        : item.relevantGoals.length
          ? ` 🎯 Matches your goals: ${item.relevantGoals.join(', ')}`
          : ' ⚠️ Low relevance to your current goals';

    lines.push(`**${idx}. ${item.name || item.repo}**`);
    lines.push(`   Type: ${typeLabel}${relevanceLabel}`);
    lines.push(`   Status: ${statusLabel}`);
    if (item.description) lines.push(`   About: ${item.description.slice(0, 200)}`);
    if (item.url) lines.push(`   Repo: ${item.url}`);
    if (item.installCommand) lines.push(`   Install: \`${item.installCommand}\``);
    if (!item.canAutoInstall && !item.alreadyInstalled && item.type !== 'api_pdf') {
      lines.push(`   ⚠️ Requires manual setup — cannot auto-install`);
    }
    lines.push('');
  });

  const installable = items.filter((it) => !it.alreadyInstalled && it.type !== 'api_pdf');
  const autoInstallable = installable.filter((it) => it.canAutoInstall);

  lines.push('---');
  lines.push('**Instructions for COO:**');
  lines.push(`Present the above analysis to the boss in a clear, concise table or list.`);
  lines.push(`Then ask: "Which of these would you like me to install? (reply with numbers, e.g. 1, 3)"`);
  if (autoInstallable.length) {
    lines.push(`Items ${autoInstallable.map((_, i) => items.indexOf(_) + 1).join(', ')} can be auto-installed via IT Junior.`);
  }
  lines.push(`Do NOT install anything without the boss's explicit approval.`);
  lines.push(`After boss confirms, note the selected numbers and say: "Routing to IT Junior for installation."`);
  lines.push(`## END TOOL INTAKE ANALYSIS`);

  return lines.join('\n');
}

// ── Install execution ─────────────────────────────────────────────────────────

/**
 * Register an MCP server in the AntlerOffice registry and attempt npm/npx installation.
 * Returns { ok, mcpId, error }
 */
async function registerMcpFromItem(item) {
  try {
    let command = 'npx';
    let args = ['-y', item.npmPackage || item.name];

    if (item.npxCommand) {
      const parts = item.npxCommand.split(/\s+/);
      args = ['-y', ...parts];
    } else if (item.npmPackage) {
      args = ['-y', item.npmPackage];
    }

    const existing = registry.listMcps().find(
      (m) => String(m.name || '').toLowerCase() === String(item.name || '').toLowerCase(),
    );
    if (existing) {
      return { ok: true, mcpId: existing.id, alreadyExisted: true };
    }

    const mcp = registry.addMcp({
      name: item.name,
      transport: 'stdio',
      command,
      args,
      description: item.description || `${item.name} MCP server from ${item.url || 'GitHub'}`,
      authType: 'none',
      suggestedAuthType: 'none',
    });

    return { ok: true, mcpId: mcp.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Execute install for a list of selected items (by 1-based index from pending list).
 * Returns array of { item, result }
 */
async function executeSelectedInstalls(selectedIndices) {
  const pending = getPendingInstalls();
  if (!pending.length) return { ok: false, error: 'No pending install plan found' };

  const toInstall = selectedIndices
    .map((i) => pending[Number(i) - 1])
    .filter(Boolean)
    .filter((it) => !it.alreadyInstalled);

  const results = [];
  for (const item of toInstall) {
    if (item.type === 'mcp_server' && item.canAutoInstall) {
      const result = await registerMcpFromItem(item);
      await skillInstallLog.recordInstall({
        skillName: item.name,
        source: 'github',
        sourceUrl: item.url,
        triggeredBy: 'user',
        status: result.ok ? 'installed' : 'failed',
        errorMessage: result.error || null,
      });
      results.push({ item, result });
    } else if (item.type === 'api_pdf') {
      // Stage for COO to create MCP wrapper — log but don't auto-install
      await skillInstallLog.recordInstall({
        skillName: item.name,
        source: 'manual',
        sourceUrl: item.filePath,
        triggeredBy: 'user',
        status: 'skipped',
        errorMessage: 'API PDF requires COO to create MCP wrapper manually',
      });
      results.push({ item, result: { ok: false, needsManualSetup: true } });
    } else {
      // CLI tool or Python tool — log, cannot auto-install
      await skillInstallLog.recordInstall({
        skillName: item.name,
        source: 'github',
        sourceUrl: item.url,
        triggeredBy: 'user',
        status: 'skipped',
        errorMessage: 'Cannot auto-install this type. Requires manual setup.',
      });
      results.push({ item, result: { ok: false, needsManualSetup: true } });
    }
  }

  // Clear pending after execution
  if (results.length > 0) clearPendingInstalls();

  return { ok: true, results };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Called from handleInstruction() when boss message contains GitHub URLs or PDF attachments.
 *
 * Returns the modified instruction string with analysis block appended,
 * or null if nothing detected.
 */
async function interceptAndAnalyze(text, attachments = []) {
  if (!hasGitHubUrls(text) && !extractApiPdfs(attachments).length) return null;

  const items = await analyzeMessage(text, attachments);
  if (!items || !items.length) return null;

  // Stage for later confirmation
  stagePendingInstalls(items);

  const intakeBlock = buildIntakeBlock(items);
  return `${text}\n\n${intakeBlock}`;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  hasGitHubUrls,
  extractGitHubUrls,
  extractApiPdfs,
  analyzeGitHubRepo,
  analyzeMessage,
  buildIntakeBlock,
  interceptAndAnalyze,
  executeSelectedInstalls,
  stagePendingInstalls,
  getPendingInstalls,
  clearPendingInstalls,
  checkInstalledTools,
};
