// Universal inbound attachment → ask CEO (archive vs reference) → inbox or RAG.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const adminVault = require('./admin-vault');
const materials = require('./materials.cjs');
const rag = require('./rag');
const { extractText } = require('./attachment-text-extract');

const MAX_BYTES = Number(process.env.ANTLEROFFICE_INBOX_MAX_BYTES) || 25 * 1024 * 1024;
const AUDIT_REL = `${adminVault.INBOX_REL}/_audit.jsonl`;
const HASH_INDEX_REL = `${adminVault.INBOX_REL}/_ingest-index.json`;
const PENDING_REL = `${adminVault.INBOX_REL}/_pending`;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** P0: Boss Chat only. Gateway/channel sources enabled in a follow-up commit. */
const ENABLED_SOURCES = new Set(['boss_chat', 'boss_chat_native', 'boss_chat_openclaw', 'api']);

const CHOICE_PROMPT =
  '这份文件要存档给 Admin 归档，还是只作参考（加入 RAG，不写入 Admin Vault）？';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isBossChatSource(source) {
  return String(source || '').startsWith('boss_chat');
}

function auditAbs() {
  adminVault.ensureVaultStructure();
  return path.join(materials.getRootPath(), AUDIT_REL);
}

function hashIndexAbs() {
  adminVault.ensureVaultStructure();
  return path.join(materials.getRootPath(), HASH_INDEX_REL);
}

