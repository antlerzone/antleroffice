// Offline verification for runtime/index.js retry + memory-poisoning guard.
// Run: node verify-runtask-retry.js   (no network, no OpenClaw, no API key)
// Stubs sibling modules via require.cache, then exercises runTask end-to-end.

const assert = require('assert');
const path = require('path');

const ctl = { script: [], openclawCalls: [], demoCalls: [], recorded: [], records: [], demoHasKey: false };

function stub(relPath, exports) {
  const p = require.resolve(path.join(__dirname, relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

stub('../rag.js', { context: async () => '' });
stub('../materials.cjs', { getRootPath: () => '/tmp/materials' });
stub('../mcp-runtime-helper.js', {
  formatMcpServersBlock: () => '',
  formatOpenClawBuiltinToolsBlock: () => '',
});
stub('../agent-outcome.js', {
  bossInputEscalationBlock: () => '',
  needsBossInput: () => false,
  bossInputAskMessage: ({ agentLabel }) => `${agentLabel} needs your OpenClaw key.`,
});
stub('./hermes.js', {
  getContext: async () => '',
  record: (k, e) => ctl.records.push({ k, e }),
  recordAfterTask: async (k, o) => ctl.recorded.push({ k, o }),
});
stub('./demo.js', {
  run: async ({ note }) => {
    ctl.demoCalls.push(note || '');
    if (ctl.demoHasKey) return { ok: true, text: 'real fallback answer', provider: 'demo:openai' };
    return { ok: true, text: `(${note || 'demo'}) placeholder deliverable`, provider: 'demo' };
  },
});
stub('./openclaw.js', {
  run: async (p) => {
    ctl.openclawCalls.push(p);
    const step = ctl.script.shift();
    if (!step) throw new Error('script exhausted');
    return step;
  },
});

const { runTask } = require('./index.js');

function reset() {
  ctl.script = [];
  ctl.openclawCalls = [];
  ctl.demoCalls = [];
  ctl.recorded = [];
  ctl.records = [];
  ctl.demoHasKey = false;
}

async function main() {
  // 1. Transient gateway failure then success -> retried, real answer, memory recorded.
  reset();
  ctl.script = [
    { ok: false, available: true, error: 'chat.send failed' },
    { ok: true, text: 'real answer', provider: 'openclaw-gateway' },
  ];
  const r1 = await runTask({ agent: { role: 'sales' }, instruction: 'do thing' });
  assert.strictEqual(r1.text, 'real answer');
  assert.strictEqual(ctl.openclawCalls.length, 2, 'transient failure retried');
  assert.strictEqual(ctl.demoCalls.length, 0, 'no placeholder shown');
  assert.strictEqual(ctl.recorded.length, 1, 'real outcome recorded to memory');
  console.log('PASS 1: transient failure -> retry -> real answer, memory kept');

  // 2. Auth error -> NO retry, ask boss, memory NOT polluted.
  reset();
  ctl.script = [{ ok: false, available: true, authError: true, error: '401' }];
  const r2 = await runTask({ agent: { role: 'sales' }, instruction: 'do thing' });
  assert.strictEqual(ctl.openclawCalls.length, 1, 'auth error must not retry');
  assert.strictEqual(r2.needsBossInput, true);
  assert.strictEqual(ctl.recorded.length, 0, 'canned ask must NOT be recorded');
  console.log('PASS 2: auth error -> no retry, asks boss, memory clean');

  // 3. Timeout -> NO retry (avoid double-executing side effects), placeholder, memory clean.
  reset();
  ctl.script = [{ ok: false, available: true, error: 'OpenClaw Gateway timed out waiting for a reply' }];
  const r3 = await runTask({ agent: { role: 'sales' }, instruction: 'post to xhs' });
  assert.strictEqual(ctl.openclawCalls.length, 1, 'timeout must NOT be retried');
  assert.strictEqual(ctl.demoCalls.length, 1, 'falls back to demo');
  assert.strictEqual(r3.provider, 'demo');
  assert.strictEqual(ctl.recorded.length, 0, 'placeholder must NOT be recorded');
  console.log('PASS 3: timeout -> no blind retry, placeholder NOT recorded');

  // 4. Persistent transient failure -> 3 attempts, placeholder shown, memory clean.
  reset();
  ctl.script = [
    { ok: false, available: true, error: 'gateway not running' },
    { ok: false, available: true, error: 'gateway not running' },
    { ok: false, available: true, error: 'gateway not running' },
  ];
  const t0 = Date.now();
  await runTask({ agent: { role: 'sales' }, instruction: 'do thing' });
  assert.strictEqual(ctl.openclawCalls.length, 3, '3 attempts then give up');
  assert.ok(Date.now() - t0 >= 6900, 'backoff delays applied (2s+5s)');
  assert.ok(/after retries/.test(String(ctl.demoCalls[0])), 'note mentions retries');
  assert.strictEqual(ctl.recorded.length, 0, 'placeholder must NOT be recorded');
  console.log('PASS 4: persistent failure -> 3 attempts + backoff, memory clean');

  // 5. Fallback with real boss key -> real answer recorded (fallback model).
  reset();
  ctl.demoHasKey = true;
  ctl.script = [
    { ok: false, available: true, error: 'gateway not running' },
    { ok: false, available: true, error: 'gateway not running' },
    { ok: false, available: true, error: 'gateway not running' },
  ];
  const r5 = await runTask({ agent: { role: 'sales' }, instruction: 'do thing' });
  assert.strictEqual(r5.provider, 'demo:openai');
  assert.strictEqual(ctl.recorded.length, 1, 'real fallback answer IS recorded');
  console.log('PASS 5: fallback with real key -> answer recorded');

  // 6. OpenClaw not installed -> straight to demo, no retry loop.
  reset();
  ctl.script = [{ ok: false, available: false }];
  const r6 = await runTask({ agent: { role: 'sales' }, instruction: 'do thing' });
  assert.strictEqual(ctl.openclawCalls.length, 1, 'not-installed must not retry');
  assert.strictEqual(ctl.demoCalls.length, 1);
  assert.ok(!r6.degraded, 'pure demo mode is expected, NOT degraded');
  console.log('PASS 6: not installed -> no retry, demo fallback, not degraded');

  // 7. degraded flag: failure placeholder is flagged so agent-runtime can
  //    mark the task FAILED instead of complete (no fake deliverables).
  reset();
  ctl.script = [{ ok: false, available: true, error: 'OpenClaw Gateway timed out waiting for a reply' }];
  const r7 = await runTask({ agent: { role: 'sales' }, instruction: 'do thing' });
  assert.strictEqual(r7.degraded, true, 'failure placeholder must be degraded');
  assert.ok(/timed out/.test(r7.degradedError), 'degradedError carries the cause');
  console.log('PASS 7: failure placeholder -> degraded=true with cause');

  // 8. degraded flag: real answer from boss key fallback is NOT degraded.
  reset();
  ctl.demoHasKey = true;
  ctl.script = [
    { ok: false, available: true, error: 'gateway not running' },
    { ok: false, available: true, error: 'gateway not running' },
    { ok: false, available: true, error: 'gateway not running' },
  ];
  const r8 = await runTask({ agent: { role: 'sales' }, instruction: 'do thing' });
  assert.ok(!r8.degraded, 'real fallback answer must NOT be degraded');
  console.log('PASS 8: real key fallback -> degraded=false');

  console.log('\nAll 8 checks passed.');
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
