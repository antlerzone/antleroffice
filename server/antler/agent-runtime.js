const fs = require('node:fs');
const path = require('node:path');
const office = require('./office-state');
const store = require('./store');
const skills = require('./skills');
const roster = require('./roster');
const registry = require('./registry-store');
const runtime = require('./runtime');
const mcpTasklist = require('./mcp-tasklist');
const defaultMcpPack = require('./default-mcp-pack');
const {
  needsBossInput,
  formatUnconfiguredMcpAskBlock,
  bossInputAskMessage,
} = require('./agent-outcome');

const bossChat = require('./boss-chat-store');
const taskMeter = require('./task-meter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const agentQueues = new Map();

function getQueue(key) {
  if (!agentQueues.has(key)) {
    agentQueues.set(key, { busy: false, waiters: [] });
  }
  return agentQueues.get(key);
}

function queueStats(key) {
  const q = getQueue(key);
  return { busy: q.busy, waiting: q.waiters.length };
}

function runQueued(key, fn) {
  const q = getQueue(key);
  return new Promise((resolve, reject) => {
    const job = { fn, resolve, reject };
    if (q.busy) {
      q.waiters.push(job);
      return;
    }
    drainQueue(key, job);
  });
}

async function drainQueue(key, firstJob) {
  const q = getQueue(key);
  q.busy = true;
  let job = firstJob;
  while (job) {
    try {
      const result = await job.fn();
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    }
    job = q.waiters.shift() || null;
  }
  q.busy = false;
}

function chat(from, text, threadId, meta) {
  office.addChat(from, text, threadId, meta);
}

// End-to-end loop:
// boss -> COO · OpenClaw. If the client hired a specialist for this kind of
// work, the COO routes the task to that NPC; otherwise the COO answers the boss
// directly (it is the OpenClaw executor). No throwaway worker NPCs are created.
async function handleInstruction(text, { targetAgentId, mode = 'agent', threadId, authorName, ownerKey } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'empty instruction' };

  const planning = mode === 'plan';
  const instruction = planning
    ? `Produce a clear, step-by-step PLAN to accomplish the task below. Do NOT execute it or generate the final deliverable — only outline the approach, the steps, and anything you'd need.\n\nTask: ${raw}`
    : raw;

  const resolvedAgentId = targetAgentId || 'coo';
  const userKey = ownerKey || 'local:boss';

  if (mode === 'agent' || mode === 'plan') {
    const gwTarget = office.resolveOpenClawAgentId(resolvedAgentId);
    if (gwTarget) {
      return {
        ok: false,
        error:
          'This agent uses OpenClaw Gateway chat. Open Boss Chat and send your message there (Agent or Plan mode).',
      };
    }
  }

  const queueKey = `${userKey}:${resolvedAgentId}`;
  const activeThreadId = bossChat.resolveThreadId(resolvedAgentId, threadId, userKey, authorName);
  const authorMeta = { authorName: authorName || 'Boss' };

  chat('boss', planning ? `📋 [Plan] ${raw}` : raw, activeThreadId, authorMeta);
  const shortTask = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;

  const before = queueStats(queueKey);
  const queued = before.busy || before.waiting > 0;
  if (queued) {
    chat(
      'system',
      `Queued — ${before.waiting + (before.busy ? 1 : 0)} task(s) ahead in your chat with this agent.`,
      activeThreadId,
      { authorName: 'Office' },
    );
  }

  runQueued(queueKey, async () => {
    if (targetAgentId) {
      const agent = office.getAgent(targetAgentId);
      if (!agent) throw new Error('Agent not found');
      // Direct COO chat must use runAsCoo — it carries the COO system prompt and
      // builtin MCP pack (web research). directToAgent treats COO like a generic NPC.
      if (agent.id === 'coo' || agent.role === 'coo') {
        await runAsCoo({ instruction, shortTask, planning, rawTask: raw, threadId: activeThreadId, ownerKey: userKey });
        return { routedTo: agent.role, agentId: agent.id };
      }
      await directToAgent({
        instruction,
        agent,
        shortTask,
        planning,
        rawTask: raw,
        threadId: activeThreadId,
      });
      return { routedTo: agent.role, agentId: agent.id };
    }

    const dept = roster.route(instruction);
    await choreograph({
      instruction,
      dept,
      shortTask,
      planning,
      rawTask: raw,
      threadId: activeThreadId,
    });
    return { routedTo: dept.role };
  }).catch((err) => {
    chat('system', `Error: ${err.message}`, activeThreadId, { authorName: 'Office' });
    if (targetAgentId) office.rest(targetAgentId, '');
    else office.rest('coo', '');
  });

  return {
    ok: true,
    routedTo: targetAgentId ? office.getAgent(targetAgentId)?.role : roster.route(instruction).role,
    agentId: targetAgentId || undefined,
    threadId: activeThreadId,
    queued,
    queuePosition: queued ? before.waiting + (before.busy ? 1 : 0) : 0,
  };
}