function pendingDir() {
  adminVault.ensureVaultStructure();
  const dir = path.join(materials.getRootPath(), PENDING_REL);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pendingMetaPath(pendingId) {
  return path.join(pendingDir(), `${pendingId}.json`);
}

function pendingFilePath(pendingId) {
  return path.join(pendingDir(), `${pendingId}.bin`);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readHashIndex() {
  const abs = hashIndexAbs();
  try {
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return data && typeof data === 'object' ? data : { byHash: {} };
  } catch {
    return { byHash: {} };
  }
}

function writeHashIndex(index) {
  fs.writeFileSync(hashIndexAbs(), JSON.stringify(index, null, 2), 'utf8');
}

function appendAudit(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(auditAbs(), `${line}\n`, 'utf8');
}

function notifyBossThread(threadId, text, meta = {}) {
  if (!threadId || !String(text || '').trim()) return null;
  try {
    const bossChat = require('./boss-chat-store');
    return bossChat.addMessage(threadId, meta.from || 'system', String(text).trim(), {
      authorName: meta.authorName || 'Office',
      pendingAttachmentId: meta.pendingAttachmentId,
      attachmentFileName: meta.attachmentFileName,
    });
  } catch {
    return null;
  }
}

function formatAttachmentNotice(paths) {
  const lines = (Array.isArray(paths) ? paths : [paths])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .map((p) => `- ${p}`);
  if (!lines.length) return '';
  return (
    `[CEO attachments in Materials Admin Vault inbox — Admin must classify and archive with admin_archive_document]\n${lines.join('\n')}`
  );
}

function openclawMediaRoots() {
  const roots = [];
  const fromEnv = process.env.MEDIA_DIR || process.env.OPENCLAW_MEDIA_DIR;
  if (fromEnv && String(fromEnv).trim()) roots.push(path.resolve(String(fromEnv).trim()));
  roots.push(path.join(os.homedir(), '.openclaw', 'media'));
  return [...new Set(roots.map((r) => r.replace(/\\/g, '/')))];
}

function resolveOpenClawMediaAbs(mediaPath) {
  let rel = String(mediaPath || '').trim().replace(/\\/g, '/');
  if (!rel) return null;

  if (rel.startsWith('MEDIA:')) rel = rel.slice(6);
  if (rel.startsWith('file://')) {
    const idx = rel.indexOf('.openclaw/media/');
    if (idx >= 0) rel = rel.slice(idx + '.openclaw/media/'.length);
    else rel = rel.replace(/^file:\/+/, '');
  }
  rel = rel.replace(/^\/+/, '');

  for (const root of openclawMediaRoots()) {
    const abs = path.resolve(root, rel);
    const rootNorm = path.resolve(root);
    if (!abs.toLowerCase().startsWith(rootNorm.toLowerCase())) continue;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

async function readFileWithRetry(absPath) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (!fs.existsSync(absPath)) throw new Error('file not found');
      return fs.readFileSync(absPath);
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await sleep(200);
    }
  }
  throw lastErr || new Error('file not found');
}

function rejectResult({ reason, error, meta = {} }) {
  appendAudit({
    status: 'rejected',
    reason,
    error: error || reason,
    source: meta.source,
    threadId: meta.threadId || null,
    fileName: meta.fileName || null,
    mode: meta.mode || null,
  });
  const msg = `Attachment could not be saved: ${error || reason}`;
  notifyBossThread(meta.threadId, msg);
  return { ok: false, status: 'rejected', error: error || reason, reason };
}

function duplicateResult({ hash, existingPath, meta = {} }) {
  appendAudit({
    status: 'duplicate',
    hash,
    path: existingPath,
    source: meta.source,
    threadId: meta.threadId || null,
    fileName: meta.fileName || null,
    mode: 'archive',
  });
  notifyBossThread(
    meta.threadId,
    `Attachment already in Admin Vault inbox (duplicate skipped): \`${existingPath}\``,
  );
  return {
    ok: true,
    status: 'duplicate',
    hash,
    path: existingPath,
    attachment: { path: existingPath, name: path.basename(existingPath) },
  };
}

function validateBuffer(buffer, fileName, meta = {}) {
  const source = String(meta.source || 'api').trim();
  if (!ENABLED_SOURCES.has(source)) {
    return {
      ok: false,
      status: 'rejected',
      error: `Inbound source "${source}" is not enabled yet (Boss Chat only in P0).`,
    };
  }

  const safeName = path.basename(String(fileName || 'upload'));
  const size = buffer?.length || 0;
  if (!size) {
    return rejectResult({ reason: 'empty_file', error: 'Empty file', meta: { ...meta, source, fileName: safeName } });
  }
  if (size > MAX_BYTES) {
    return rejectResult({
      reason: 'too_large',
      error: `File exceeds ${Math.round(MAX_BYTES / (1024 * 1024))}MB limit`,
      meta: { ...meta, source, fileName: safeName },
    });
  }

  const hash = sha256(buffer);
  const index = readHashIndex();
  const existingPath = index.byHash?.[hash];
  if (existingPath && meta.mode !== 'reference') {
    const dup = duplicateResult({ hash, existingPath, meta: { ...meta, source, fileName: safeName } });
    return { ...dup, ok: dup.ok !== false };
  }

  return { ok: true, source, safeName, size, hash, index };
}

function cleanupExpiredPending() {
  const dir = pendingDir();
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (meta.expiresAt && meta.expiresAt < now) {
        fs.unlinkSync(path.join(dir, name));
        const bin = path.join(dir, `${meta.id}.bin`);
        if (fs.existsSync(bin)) fs.unlinkSync(bin);
      }
    } catch {
      /* ignore */
    }
  }
}

function readPending(pendingId) {
  const metaPath = pendingMetaPath(pendingId);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const binPath = pendingFilePath(pendingId);
    if (!fs.existsSync(binPath)) return null;
    return { meta, buffer: fs.readFileSync(binPath) };
  } catch {
    return null;
  }
}

function deletePending(pendingId) {
  try {
    fs.unlinkSync(pendingMetaPath(pendingId));
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(pendingFilePath(pendingId));
  } catch {
    /* ignore */
  }
}

