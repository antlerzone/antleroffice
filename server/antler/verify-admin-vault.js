#!/usr/bin/env node
// E2E smoke tests: Admin Vault inbox, chat attachment API, MCP archive, expense routing.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE = (process.env.DESKTOP_BASE_URL || 'http://127.0.0.1:3020').replace(/\/+$/, '');
const AUTH = process.env.BOSS_AUTH || 'admin:admin';
const authHeader = `Basic ${Buffer.from(AUTH).toString('base64')}`;

const results = [];

function pass(name, detail = '') {
  results.push({ name, ok: true });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, err) {
  results.push({ name, ok: false, err: String(err) });
  console.log(`  ✗ ${name}: ${err}`);
}

async function json(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function uploadAttachment(buffer, fileName, extra = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), fileName);
  for (const [k, v] of Object.entries(extra)) {
    if (v != null) form.append(k, String(v));
  }
  const url = extra.useInbound ? `${BASE}/api/inbound/attachment` : `${BASE}/api/chat/attachment`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function main() {
  console.log(`Desktop: ${BASE}\n`);

  // 1. Vault structure via materials list
  try {
    const { res, body } = await json(`${BASE}/api/materials/list?path=${encodeURIComponent('Admin Vault/_inbox')}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${body.error || ''}`);
    if (!body.ok) throw new Error(body.error || 'list failed');
    pass('Materials Admin Vault/_inbox exists', body.absolutePath || body.path);
  } catch (e) {
    fail('Materials Admin Vault/_inbox exists', e.message);
  }

  // 2. Chat attachment upload (direct archive — no threadId)
  let uploadedPath = '';
  try {
    const pdf = Buffer.from(`%PDF-1.4\n% e2e test ${Date.now()}\n1 0 obj\n<<>>\nendobj\n`);
    const { res, body } = await uploadAttachment(pdf, `e2e-ssm-test-${Date.now()}.pdf`, {
      source: 'boss_chat_native',
      mode: 'archive',
    });
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
    uploadedPath = body.attachment?.path || '';
    if (!uploadedPath.includes('Admin Vault/_inbox')) {
      throw new Error(`unexpected path: ${uploadedPath}`);
    }
    pass('POST /api/chat/attachment', uploadedPath);
  } catch (e) {
    fail('POST /api/chat/attachment', e.message);
  }

  // 3. MCP admin_list_inbox sees the file
  try {
    const mcp = require('./antleroffice-mcp');
    const out = await mcp.callTool('admin_list_inbox', {});
    const text = out?.content?.[0]?.text || '';
    const data = JSON.parse(text);
    if (!data.ok) throw new Error('list inbox not ok');
    const names = (data.entries || []).map((e) => e.name);
    if (uploadedPath && !names.some((n) => uploadedPath.endsWith(n))) {
      throw new Error(`uploaded file not in inbox: ${names.join(', ')}`);
    }
    pass('MCP admin_list_inbox', `${names.length} file(s)`);
  } catch (e) {
    fail('MCP admin_list_inbox', e.message);
  }

  // 4. MCP admin_archive_document
  let archivedPath = '';
  try {
    if (!uploadedPath) throw new Error('no uploaded file');
    const mcp = require('./antleroffice-mcp');
    const out = await mcp.callTool('admin_archive_document', {
      source_path: uploadedPath,
      company: 'Coliving',
      category: 'Licenses',
      notes: 'E2E verify script',
    });
    const data = JSON.parse(out?.content?.[0]?.text || '{}');
    if (!data.ok) throw new Error(data.error || 'archive failed');
    archivedPath = data.entry?.path || '';
    if (!archivedPath.includes('Admin Vault/Coliving/Licenses')) {
      throw new Error(`unexpected archive path: ${archivedPath}`);
    }
    pass('MCP admin_archive_document', archivedPath);
  } catch (e) {
    fail('MCP admin_archive_document', e.message);
  }

  // 5. Vault index updated
  try {
    const mcp = require('./antleroffice-mcp');
    const out = await mcp.callTool('admin_list_vault_index', {});
    const data = JSON.parse(out?.content?.[0]?.text || '{}');
    if (!data.ok || !Array.isArray(data.entries)) throw new Error('index missing');
    const hit = data.entries.find((e) => e.path === archivedPath);
    if (archivedPath && !hit) throw new Error('archived entry not in index');
    pass('MCP admin_list_vault_index', `${data.entries.length} entries`);
  } catch (e) {
    fail('MCP admin_list_vault_index', e.message);
  }

  // 6. Task router — without Coliving OAuth
  try {
    const router = require('./task-router');
    const expenseDept = router.route('log room expense for utilities');
    if (expenseDept.role !== 'accounting') {
      throw new Error(`expected accounting without OAuth, got ${expenseDept.role}`);
    }
    const adminDept = router.route('archive SSM license from inbox');
    if (adminDept.role !== 'admin') throw new Error(`expected admin, got ${adminDept.role}`);
    pass('task-router (no Coliving OAuth)', `expense→${expenseDept.role}, archive→${adminDept.role}`);
  } catch (e) {
    fail('task-router (no Coliving OAuth)', e.message);
  }

  // 7. Task router — mock Coliving OAuth connected
  try {
    const portal = require('./portal-partner-oauth');
    const orig = portal.isConnected;
    portal.isConnected = (id) => id === 'coliving';
    const router = require('./task-router');
    const dept = router.route('log room expense for utilities');
    portal.isConnected = orig;
    if (dept.role !== 'coliving_admin') {
      throw new Error(`expected coliving_admin with OAuth, got ${dept.role}`);
    }
    pass('task-router (Coliving OAuth mock)', `expense→${dept.role}`);
  } catch (e) {
    fail('task-router (Coliving OAuth mock)', e.message);
  }

  // 8. handleInstruction enriches attachment paths (route via COO station, not Gateway secretary)
  try {
    const { handleInstruction } = require('./agent-runtime');
    const bossChat = require('./boss-chat-store');
    const threadId = bossChat.resolveThreadId('coo', null, 'local:verify', 'Verify');
    const result = await handleInstruction('E2E archive test', {
      targetAgentId: 'coo',
      mode: 'agent',
      threadId,
      ownerKey: 'local:verify',
      authorName: 'Verify',
      attachments: archivedPath
        ? [{ path: archivedPath, name: 'e2e-ssm-test.pdf' }]
        : [{ path: uploadedPath || 'Admin Vault/_inbox/x.pdf', name: 'x.pdf' }],
    });
    const msgs = bossChat.getMessages(threadId) || [];
    const bossMsg = msgs.find((m) => m.from === 'boss');
    if (!bossMsg?.text?.includes('admin_archive_document')) {
      throw new Error('boss message missing attachment archive hint');
    }
    if (!result?.ok) throw new Error(result.error || 'handleInstruction failed');
    pass('handleInstruction attachment enrichment', `routedTo=${result.routedTo || '?'}`);
  } catch (e) {
    fail('handleInstruction attachment enrichment', e.message);
  }

  // 9. coliving_add_expense stub
  try {
    const mcp = require('./antleroffice-mcp');
    const out = await mcp.callTool('coliving_add_expense', {
      amount: 120,
      description: 'E2E utilities test',
      room_id: 'room-test',
    });
    const data = JSON.parse(out?.content?.[0]?.text || '{}');
    if (!data.stub && !data.ok) throw new Error(JSON.stringify(data));
    pass('MCP coliving_add_expense stub', data.message?.slice(0, 60) || 'ok');
  } catch (e) {
    fail('MCP coliving_add_expense stub', e.message);
  }

  // 10. Duplicate ingest (sha256 dedupe)
  try {
    const hook = require('./inbound-attachment-hook');
    const pdf = Buffer.from(`%PDF-1.4\n% e2e duplicate ${Date.now()}\n1 0 obj\n<<>>\nendobj\n`);
    const first = hook.receiveBuffer(pdf, 'e2e-dup-test.pdf', { source: 'boss_chat_native', mode: 'archive' });
    const second = hook.receiveBuffer(pdf, 'e2e-dup-copy.pdf', { source: 'boss_chat_native', mode: 'archive' });
    if (!first.ok || first.status !== 'ingested') {
      throw new Error(`first upload: ${first.error || first.status}`);
    }
    if (!second.ok || second.status !== 'duplicate') {
      throw new Error(`expected duplicate, got ${second.status}`);
    }
    pass('inbound hook duplicate dedupe', second.path || 'skipped');
  } catch (e) {
    fail('inbound hook duplicate dedupe', e.message);
  }

  // 11. Oversize rejection
  try {
    const hook = require('./inbound-attachment-hook');
    const big = Buffer.alloc(hook.MAX_BYTES + 1, 0x41);
    const result = hook.ingestBuffer(big, 'too-big.bin', { source: 'boss_chat_native' });
    if (result.ok || result.status !== 'rejected') {
      throw new Error(`expected rejected, got ${result.status}`);
    }
    pass('inbound hook size rejection', result.error?.slice(0, 40) || 'rejected');
  } catch (e) {
    fail('inbound hook size rejection', e.message);
  }

  // 12. Gateway source gated off (P0 Boss Chat only)
  try {
    const hook = require('./inbound-attachment-hook');
    const result = hook.ingestBuffer(Buffer.from('x'), 'x.txt', { source: 'whatsapp_gateway' });
    if (result.ok || !String(result.error || '').includes('not enabled')) {
      throw new Error(`expected gated, got ${JSON.stringify(result)}`);
    }
    pass('inbound hook gateway source gated', 'whatsapp_gateway blocked');
  } catch (e) {
    fail('inbound hook gateway source gated', e.message);
  }

  // 13. Boss Chat system message on ingest failure (threadId)
  try {
    const bossChat = require('./boss-chat-store');
    const threadId = bossChat.resolveThreadId('coo', null, 'local:verify-hook', 'Hook verify');
    const before = (bossChat.getMessages(threadId) || []).length;
    const hook = require('./inbound-attachment-hook');
    hook.ingestBuffer(Buffer.alloc(0), 'empty.pdf', {
      source: 'boss_chat_native',
      threadId,
    });
    const after = bossChat.getMessages(threadId) || [];
    const sys = after.slice(before).find((m) => m.from === 'system');
    if (!sys?.text?.includes('could not be saved')) {
      throw new Error('missing system message on empty file rejection');
    }
    pass('inbound hook failure → Boss Chat system message', sys.text.slice(0, 50));
  } catch (e) {
    fail('inbound hook failure → Boss Chat system message', e.message);
  }

  // 14. Boss Chat pending choice → archive resolve
  try {
    const bossChat = require('./boss-chat-store');
    const threadId = bossChat.resolveThreadId('secretary', null, 'local:verify-pending', 'Pending verify');
    const pdf = Buffer.from(`%PDF-1.4\n% pending archive ${Date.now()}\n`);
    const form = new FormData();
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'pending-archive.pdf');
    form.append('source', 'boss_chat_native');
    form.append('threadId', threadId);
    form.append('agentId', 'secretary');
    const stageRes = await fetch(`${BASE}/api/inbound/attachment`, {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: form,
    });
    const staged = await stageRes.json();
    if (!staged.ok || staged.status !== 'pending_choice' || !staged.pendingId) {
      throw new Error(JSON.stringify(staged));
    }
    const resolveRes = await fetch(`${BASE}/api/inbound/attachment/resolve`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingId: staged.pendingId, mode: 'archive', threadId, agentId: 'secretary' }),
    });
    const resolved = await resolveRes.json();
    if (!resolved.ok || resolved.status !== 'ingested' || !resolved.path?.includes('_inbox')) {
      throw new Error(JSON.stringify(resolved));
    }
    pass('pending choice → archive resolve', resolved.path);
  } catch (e) {
    fail('pending choice → archive resolve', e.message);
  }

  // 15. Boss Chat pending choice → reference resolve (no inbox file)
  try {
    const bossChat = require('./boss-chat-store');
    const threadId = bossChat.resolveThreadId('secretary', null, 'local:verify-ref', 'Ref verify');
    const txt = Buffer.from(`Reference material for RAG ${Date.now()}\nLine two about coliving ops.`);
    const form = new FormData();
    form.append('file', new Blob([txt], { type: 'text/plain' }), 'pending-reference.txt');
    form.append('source', 'boss_chat_native');
    form.append('threadId', threadId);
    form.append('agentId', 'secretary');
    const stageRes = await fetch(`${BASE}/api/inbound/attachment`, {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: form,
    });
    const staged = await stageRes.json();
    if (!staged.ok || staged.status !== 'pending_choice') throw new Error(JSON.stringify(staged));
    const resolveRes = await fetch(`${BASE}/api/inbound/attachment/resolve`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingId: staged.pendingId, mode: 'reference', threadId, agentId: 'secretary' }),
    });
    const resolved = await resolveRes.json();
    if (!resolved.ok || resolved.status !== 'reference' || !resolved.chunks) {
      throw new Error(JSON.stringify(resolved));
    }
    const rag = require('./rag');
    const ctx = rag.context('secretary', 'coliving ops');
    if (!ctx.includes('Reference material')) throw new Error('RAG context missing reference text');
    pass('pending choice → reference RAG', `${resolved.chunks} chunks`);
  } catch (e) {
    fail('pending choice → reference RAG', e.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFailed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.err}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
