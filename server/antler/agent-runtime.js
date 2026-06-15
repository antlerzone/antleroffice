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

const bossChat = require('./boss-chat-store');

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

async function runAgentTask({ agent, instruction, system, mcpServers = [] }) {
  return runtime.runTask({ agent, instruction, system, mcpServers });
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
  const baseSystem = `${systemForAgent(agent)}\n\nShared office knowledge:\n${notes || '(none yet)'}`;

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
        });
      })();

  const { text, provider } = await taskP;

  const file = saveDeliverable(agent.role || 'agent', rawTask || instruction, text);
  if (planning) {
    recordDeliverable(agent, rawTask || instruction, file, { kind: 'plan_complete' });
  }
  chat(agent.role, text, threadId);
  chat('system', `${agent.label} finished — ${planning ? 'plan saved' : 'done'} (via ${provider}).`, threadId);
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

// The COO · OpenClaw answers the boss directly (chat / general requests, or any
// task with no hired specialist). It's the built-in OpenClaw agent, so this is a
// plain reply — no new NPC is created.
async function runAsCoo({ instruction, shortTask, planning = false, rawTask = '', threadId = null }) {
  const coo = office.getAgent('coo') || { id: 'coo', role: 'coo', label: 'COO · OpenClaw' };
  const cooName = coo.label || 'COO · OpenClaw';
  office.work('coo', 'Thinking…', { label: shortTask, step: 'Thinking', progress: 1, total: 2 });

  const notes = skills.readSharedNotes();
  const system =
    `You are ${cooName}, the boss's right-hand operator inside AntlerOffice. ` +
    `Reply to the boss directly, helpfully and concisely. For small talk, just chat back. ` +
    `If a request truly needs a specialist the office hasn't hired yet, say so and suggest hiring one.` +
    `\n\nShared office knowledge:\n${notes || '(none yet)'}`;

  const { mcpServers } = defaultMcpPack.resolveBuiltinMcpRuntimeSpec('coo');

  // Start the model call immediately; overlap it with the brief "thinking" beat.
  const taskP = runtime.runTask({ agent: coo, instruction, system, mcpServers });
  await sleep(500);
  office.setAgent('coo', { bubbleText: 'Replying…', currentJob: { label: shortTask, step: 'Replying', progress: 2, total: 2 } });
  const { text } = await taskP;

  chat('coo', text, threadId);
  if (planning) {
    const file = saveDeliverable('coo', rawTask || instruction, text);
    recordDeliverable(coo, rawTask || instruction, file, { kind: 'plan_complete' });
    chat('system', `${cooName} saved your plan — see Complete Job.`, threadId);
  }
  office.rest('coo', 'Done ✓');
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

module.exports = { handleInstruction };
