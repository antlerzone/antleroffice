#!/usr/bin/env node
// Smoke tests for Plan 2 (ECS catalog), Plan 3 (Boss OAuth), Plan 4a (office share).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ECS = (process.env.ECS_BASE_URL || 'http://localhost:3030').replace(/\/+$/, '');
const DESKTOP = (process.env.DESKTOP_BASE_URL || 'http://127.0.0.1:3020').replace(/\/+$/, '');
const DATA_DIR = process.env.ANTLEROFFICE_DATA_DIR || path.join(os.homedir(), '.antleroffice2');

const results = [];

function pass(name) {
  results.push({ name, ok: true });
  console.log(`  ✓ ${name}`);
}

function fail(name, err) {
  results.push({ name, ok: false, err: String(err) });
  console.log(`  ✗ ${name}: ${err}`);
}

async function json(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function main() {
  console.log(`ECS: ${ECS}`);
  console.log(`Desktop: ${DESKTOP}\n`);

  // Plan 2 — catalog
  try {
    const { res, body } = await json(`${ECS}/api/catalog/agents`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!Array.isArray(body.templates) || !body.templates.length) throw new Error('empty templates');
    pass('ECS catalog /api/catalog/agents');
    const tpl = body.templates?.find((t) => t.id === 'graphic_design');
    if (tpl?.bundleUrl) pass('ECS catalog includes bundleUrl');
    else fail('ECS catalog includes bundleUrl', 'graphic_design missing bundleUrl');
  } catch (e) {
    fail('ECS catalog /api/catalog/agents', e.message);
  }

  try {
    const { res, body } = await json(`${DESKTOP}/api/config/agents/catalog`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!Array.isArray(body.templates)) throw new Error('missing templates');
    pass(`Desktop catalog (source=${body.source || '?'})`);
  } catch (e) {
    fail('Desktop catalog proxy', e.message);
  }

  // Plan 3 — auth config + login
  let ecsToken = '';
  try {
    const { res, body } = await json(`${DESKTOP}/api/boss/auth/config`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!body.ecsEnabled && process.env.REQUIRE_ECS === '1') {
      throw new Error('ECS not enabled — set ECS_BASE_URL on desktop backend');
    }
    pass(`Boss auth config (ecsEnabled=${!!body.ecsEnabled})`);
  } catch (e) {
    fail('Boss auth config', e.message);
  }

  try {
    const { res, body } = await json(`${ECS}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'boss@antleroffice.local', password: 'demo123' }),
    });
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    ecsToken = body.accessToken;
    pass('ECS direct login');
  } catch (e) {
    fail('ECS direct login', e.message);
  }

  // Plan 4a — office create + join
  let inviteCode = '';
  let officeId = '';
  if (ecsToken) {
    try {
      const { res, body } = await json(`${ECS}/api/offices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ecsToken}`,
        },
        body: JSON.stringify({ name: 'Verify Office' }),
      });
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      inviteCode = body.office?.inviteCode;
      officeId = body.office?.id;
      if (!inviteCode) throw new Error('no invite code');
      pass('ECS office create');
    } catch (e) {
      fail('ECS office create', e.message);
    }

    if (inviteCode) {
      try {
        const { res, body } = await json(`${ECS}/api/offices/join`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ecsToken}`,
          },
          body: JSON.stringify({ inviteCode, hostUrl: 'http://127.0.0.1:3020' }),
        });
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        pass('ECS office join');
      } catch (e) {
        fail('ECS office join', e.message);
      }
    }
  }

  try {
    const { res, body } = await json(`${ECS}/health`);
    if (!res.ok || !body.ok) throw new Error('unhealthy');
    pass('ECS health');
  } catch (e) {
    fail('ECS health', e.message);
  }

  // Plan 4a — member read-only on host
  if (ecsToken && inviteCode && officeId) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DATA_DIR, 'office-share.json'),
        JSON.stringify(
          {
            enabled: true,
            officeId,
            inviteCode,
            hostUrl: DESKTOP,
            memberToken: null,
            role: 'owner',
          },
          null,
          2,
        ),
      );

      const reg = await json(`${ECS}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `member-${Date.now()}@test.local`,
          password: 'demo123',
          name: 'Verify Member',
        }),
      });
      const memberEmail = reg.body.user?.email;
      if (!memberEmail) throw new Error('could not register member user');

      const login = await json(`${ECS}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: memberEmail, password: 'demo123' }),
      });
      const memberEcsToken = login.body.accessToken;
      if (!memberEcsToken) throw new Error('member login failed');

      const joinRes = await json(`${ECS}/api/offices/join`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${memberEcsToken}`,
        },
        body: JSON.stringify({ inviteCode, hostUrl: DESKTOP }),
      });
      const memberToken = joinRes.body.memberToken;
      if (!memberToken) throw new Error('no member token');

      const snap = await fetch(`${DESKTOP}/api/office/snapshot`, {
        headers: { 'X-Office-Member-Token': memberToken },
      });
      if (snap.ok) pass('Host snapshot with member token');
      else fail('Host snapshot with member token', `HTTP ${snap.status}`);

      const hire = await fetch(`${DESKTOP}/api/config/agents/hire`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Office-Member-Token': memberToken,
        },
        body: JSON.stringify({ templateId: 'graphic_design', name: 'Blocked' }),
      });
      if (hire.status === 403) pass('Member hire blocked (403)');
      else fail('Member hire blocked', `expected 403, got ${hire.status}`);

      const presence = await json(`${DESKTOP}/api/office/presence`);
      if (presence.res.ok && Array.isArray(presence.body.viewers)) {
        pass('Office presence API');
      } else {
        fail('Office presence API', `HTTP ${presence.res.status}`);
      }
    } catch (e) {
      fail('Member host access', e.message);
    }
  }

  // Plan 2 — ECS agent bundle
  try {
    const { res, body } = await json(`${ECS}/api/catalog/agents/graphic_design/bundle`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!body.manifest?.id || !body.files?.['skills/create-npc-skin.json']) {
      throw new Error('bundle missing skill file');
    }
    pass(`ECS graphic_design bundle (v${body.manifest.version || '?'})`);
  } catch (e) {
    fail('ECS graphic_design bundle', e.message);
  }

  // Boss chat — per-user thread isolation (offline)
  try {
    const testDir = path.join(os.tmpdir(), `antler-boss-chat-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    const storeMod = require('./store');
    storeMod.setDataDir(testDir);
    delete require.cache[require.resolve('./boss-chat-store')];
    const bossChat = require('./boss-chat-store');
    const t1 = bossChat.createThread('agent-1', 'Alice task', {
      ownerKey: 'user:alice',
      ownerName: 'Alice',
    });
    bossChat.createThread('agent-1', 'Bob task', { ownerKey: 'user:bob', ownerName: 'Bob' });
    const alice = bossChat.listThreads('agent-1', 'user:alice');
    const bob = bossChat.listThreads('agent-1', 'user:bob');
    if (alice.length !== 1 || bob.length !== 1) throw new Error('expected one thread per owner');
    if (alice[0].id === bob[0].id) throw new Error('owners share thread id');
    if (bossChat.getThreadForOwner(t1.id, 'user:bob')) throw new Error('cross-owner thread access');
    pass('Boss chat per-user thread isolation');
  } catch (e) {
    fail('Boss chat per-user thread isolation', e.message);
  }

  // Gateway → office-state adapter (offline)
  try {
    delete require.cache[require.resolve('./office-state')];
    delete require.cache[require.resolve('./gateway-office-adapter')];
    const office = require('./office-state');
    const gwAdapter = require('./gateway-office-adapter');
    office.ensureRole('coo', 'COO · OpenClaw', 0);
    office.loadUserAgents([
      { id: 'designer-1', name: 'Lobster', role: 'graphic_design', openclawAgentId: 'lobster-1', sprite: 2 },
    ]);
    const coo = gwAdapter.resolveOfficeAgent('main');
    const hired = gwAdapter.resolveOfficeAgent('lobster-1');
    if (!coo || coo.role !== 'coo') throw new Error('main should map to COO');
    if (!hired || hired.label !== 'Lobster') throw new Error('openclawAgentId mapping failed');
    gwAdapter.handleGatewayEvent('agent', {
      sessionKey: 'agent:lobster-1:main',
      stream: 'tool',
      data: { phase: 'start', name: 'Browser' },
    });
    const after = office.getAgent(hired.id);
    if (after.npcState !== 'working' || !after.bubbleText.includes('Browser')) {
      throw new Error('gateway event did not set working state');
    }
    pass('Gateway → Pixel Office adapter');
  } catch (e) {
    fail('Gateway → Pixel Office adapter', e.message);
  }

  // WhatsApp instruction mode — self-only allowFrom
  try {
    const instr = require('./channel-instruction-mode');
    const variants = instr.whatsappAllowFromVariants('0122113361');
    if (!variants.some((v) => v.includes('60122113361'))) {
      throw new Error(`expected MY intl variant, got ${variants.join(',')}`);
    }
    pass('WhatsApp instruction mode allowFrom variants');
  } catch (e) {
    fail('WhatsApp instruction mode allowFrom variants', e.message);
  }

  const ok = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n${ok}/${total} passed`);
  if (ok < total) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