// Find a client-hired agent that fits the routed department: first by matching
// skill, then by role. Returns null when the client hasn't added one yet.
function findHiredAgentFor(dept) {
  const hired = office.state.agents.filter((a) => a.userAgentId && !a.external);
  return (
    (dept.skillId && hired.find((a) => (a.skillIds || []).includes(dept.skillId))) ||
    hired.find((a) => a.role === dept.role) ||
    null
  );
}

// Resolve an agent's effective skill system prompt(s). User-created agents carry
// skillIds; resident department NPCs map to their roster skill.
function systemForAgent(agent) {
  const parts = [];
  if (agent.skillIds && agent.skillIds.length) {
    const all = registry.listSkills();
    for (const sid of agent.skillIds) {
      const sk = all.find((s) => s.id === sid);
      if (sk && sk.system) parts.push(sk.system);
    }
  }
  if (!parts.length) {
    const dept = roster.byRole(agent.role);
    if (dept) parts.push(skillFor(dept).system);
  }
  if (!parts.length) parts.push('You are a capable office worker agent inside AntlerOffice.');
  return parts.join('\n\n');
}

function registryAgentForOfficeAgent(agent) {
  if (agent?.userAgentId) return registry.getAgent(agent.userAgentId);
  if (agent?.id && String(agent.id).startsWith('user:')) {
    return registry.getAgent(String(agent.id).slice(5));
  }
  return null;
}

function mcpContextForStep(step, mcpServers) {
  if (!step?.mcpId || !step?.accountId) return '';
  const server = (mcpServers || []).find((s) => s.id === step.mcpId);
  const account = server?.accounts?.find((a) => a.id === step.accountId);
  if (!server || !account) return '';
  const headers = account.headers || registry.buildMcpAccountHeaders(account);
  return (
    `Use MCP server "${server.name}" (${server.url || server.id}) with account "${account.label}".\n` +
    `Per-session auth headers (use when opening this MCP connection):\n${JSON.stringify(headers, null, 2)}`
  );
}

async function runAgentTask({ agent, instruction, system, mcpServers = [], threadId, ownerKey } = {}) {
  return runtime.runTask({ agent, instruction, system, mcpServers, threadId, ownerKey });
}

async function runTaskSteps({ agent, steps, baseSystem, mcpServers, shortTask, planning, rawTask }) {
  const parallel = steps.length > 1;
  office.setAgent(agent.id, {
    bubbleText: parallel ? `Running ${steps.length} tasks…` : 'Producing output…',
    currentJob: {
      label: shortTask,
      step: parallel ? `${steps.length} parallel subtasks` : 'Producing deliverable',
      progress: 2,
      total: 2,
    },
  });

  const runOne = async (step, index) => {
    const mcpBlock = mcpContextForStep(step, mcpServers);
    const system = [baseSystem, mcpBlock].filter(Boolean).join('\n\n');
    const label = step.accountLabel ? `[${step.accountLabel}] ` : '';
    const { text, provider } = await runAgentTask({
      agent,
      instruction: `${label}${step.instruction}`,
      system,
      mcpServers,
    });
    return { text, provider, step, index };
  };

  const results = parallel
    ? await Promise.all(steps.map((step, index) => runOne(step, index)))
    : [await runOne(steps[0], 0)];

  results.sort((a, b) => a.index - b.index);
  const combined = results
    .map((r) => {
      const prefix = r.step.accountLabel ? `### ${r.step.accountLabel}\n` : '';
      return `${prefix}${r.text}`;
    })
    .join('\n\n---\n\n');
  const providers = [...new Set(results.map((r) => r.provider).filter(Boolean))];
  return { text: combined, provider: providers.join(', ') || 'demo' };
}

