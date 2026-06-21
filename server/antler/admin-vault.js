// Admin Vault — CEO uploads land in Materials/Admin Vault/_inbox/; Admin archives via MCP.

const fs = require('node:fs');
const path = require('node:path');
const materials = require('./materials.cjs');

const VAULT_ROOT = 'Admin Vault';
const INBOX_REL = `${VAULT_ROOT}/_inbox`;
const INDEX_JSON = `${VAULT_ROOT}/index.json`;
const INDEX_MD = `${VAULT_ROOT}/index.md`;

const COMPANIES = ['Coliving', 'CleanLemons', 'AntlerHub', 'Shared'];
const CATEGORIES = ['Corporate', 'Licenses', 'Contracts', 'Invoices', 'Other'];

function normalizeCompany(value) {
  const v = String(value || '').trim();
  const hit = COMPANIES.find((c) => c.toLowerCase() === v.toLowerCase());
  return hit || 'Shared';
}

function normalizeCategory(value) {
  const v = String(value || '').trim();
  const hit = CATEGORIES.find((c) => c.toLowerCase() === v.toLowerCase());
  return hit || 'Other';
}

function indexJsonAbs() {
  return path.join(materials.getRootPath(), INDEX_JSON);
}

function readIndexEntries() {
  const abs = indexJsonAbs();
  try {
    if (!fs.existsSync(abs)) return [];
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function formatIndexMarkdown(entries) {
  const lines = [
    '# Admin Vault Index',
    '',
    'COO and Admin: look up filed documents here. Update via `admin_archive_document` MCP.',
    '',
    '| Archived | Company | Category | Path | Notes |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const e of entries.slice(0, 200)) {
    const date = String(e.archivedAt || '').slice(0, 10);
    lines.push(
      `| ${date} | ${e.company || ''} | ${e.category || ''} | \`${e.path || ''}\` | ${String(e.notes || '').replace(/\|/g, '/')} |`,
    );
  }
  if (!entries.length) {
    lines.push('| — | — | — | — | _No archived documents yet._ |');
  }
  return lines.join('\n');
}

function writeIndex(entries) {
  const root = materials.getRootPath();
  const jsonAbs = path.join(root, INDEX_JSON);
  const mdAbs = path.join(root, INDEX_MD);
  fs.mkdirSync(path.dirname(jsonAbs), { recursive: true });
  fs.writeFileSync(jsonAbs, JSON.stringify(entries, null, 2), 'utf8');
  fs.writeFileSync(mdAbs, formatIndexMarkdown(entries), 'utf8');
}

function ensureVaultStructure() {
  materials.getRootPath();
  materials.mkdir(VAULT_ROOT);
  materials.mkdir(INBOX_REL);
  for (const company of COMPANIES) {
    for (const category of CATEGORIES) {
      materials.mkdir(`${VAULT_ROOT}/${company}/${category}`);
    }
  }
  if (!fs.existsSync(indexJsonAbs())) {
    writeIndex([]);
  }
  return {
    ok: true,
    vaultRoot: path.join(materials.getRootPath(), VAULT_ROOT),
    inboxRel: INBOX_REL,
  };
}

function saveInboxFile(buffer, fileName, meta = {}) {
  ensureVaultStructure();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeBase = path
    .basename(String(fileName || 'upload'))
    .replace(/[^\w.\-()+ ]/g, '_')
    .slice(0, 120);
  const stampedName = `${stamp}-${safeBase || 'file'}`;
  const result = materials.writeUploadedFile(INBOX_REL, stampedName, buffer);
  if (!result.ok) return result;
  return {
    ...result,
    inbox: true,
    uploadedAt: new Date().toISOString(),
    uploadedBy: meta.uploadedBy || 'ceo',
  };
}

function uniqueArchiveDest(company, category, fileName) {
  const baseRel = `${VAULT_ROOT}/${company}/${category}`;
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let rel = `${baseRel}/${fileName}`;
  let abs = materials.resolveGetPath(rel);
  if (abs.ok === false || !fs.existsSync(abs.abs)) return rel;

  let i = 2;
  while (i < 100) {
    rel = `${baseRel}/${base} (${i})${ext}`;
    abs = materials.resolveGetPath(rel);
    if (abs.ok === false || !fs.existsSync(abs.abs)) return rel;
    i += 1;
  }
  return `${baseRel}/${Date.now()}-${fileName}`;
}

function archiveDocument(sourceRelPath, company, category, metadata = {}) {
  ensureVaultStructure();
  const src = String(sourceRelPath || '').replace(/\\/g, '/').trim();
  if (!src) return { ok: false, error: 'sourcePath is required' };

  const srcStat = materials.statEntry(src);
  if (!srcStat.ok || srcStat.entry?.type === 'directory') {
    return { ok: false, error: 'Source file not found' };
  }

  const co = normalizeCompany(company);
  const cat = normalizeCategory(category);
  const fileName = path.basename(src);
  const destRel = uniqueArchiveDest(co, cat, fileName);
  const moveResult = materials.move(src, destRel);
  if (!moveResult.ok) return moveResult;

  const entry = {
    id: `${Date.now()}-${fileName.replace(/\s+/g, '-')}`,
    path: moveResult.to,
    company: co,
    category: cat,
    fileName,
    sourcePath: src,
    archivedAt: new Date().toISOString(),
    notes: String(metadata.notes || metadata.description || '').slice(0, 500),
    uploadedBy: metadata.uploadedBy || 'admin',
  };

  const entries = readIndexEntries();
  entries.unshift(entry);
  writeIndex(entries.slice(0, 500));

  return {
    ok: true,
    entry,
    absolutePath: path.join(materials.getRootPath(), moveResult.to),
    indexPath: INDEX_MD,
  };
}

function listInbox() {
  ensureVaultStructure();
  return materials.listDir(INBOX_REL);
}

function listVaultIndex() {
  ensureVaultStructure();
  const entries = readIndexEntries();
  return {
    ok: true,
    entries,
    indexJson: INDEX_JSON,
    indexMarkdown: INDEX_MD,
    companies: COMPANIES,
    categories: CATEGORIES,
    materialsRoot: materials.getRootPath(),
  };
}

function materialsContextBlock() {
  const root = materials.getRootPath();
  return (
    `Materials library root: ${root}\n` +
    `Admin Vault inbox: ${INBOX_REL}\n` +
    `Archive to: ${VAULT_ROOT}/{Company}/{Category}/\n` +
    `Companies: ${COMPANIES.join(', ')}\n` +
    `Categories: ${CATEGORIES.join(', ')}`
  );
}

module.exports = {
  VAULT_ROOT,
  INBOX_REL,
  COMPANIES,
  CATEGORIES,
  ensureVaultStructure,
  saveInboxFile,
  archiveDocument,
  listInbox,
  listVaultIndex,
  materialsContextBlock,
};