function stageBuffer(buffer, fileName, meta = {}) {
  cleanupExpiredPending();
  const validated = validateBuffer(buffer, fileName, meta);
  if (!validated.ok) return validated;
  if (validated.status === 'duplicate') return validated;

  const { source, safeName, size, hash } = validated;
  const threadId = meta.threadId || null;
  const pendingId = `pend-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const pendingMeta = {
    id: pendingId,
    fileName: safeName,
    hash,
    size,
    source,
    threadId,
    agentId: meta.agentId || null,
    ownerKey: meta.ownerKey || null,
    messageId: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + PENDING_TTL_MS,
  };

  try {
    fs.writeFileSync(pendingFilePath(pendingId), buffer);
    fs.writeFileSync(pendingMetaPath(pendingId), JSON.stringify(pendingMeta, null, 2), 'utf8');
  } catch (e) {
    const err = e?.code === 'ENOSPC' ? 'Disk full — could not stage attachment' : e.message || 'Write failed';
    return rejectResult({ reason: 'write_failed', error: err, meta: { ...meta, source, fileName: safeName } });
  }

  appendAudit({
    status: 'pending_choice',
    hash,
    pendingId,
    size,
    source,
    threadId,
    fileName: safeName,
  });

  let choiceMsg = null;
  if (threadId) {
    const prompt = `收到文件 **${safeName}**。${CHOICE_PROMPT}`;
    choiceMsg = notifyBossThread(threadId, prompt, {
      from: 'coo',
      authorName: 'COO',
      pendingAttachmentId: pendingId,
      attachmentFileName: safeName,
    });
    if (choiceMsg?.id) {
      pendingMeta.messageId = choiceMsg.id;
      fs.writeFileSync(pendingMetaPath(pendingId), JSON.stringify(pendingMeta, null, 2), 'utf8');
    }
    try {
      require('./office-events').notifyChatUpdate({ threadId });
    } catch {
      /* optional */
    }
  }

  return {
    ok: true,
    status: 'pending_choice',
    pendingId,
    hash,
    fileName: safeName,
    messageId: choiceMsg?.id || null,
  };
}

async function ingestReference(buffer, fileName, meta = {}) {
  const validated = validateBuffer(buffer, fileName, { ...meta, mode: 'reference' });
  if (!validated.ok) return validated;

  const { source, safeName, size, hash } = validated;
  const threadId = meta.threadId || null;
  const agentId = meta.agentId || meta.ragAgentId || 'coo';
  const ragSource = `reference:${safeName}:${hash.slice(0, 12)}`;

  const text = await extractText(safeName, buffer);
  if (!String(text || '').trim()) {
    return rejectResult({
      reason: 'no_text',
      error: 'Could not extract text for reference — try archiving instead',
      meta: { ...meta, source, fileName: safeName, mode: 'reference' },
    });
  }

  const indexed = rag.index(agentId, ragSource, text);
  if (!indexed.added) {
    return rejectResult({
      reason: 'no_text',
      error: 'Nothing to index for reference',
      meta: { ...meta, source, fileName: safeName, mode: 'reference' },
    });
  }

  appendAudit({
    status: 'reference',
    mode: 'reference',
    hash,
    ragAgentId: agentId,
    ragSource,
    chunks: indexed.added,
    size,
    source,
    threadId,
    fileName: safeName,
  });

  notifyBossThread(
    threadId,
    `Reference indexed (${indexed.added} chunk${indexed.added === 1 ? '' : 's'}) from **${safeName}** — not stored in Admin Vault.`,
    { authorName: 'COO', from: 'system' },
  );

  return {
    ok: true,
    status: 'reference',
    mode: 'reference',
    hash,
    ragAgentId: agentId,
    ragSource,
    chunks: indexed.added,
    attachment: { name: safeName, size, sizeLabel: `${Math.round(size / 1024)} KB` },
  };
}

function ingestBuffer(buffer, fileName, meta = {}) {
  const mode = String(meta.mode || 'archive').trim();
  if (mode === 'reference') {
    return ingestReference(buffer, fileName, meta);
  }

  const validated = validateBuffer(buffer, fileName, { ...meta, mode: 'archive' });
  if (!validated.ok) return validated;
  if (validated.status === 'duplicate') return validated;

  const { source, safeName, size, hash, index } = validated;
  const threadId = meta.threadId || null;

  let saved;
  try {
    saved = adminVault.saveInboxFile(buffer, safeName, {
      uploadedBy: meta.uploadedBy || 'ceo',
      source,
    });
  } catch (e) {
    const err = e?.code === 'ENOSPC' ? 'Disk full — could not save attachment' : e.message || 'Write failed';
    return rejectResult({ reason: 'write_failed', error: err, meta: { ...meta, source, fileName: safeName, mode: 'archive' } });
  }

  if (!saved.ok) {
    return rejectResult({
      reason: 'write_failed',
      error: saved.error || 'Could not write inbox file',
      meta: { ...meta, source, fileName: safeName, mode: 'archive' },
    });
  }

  index.byHash = index.byHash || {};
  index.byHash[hash] = saved.path;
  writeHashIndex(index);

  appendAudit({
    status: 'ingested',
    mode: 'archive',
    hash,
    path: saved.path,
    size,
    source,
    threadId,
    fileName: saved.name,
  });

  notifyBossThread(
    threadId,
    `Attachment saved to Admin Vault inbox: \`${saved.path}\` — Admin will classify and archive.`,
  );

  return {
    ok: true,
    status: 'ingested',
    mode: 'archive',
    hash,
    path: saved.path,
    attachment: {
      path: saved.path,
      name: saved.name,
      size: saved.size,
      sizeLabel: saved.sizeLabel,
    },
  };
}