// Send one instruction straight to a chosen agent. AntlerOffice gathers context
// and relays to OpenClaw (the real executor) via the runtime adapter; the
// adapter injects this agent's memory + learned knowledge and falls back to the
// local demo executor when OpenClaw isn't installed.
async function directToAgent({ instruction, agent, shortTask, planning = false, rawTask = '', threadId = null }) {
  office.work(agent.id, 'Working on it…', { label: shortTask, step: 'Thinking', progress: 1, total: 2 });

  const notes = skills.readSharedNotes();
  let baseSystem = `${systemForAgent(agent)}\n\nShared office knowledge:\n${notes || '(none yet)'}`;
  if (agent.role === 'human_resource') {
    const catalogBlock = await saasNpcBlock();
    if (catalogBlock) baseSystem = `${baseSystem}\n\n${catalogBlock}`;
  }

  const regAgent = registryAgentForOfficeAgent(agent);
  const { mcpBindings, mcpServers } = regAgent
    ? registry.resolveAgentMcpRuntimeSpec(regAgent.id)
    : { mcpBindings: [], mcpServers: [] };
  const steps = regAgent
    ? mcpTasklist.assignTasklistAccounts(rawTask || instruction, mcpBindings, registry)
    : [{ instruction: rawTask || instruction, mcpId: null, accountId: null, accountLabel: null }];
  const useTasklist =
    regAgent &&
    mcpTasklist.hasMultiAccountBindings(mcpBindings, registry) &&
    steps.length > 1;

  await sleep(900);

  const taskP = useTasklist
    ? runTaskSteps({
        agent,
        steps,
        baseSystem,
        mcpServers,
        shortTask,
        planning,
        rawTask,
      })
    : (async () => {
        const step = steps[0];
        const mcpBlock = mcpContextForStep(step, mcpServers);
        const system = [baseSystem, mcpBlock].filter(Boolean).join('\n\n');
        office.setAgent(agent.id, {
          bubbleText: 'Producing output…',
          currentJob: { label: shortTask, step: 'Producing deliverable', progress: 2, total: 2 },
        });
        return runAgentTask({
          agent,
          instruction: step.accountLabel ? `[${step.accountLabel}] ${step.instruction}` : step.instruction,
          system,
          mcpServers,
          threadId,
        });
      })();

  const { text, provider, needsBossInput: waitingOnBoss } = await taskP;

  const file = saveDeliverable(agent.role || 'agent', rawTask || instruction, text);
  if (planning) {
    recordDeliverable(agent, rawTask || instruction, file, { kind: 'plan_complete' });
  }
  finalizeAgentTurn({
    agent,
    text,
    provider,
    threadId,
    planning,
    needsBossInput: waitingOnBoss,
  });
}

function finalizeAgentTurn({
  agent,
  text,
  provider,
  threadId,
  planning = false,
  needsBossInput: waitingOnBoss = false,
  taskScope = 'home',
  tokens = 0,
}) {
  const label = agent.label || agent.role || 'Agent';
  chat(agent.role, text, threadId);

  if (agent.id) {
    const regAgent = registry.getAgent(agent.id) || agent;
    void taskMeter.meterTaskRun(regAgent, { tokens }).catch(() => {});
  }

  const waiting = waitingOnBoss || needsBossInput(text);
  if (planning) {
    chat('system', `${label} saved your plan — see Complete Job.`, threadId);
    office.rest(agent.id, 'Done ✓');
    return;
  }

  if (waiting) {
    chat('system', bossInputAskMessage({ agentLabel: label, provider }), threadId);
    office.setAgent(agent.id, {
      npcState: 'working',
      bubbleText: 'Waiting for your key…',
      currentJob: { label: 'Needs input', step: 'Waiting', progress: 2, total: 2 },
      awaitingBossInput: true,
    });
    return;
  }

  chat('system', `${label} finished — done (via ${provider || 'openclaw'}).`, threadId);
  office.rest(agent.id, 'Done ✓');
}

function recordDeliverable(agent, task, file, { kind = 'plan_complete' } = {}) {
  try {
    registry.addDeliverable({
      agentId: agent.id,
      agentLabel: agent.label || agent.role,
      task,
      file,
      kind,
    });
  } catch {
    /* index is best-effort */
  }
}

async function choreograph({ instruction, dept, shortTask, planning = false, rawTask = '', threadId = null }) {
  // If the client has hired a specialist for this kind of work, the COO routes
  // the task to them. Otherwise the COO · OpenClaw simply answers it itself —
  // it IS the OpenClaw executor, so it never spawns throwaway worker NPCs.
  const hired = findHiredAgentFor(dept);
  if (hired) {
    office.work('coo', `Routing: ${shortTask}`);
    chat('coo', `Assigning this to ${hired.label}.`, threadId);
    office.rest('coo', '');
    await directToAgent({ instruction, agent: hired, shortTask, planning, rawTask, threadId });
    return;
  }

  await runAsCoo({ instruction, shortTask, planning, rawTask, threadId });
}

function skillFor(dept) {
  const reg = skills.loadRegistry();
  const list = reg.skills || [];
  return (
    list.find((s) => s.id === dept.skillId) ||
    list.find((s) => s.id === 'general') || { id: 'general', name: 'General', system: '' }
  );
}

