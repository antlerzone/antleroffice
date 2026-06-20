// Download agent bundles from ECS and install to ~/.antleroffice2/bundles/{templateId}/

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const auth = require('./auth');

function bundlesRoot() {
  return path.join(store.getDataDir(), 'bundles');
}

function bundleDir(templateId) {
  return path.join(bundlesRoot(), templateId);
}

function readLocalManifest(templateId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(bundleDir(templateId), 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

function resolveBundleUrl(template) {
  const base = auth.ecsBaseUrl();
  if (!base || !template?.id) return null;
  const rel = template.bundleUrl || `/api/catalog/agents/${template.id}/bundle`;
  if (rel.startsWith('http://') || rel.startsWith('https://')) return rel;
  return `${base}${rel.startsWith('/') ? rel : `/${rel}`}`;
}

function writeBundle(templateId, { manifest, files }) {
  const root = bundleDir(templateId);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  for (const [relPath, content] of Object.entries(files || {})) {
    const dest = path.join(root, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }
  return root;
}

function collectMonorepoBundle(templateId) {
  const mono = monorepoBundlesRoot();
  if (!mono) return null;
  const root = path.join(mono, templateId);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }

  const files = {};
  function walk(relDir) {
    const dir = relDir ? path.join(root, relDir) : root;
    for (const name of fs.readdirSync(dir)) {
      if (!relDir && name === 'manifest.json') continue;
      const relPath = relDir ? `${relDir}/${name}` : name;
      const full = path.join(root, relPath);
      if (fs.statSync(full).isDirectory()) {
        walk(relPath);
      } else {
        files[relPath.replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  walk('');
  return { manifest, files };
}

/** Dev fallback when ECS has not published the bundle yet (e.g. local Antlermarket/server/bundles). */
function installFromMonorepo(templateId) {
  const payload = collectMonorepoBundle(templateId);
  if (!payload) return null;
  const dest = writeBundle(templateId, payload);
  return {
    ok: true,
    source: 'monorepo',
    path: dest,
    version: payload.manifest.version || null,
    fileCount: Object.keys(payload.files).length,
  };
}

async function downloadAndInstall(template) {
  const url = resolveBundleUrl(template);
  if (!url) {
    const mono = installFromMonorepo(template.id);
    if (mono?.ok) return mono;
    return { ok: false, skipped: true, reason: 'no_ecs_bundle_url' };
  }

  const local = readLocalManifest(template.id);
  if (local?.version && template.version && local.version === template.version) {
    return { ok: true, source: 'cache', path: bundleDir(template.id), version: local.version };
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const mono = installFromMonorepo(template.id);
    if (mono?.ok) return mono;
    throw new Error(data.error || `Bundle download failed (${res.status})`);
  }
  if (!data.manifest || !data.files) {
    const mono = installFromMonorepo(template.id);
    if (mono?.ok) return mono;
    throw new Error('Invalid bundle payload from ECS');
  }

  const dest = writeBundle(template.id, { manifest: data.manifest, files: data.files });
  return {
    ok: true,
    source: 'ecs',
    path: dest,
    version: data.manifest.version || null,
    fileCount: Object.keys(data.files).length,
  };
}

function monorepoBundlesRoot() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'server', 'bundles'),
    path.join(__dirname, '..', '..', 'server', 'bundles'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function skillFilePath(templateId, skillId) {
  const slug = String(skillId || '').replace(/_/g, '-');
  const bundled = path.join(bundleDir(templateId), 'skills', `${slug}.json`);
  if (fs.existsSync(bundled)) return bundled;
  const mono = monorepoBundlesRoot();
  if (mono) {
    const p = path.join(mono, templateId, 'skills', `${slug}.json`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function openclawSkillDir(templateId, folderName) {
  const bundled = path.join(bundleDir(templateId), 'openclaw-skills', folderName);
  if (fs.existsSync(bundled)) return bundled;
  const mono = monorepoBundlesRoot();
  if (mono) {
    const p = path.join(mono, templateId, 'openclaw-skills', folderName);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = {
  bundlesRoot,
  bundleDir,
  resolveBundleUrl,
  downloadAndInstall,
  installFromMonorepo,
  readLocalManifest,
  skillFilePath,
  openclawSkillDir,
};