function receiveBuffer(buffer, fileName, meta = {}) {
  const mode = String(meta.mode || '').trim();
  if (mode === 'archive') {
    return ingestBuffer(buffer, fileName, meta);
  }
  if (mode === 'reference') {
    return ingestReference(buffer, fileName, meta);
  }
  if (isBossChatSource(meta.source) && meta.askChoice !== false && meta.threadId) {
    return stageBuffer(buffer, fileName, meta);
  }
  return ingestBuffer(buffer, fileName, meta);
}

async function resolvePending(pendingId, mode, meta = {}) {
  const hit = readPending(pendingId);
  if (!hit) {
    return { ok: false, status: 'rejected', error: 'Pending attachment not found or expired' };
  }

  const { meta: pending, buffer } = hit;
  const threadId = meta.threadId || pending.threadId;
  const agentId = meta.agentId || pending.agentId || 'coo';
  const resolvedMode = mode === 'reference' ? 'reference' : 'archive';

  let result;
  if (resolvedMode === 'reference') {
    result = await ingestReference(buffer, pending.fileName, {
      ...meta,
      source: pending.source,
      threadId,
      agentId,
    });
  } else {
    result = ingestBuffer(buffer, pending.fileName, {
      ...meta,
      source: pending.source,
      threadId,
      agentId,
      mode: 'archive',
    });
  }

  deletePending(pendingId);

  if (pending.messageId && threadId) {
    try {
      const bossChat = require('./boss-chat-store');
      bossChat.updateMessage(threadId, pending.messageId, { attachmentResolved: true });
    } catch {
      /* optional */
    }
  }

  appendAudit({
    status: 'resolved',
    pendingId,
    mode: resolvedMode,
    hash: pending.hash,
    fileName: pending.fileName,
    threadId,
    source: pending.source,
    resultStatus: result.status,
  });

  return result;
}

async function ingestOpenClawMedia(mediaPath, meta = {}) {
  const source = String(meta.source || 'openclaw_media').trim();
  if (!ENABLED_SOURCES.has(source)) {
    return {
      ok: false,
      status: 'rejected',
      error: `OpenClaw media ingest not enabled yet (Boss Chat uploads only in P0).`,
    };
  }

  const abs = resolveOpenClawMediaAbs(mediaPath);
  if (!abs) {
    return rejectResult({
      reason: 'path_not_found',
      error: `OpenClaw media not found: ${mediaPath}`,
      meta: { ...meta, source, fileName: path.basename(String(mediaPath)) },
    });
  }

  let buffer;
  try {
    buffer = await readFileWithRetry(abs);
  } catch (e) {
    return rejectResult({
      reason: 'path_not_found',
      error: e.message || 'Could not read OpenClaw media file',
      meta: { ...meta, source, fileName: path.basename(abs) },
    });
  }

  return receiveBuffer(buffer, path.basename(abs), { ...meta, source, openclawMediaPath: mediaPath });
}

module.exports = {
  MAX_BYTES,
  ENABLED_SOURCES,
  CHOICE_PROMPT,
  formatAttachmentNotice,
  receiveBuffer,
  ingestBuffer,
  ingestReference,
  stageBuffer,
  resolvePending,
  ingestOpenClawMedia,
  resolveOpenClawMediaAbs,
  appendAudit,
  notifyBossThread,
};
