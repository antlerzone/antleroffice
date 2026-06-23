// COO Inbox — completion reports land in Materials/COO Inbox/_inbox/ as markdown.
// Used to notify the COO when an agent finishes a delegated job (e.g. a website
// upload run). Mirrors the Admin Vault inbox convention.

const fs = require('node:fs');
const path = require('node:path');
const materials = require('./materials.cjs');

const INBOX_ROOT = 'COO Inbox';
const INBOX_REL = `${INBOX_ROOT}/_inbox`;

function ensureInbox() {
  materials.getRootPath();
  materials.mkdir(INBOX_ROOT);
  materials.mkdir(INBOX_REL);
  return { ok: true, inboxRel: INBOX_REL };
}

function slugify(s) {
  return String(s || 'report')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'report';
}

function buildReportMarkdown({ title, summary, account, results, details }) {
  const now = new Date().toISOString();
  const lines = [`# ${title || 'Task completed'}`, '', `- 完成时间: ${now}`];
  if (account) lines.push(`- 使用账号: ${account}`);
  if (results && typeof results === 'object') {
    if (results.total != null) lines.push(`- 处理条数: ${results.total}`);
    if (results.ok != null) lines.push(`- 成功: ${results.ok}`);
    if (results.failed != null) lines.push(`- 失败: ${results.failed}`);
    if (results.needs_human != null) lines.push(`- 需人工: ${results.needs_human}`);
  }
  lines.push('');
  if (summary) lines.push(summary, '');
  if (details) lines.push('## 明细', '', details, '');
  return lines.join('\n');
}

/**
 * Write a completion report into the COO inbox.
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
function notifyCoo({ title, summary = '', account = '', results = null, details = '' } = {}) {
  try {
    ensureInbox();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${slugify(title)}.md`;
    const md = buildReportMarkdown({ title, summary, account, results, details });
    const result = materials.writeUploadedFile(INBOX_REL, name, Buffer.from(md, 'utf8'));
    if (!result || result.ok === false) return { ok: false, error: result?.error || 'write failed' };
    return {
      ok: true,
      path: result.to || path.join(INBOX_REL, name),
      absolutePath: path.join(materials.getRootPath(), INBOX_REL, name),
      notifiedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function listInbox() {
  ensureInbox();
  return materials.listDir(INBOX_REL);
}

module.exports = {
  INBOX_ROOT,
  INBOX_REL,
  ensureInbox,
  notifyCoo,
  listInbox,
};
