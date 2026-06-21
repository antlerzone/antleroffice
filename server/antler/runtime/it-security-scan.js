// IT security scan — npm audit + lightweight repo checks before dev-pipeline fix.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

function maxSeverity(findings) {
  let max = 'info';
  let rank = -1;
  for (const f of findings) {
    const r = SEVERITY_RANK[String(f.severity || '').toLowerCase()] ?? 0;
    if (r > rank) {
      rank = r;
      max = f.severity;
    }
  }
  return max;
}

function parseNpmAuditJson(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { findings: [], error: 'invalid npm audit json' };
  }

  const findings = [];
  const vulns = data.vulnerabilities || {};
  for (const [pkg, info] of Object.entries(vulns)) {
    if (!info || typeof info !== 'object') continue;
    const via = Array.isArray(info.via) ? info.via : [];
    const titles = via
      .map((v) => (typeof v === 'object' ? v.title || v.name : String(v)))
      .filter(Boolean)
      .slice(0, 3);
    findings.push({
      source: 'npm_audit',
      package: pkg,
      severity: String(info.severity || 'unknown').toLowerCase(),
      title: titles[0] || pkg,
      detail: titles.join('; ') || 'See npm audit',
      fixAvailable: !!info.fixAvailable,
    });
  }

  const meta = data.metadata?.vulnerabilities || {};
  return {
    findings,
    totals: {
      critical: Number(meta.critical) || 0,
      high: Number(meta.high) || 0,
      moderate: Number(meta.moderate) || 0,
      low: Number(meta.low) || 0,
      info: Number(meta.info) || 0,
      total: findings.length,
    },
  };
}

async function runNpmAudit(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { skipped: true, reason: 'no package.json', findings: [], totals: { total: 0 } };
  }

  try {
    const { stdout } = await execFileAsync('npm', ['audit', '--json'], {
      cwd: projectRoot,
      timeout: 120000,
      maxBuffer: 15 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    return { ok: true, ...parseNpmAuditJson(stdout) };
  } catch (e) {
    if (e.stdout) {
      const parsed = parseNpmAuditJson(e.stdout);
      return { ok: true, auditExitCode: e.code, ...parsed };
    }
    return { ok: false, error: e.message || String(e), findings: [], totals: { total: 0 } };
  }
}

async function checkTrackedEnvFiles(projectRoot) {
  const findings = [];
  const suspects = ['.env', '.env.local', '.env.production'];
  try {
    const { stdout } = await execFileAsync('git', ['ls-files'], {
      cwd: projectRoot,
      timeout: 30000,
      shell: process.platform === 'win32',
    });
    const tracked = new Set(String(stdout || '').split(/\r?\n/).map((l) => l.trim()));
    for (const name of suspects) {
      if (tracked.has(name)) {
        findings.push({
          source: 'git',
          package: name,
          severity: 'high',
          title: `Tracked secret file: ${name}`,
          detail: 'Environment files should not be committed to git.',
          fixAvailable: true,
        });
      }
    }
  } catch {
    /* not a git repo or git missing */
  }
  return findings;
}

async function scanProject(projectRoot) {
  const root = String(projectRoot || '').trim();
  if (!root || !fs.existsSync(root)) {
    return {
      ok: false,
      projectRoot: root,
      error: 'project root not found',
      findings: [],
      totals: { total: 0 },
      scannedAt: Date.now(),
    };
  }

  const npm = await runNpmAudit(root);
  const envFindings = await checkTrackedEnvFiles(root);
  const findings = [...(npm.findings || []), ...envFindings];

  const totals = {
    critical: (npm.totals?.critical || 0) + envFindings.filter((f) => f.severity === 'critical').length,
    high: (npm.totals?.high || 0) + envFindings.filter((f) => f.severity === 'high').length,
    moderate: npm.totals?.moderate || 0,
    low: npm.totals?.low || 0,
    info: npm.totals?.info || 0,
    total: findings.length,
  };

  return {
    ok: npm.ok !== false,
    projectRoot: root,
    skipped: !!npm.skipped && !envFindings.length,
    skipReason: npm.reason || null,
    npmError: npm.error || null,
    findings,
    totals,
    maxSeverity: findings.length ? maxSeverity(findings) : 'none',
    scannedAt: Date.now(),
  };
}

function formatScanMarkdown(report, decision = null) {
  const lines = [
    `# IT security scan`,
    '',
    `- **Project:** \`${report.projectRoot}\``,
    `- **Time:** ${new Date(report.scannedAt || Date.now()).toISOString()}`,
  ];

  if (report.skipped) {
    lines.push(`- **Note:** ${report.skipReason || 'Scan skipped'}`);
  }

  lines.push(
    '',
    '## Summary',
    '',
    `| Severity | Count |`,
    `|----------|-------|`,
    `| Critical | ${report.totals?.critical || 0} |`,
    `| High | ${report.totals?.high || 0} |`,
    `| Moderate | ${report.totals?.moderate || 0} |`,
    `| Low | ${report.totals?.low || 0} |`,
    `| **Total** | **${report.totals?.total || 0}** |`,
  );

  if (report.findings?.length) {
    lines.push('', '## Findings (top 20)', '');
    for (const f of report.findings.slice(0, 20)) {
      lines.push(`- **[${String(f.severity || '?').toUpperCase()}]** ${f.title}${f.package ? ` (\`${f.package}\`)` : ''}`);
      if (f.detail) lines.push(`  - ${f.detail}`);
    }
    if (report.findings.length > 20) {
      lines.push('', `_…and ${report.findings.length - 20} more._`);
    }
  } else {
    lines.push('', '_No vulnerabilities detected._');
  }

  if (decision) {
    lines.push('', '## COO decision', '', `- **Action:** ${decision.action}`, `- **Reason:** ${decision.reason}`);
    if (decision.escalateCeo) {
      lines.push('- **CEO gate:** required before IT fix');
    }
  }

  return lines.join('\n');
}

module.exports = {
  scanProject,
  runNpmAudit,
  formatScanMarkdown,
  maxSeverity,
};