async function saasNpcBlock() {
  try {
    const base = (
      process.env.ECS_BASE_URL ||
      process.env.ECS_SERVER_URL ||
      'http://localhost:3030'
    ).replace(/\/+$/, '');
    const headers = { Accept: 'application/json' };
    const token = process.env.ECS_ADMIN_TOKEN;
    if (token) headers['x-admin-token'] = token;
    const res = await fetch(`${base}/api/admin/catalog/workers`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const workers = Array.isArray(data.workers) ? data.workers : [];
    const lines = workers.map(
      (w) =>
        `- ${w.id} (template: ${w.templateId}) — ${w.name} — ${w.salaryCreditsPerMonth} credits/mo — installable: ${w.installable ? 'yes' : 'no'}`,
    );
    return (
      `SaaS worker catalog (ECS ${base}):\n${lines.join('\n') || '(empty)'}\n\n` +
      'Use AntlerOffice Tools MCP: `list_saas_workers`, `get_saas_worker`, `create_saas_worker`. Confirm with the boss before creating.'
    );
  } catch {
    return '';
  }
}

// The COO · OpenClaw answers the boss directly (chat / general requests, or any
// task with no hired specialist). It's the built-in OpenClaw agent, so this is a
// plain reply — no new NPC is created.
async function runAsCoo({ instruction, shortTask, planning = false, rawTask = '', threadId = null, ownerKey = null }) {
  const coo = office.getAgent('coo') || { id: 'coo', role: 'coo', label: 'COO · OpenClaw' };
  const cooName = coo.label || 'COO · OpenClaw';
  office.work('coo', 'OpenClaw working…', { label: shortTask, step: 'Gateway', progress: 1, total: 2 });

  const notes = skills.readSharedNotes();
  const webAccounts = require('./web-accounts-store');
  const accountsBlock = webAccounts.formatAgentBlock();
  const system =
    `You are ${cooName}, the boss's right-hand operator inside AntlerOffice. ` +
    `Reply to the boss directly, helpfully and concisely. For small talk, just chat back. ` +
    `When the boss shares a URL or asks you to review something (GitHub repo, docs, product), ` +
    `research it with OpenClaw built-in tools (exec, browser) and give a substantive summary. ` +
    `If a request truly needs a specialist the office hasn't hired yet, say so and suggest hiring one.` +
    `When the boss shares website login credentials (username/password), ask for a display name if not provided, then use AntlerOffice Tools MCP ` +
    '`save_web_account` (display_name required) to store them — confirm with display name/alias only, never repeat the password in chat.' +
    `\n\nShared office knowledge:\n${notes || '(none yet)'}` +
    (accountsBlock ? `\n\n${accountsBlock}` : '');

  const { mcpServers: allMcp } = defaultMcpPack.resolveBuiltinMcpRuntimeSpec('coo');
  const { mcpHasCredentials } = require('./mcp-runtime-helper');
  const mcpServers = (allMcp || []).filter(mcpHasCredentials);
  const unconfiguredMcpBlock = formatUnconfiguredMcpAskBlock(allMcp);
  const fullSystem = unconfiguredMcpBlock ? `${system}\n\n${unconfiguredMcpBlock}` : system;

  // Start the model call immediately; overlap it with the brief "thinking" beat.
  const taskP = runtime.runTask({
    agent: coo,
    instruction,
    system: fullSystem,
    mcpServers,
    threadId,
    ownerKey,
  });
  await sleep(500);
  office.setAgent('coo', { bubbleText: 'OpenClaw running…', currentJob: { label: shortTask, step: 'Tools', progress: 2, total: 2 } });
  const { text, provider, needsBossInput: waitingOnBoss } = await taskP;

  if (planning) {
    const file = saveDeliverable('coo', rawTask || instruction, text);
    recordDeliverable(coo, rawTask || instruction, file, { kind: 'plan_complete' });
  }
  finalizeAgentTurn({
    agent: coo,
    text,
    provider,
    threadId,
    planning,
    needsBossInput: waitingOnBoss,
  });
}

function saveDeliverable(skillId, instruction, text) {
  const dir = path.join(store.getDataDir(), 'deliverables');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${skillId}-${stamp}.md`);
  fs.writeFileSync(file, `# Task\n${instruction}\n\n# Result\n${text}\n`, 'utf8');
  return file;
}

function savePlanDeliverable({ agentIdOrRole = 'coo', task, result }) {
  const agent = office.getAgent(agentIdOrRole) || office.getAgent('coo');
  const skillId = agent?.role || 'coo';
  const file = saveDeliverable(skillId, task, result);
  if (agent) recordDeliverable(agent, task, file, { kind: 'plan_complete' });
  return file;
}

module.exports = { handleInstruction, savePlanDeliverable };
