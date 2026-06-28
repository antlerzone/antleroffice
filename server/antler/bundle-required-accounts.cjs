// Aggregate requiredAccounts from ECS bundle skill JSONs (monorepo server/bundles).

const fs = require('node:fs');
const path = require('node:path');

function bundlesRoots() {
  const roots = [];
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'server', 'bundles'),
    path.join(__dirname, '..', '..', 'server', 'bundles'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && !roots.includes(p)) roots.push(p);
  }
  return roots;
}

function listBundleIds(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => {
    const p = path.join(root, name, 'manifest.json');
    return fs.existsSync(p);
  });
}

function bundleRoot(root, templateId) {
  return path.join(root, templateId);
}

function readManifest(root, templateId) {
  const file = path.join(bundleRoot(root, templateId), 'manifest.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadBundleRequiredAccounts(root, templateId) {
  const manifest = readManifest(root, templateId);
  if (!manifest) return [];

  const skillIds = Array.isArray(manifest.skillIds) ? manifest.skillIds : [];
  const seen = new Set();
  const accounts = [];

  for (const skillId of skillIds) {
    const candidates = [
      path.join(bundleRoot(root, templateId), 'skills', `${skillId}.json`),
      path.join(bundleRoot(root, templateId), 'skills', `${skillId.replace(/_/g, '-')}.json`),
    ];
    let skill = null;
    for (const p of candidates) {
      try {
        skill = JSON.parse(fs.readFileSync(p, 'utf8'));
        break;
      } catch {
        /* try next */
      }
    }
    if (!skill || !Array.isArray(skill.requiredAccounts)) continue;
    for (const acct of skill.requiredAccounts) {
      if (!acct?.alias || seen.has(acct.alias)) continue;
      seen.add(acct.alias);
      accounts.push(acct);
    }
  }

  return accounts;
}

function listAllRequiredAccounts() {
  const seen = new Set();
  const accounts = [];

  for (const root of bundlesRoots()) {
    for (const bundleId of listBundleIds(root)) {
      for (const acct of loadBundleRequiredAccounts(root, bundleId)) {
        if (seen.has(acct.alias)) continue;
        seen.add(acct.alias);
        accounts.push(acct);
      }
    }
  }

  const grouped = {};
  for (const acct of accounts) {
    const cat = acct.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(acct);
  }

  return { accounts, grouped };
}

function listRequiredAccountsForTemplates(templateIds) {
  const wanted = new Set((templateIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const seen = new Set();
  const accounts = [];

  if (wanted.size) {
    for (const root of bundlesRoots()) {
      for (const bundleId of listBundleIds(root)) {
        if (!wanted.has(bundleId)) continue;
        for (const acct of loadBundleRequiredAccounts(root, bundleId)) {
          if (seen.has(acct.alias)) continue;
          seen.add(acct.alias);
          accounts.push(acct);
        }
      }
    }
  }

  const grouped = {};
  for (const acct of accounts) {
    const cat = acct.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(acct);
  }

  return { accounts, grouped };
}

function loadAgentCatalogEntry(templateId) {
  const id = String(templateId || '').trim();
  if (!id) return null;

  for (const root of bundlesRoots()) {
    const accounts = loadBundleRequiredAccounts(root, id);
    const manifest = readManifest(root, id);
    if (!manifest && !accounts.length) continue;
    return {
      ok: true,
      template: { id, name: manifest?.name || id },
      manifest: {
        id,
        version: manifest?.version || '1',
        skills: manifest?.skillIds || [],
        openclawSkillNames: manifest?.openclawSkillNames || [],
        mcps: manifest?.mcps || [],
        requiredAccounts: accounts,
      },
    };
  }
  return null;
}

module.exports = {
  listAllRequiredAccounts,
  listRequiredAccountsForTemplates,
  loadAgentCatalogEntry,
  loadBundleRequiredAccounts,
};
