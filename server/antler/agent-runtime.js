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
const orgRoles = require('./org-roles');
const secretaryFbIntake = require('./secretary-fb-intake');
const secretaryItIntake = require('./secretary-it-intake');
const ceoPipelinePending = require('./ceo-pipeline-pending');
const devPipeline = require('./runtime/dev-pipeline');
const workflowContext = require('./workflow-context');

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

// boss -> Secretary (OpenClaw main). Secretary forwards to hired CEO, who routes to department workers.
async function handleInstruction(text, { targetAgentId, mode = 'agent', threadId, authorName, ownerKey } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'empty instruction' };

  const planning = mode === 'plan';
  const instruction = planning
    ? `Produce a clear, step-by-step PLAN to accomplish the task below. Do NOT execute it or generate the final deliverable — only outline the approach, the steps, and anything you'd need.\n\nTask: ${raw}`
    : raw;

  let resolvedAgentId = targetAgentId || orgRoles.SECRETARY_ROLE;
  const agentForTarget = office.getAgent(resolvedAgentId);
  if (!orgRoles.isSecretaryRole(resolvedAgentId) && !orgRoles.isSecretaryRole(agentForTarget?.role)) {
    resolvedAgentId = orgRoles.SECRETARY_ROLE;
  }
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
    const secretary = orgRoles.findSecretary();
    const secretaryId = secretary?.id || orgRoles.SECRETARY_ROLE;

    if (targetAgentId && orgRoles.isCeoRole(office.getAgent(targetAgentId)?.role)) {
      const agent = office.getAgent(targetAgentId);
      if (!agent) throw new Error('Agent not found');
      const resumed = await tryResumeCeoPipeline({
        raw,
        threadId: activeThreadId,
        ownerKey: userKey,
        shortTask,
        planning,
      });
      if (!resumed?.handled) {
        await runAsCeo({
          instruction,
          shortTask,
          planning,
          rawTask: raw,
          threadId: activeThreadId,
          ownerKey: userKey,
        });
      }
      return { routedTo: agent.role, agentId: agent.id };
    }

    if (targetAgentId && !orgRoles.isSecretaryRole(targetAgentId)) {
      const agent = office.getAgent(targetAgentId);
      if (agent && orgRoles.isSecretaryRole(agent.role)) {
        await runAsSecretary({ instruction, shortTask, planning, rawTask: raw, threadId: activeThreadId, ownerKey: userKey });
        return { routedTo: 'secretary', agentId: agent.id };
      }
    }

    if (!targetAgentId || orgRoles.isSecretaryRole(resolvedAgentId)) {
      await runAsSecretary({ instruction, shortTask, planning, rawTask: raw, threadId: activeThreadId, ownerKey: userKey });
      return { routedTo: 'secretary', agentId: secretaryId };
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
    else office.rest(orgRoles.SECRETARY_ROLE, '');
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
    bubbleText: parallel ? `Processing: ${steps.length} parallel tasks` : 'Processing…',
    currentJob: {
      label: shortTask,
      step: 'Processing',
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
async function runWorkerTask({
  instruction,
  agent,
  shortTask,
  planning = false,
  rawTask = '',
  threadId = null,
  ownerKey = null,
}) {
  office.work(agent.id, 'Processing…', { label: shortTask, step: 'Processing', progress: 1, total: 2 });

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
          bubbleText: 'Processing…',
          currentJob: { label: shortTask, step: 'Processing', progress: 2, total: 2 },
        });
        return runAgentTask({
          agent,
          instruction: step.accountLabel ? `[${step.accountLabel}] ${step.instruction}` : step.instruction,
          system,
          mcpServers,
          threadId,
          ownerKey,
        });
      })();

  const { text, provider, needsBossInput: waitingOnBoss } = await taskP;
  return { text, provider, needsBossInput: waitingOnBoss };
}

async function directToAgent({ instruction, agent, shortTask, planning = false, rawTask = '', threadId = null, ownerKey = null }) {
  const { text, provider, needsBossInput: waitingOnBoss } = await runWorkerTask({
    instruction,
    agent,
    shortTask,
    planning,
    rawTask,
    threadId,
    ownerKey,
  });

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
  const ceo = orgRoles.ceoAgentOrFallback();
  const hired = findHiredAgentFor(dept);
  if (hired) {
    office.work(ceo.id, `Processing: ${shortTask}`, { label: shortTask, step: 'Processing', progress: 1, total: 2 });
    chat('ceo', `Assigning this to ${hired.label}.`, threadId);
    office.rest(ceo.id, '');
    await directToAgent({ instruction, agent: hired, shortTask, planning, rawTask, threadId });
    return;
  }

  await runAsCeo({ instruction, shortTask, planning, rawTask, threadId });
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

function secretaryMcpRuntime() {
  const { mcpHasCredentials } = require('./mcp-runtime-helper');
  const bindings = defaultMcpPack.getBuiltinRoleBindings('secretary');
  const { mcpServers: allMcp } = require('./mcp-runtime-helper').resolveMcpRuntimeFromBindings(
    bindings?.length ? bindings : defaultMcpPack.getBuiltinRoleBindings('coo'),
  );
  const mcpServers = (allMcp || []).filter(mcpHasCredentials);
  const unconfiguredMcpBlock = formatUnconfiguredMcpAskBlock(allMcp);
  return { mcpServers, unconfiguredMcpBlock };
}

async function runSecretaryFbLoginTurn({
  sec,
  secName,
  instruction,
  rawTask,
  threadId,
  ownerKey,
  planning,
}) {
  const text = rawTask || instruction;
  const accountKey = secretaryFbIntake.extractAccountKey(text);
  const fb = require('./fb-playwright-engine');

  office.work(sec.id, 'Opening Facebook…', {
    label: 'FB login',
    step: 'Browser',
    progress: 1,
    total: 2,
  });
  try {
    const open = await fb.openAccount(accountKey);
    if (open.alreadyOpen) {
      finalizeAgentTurn({
        agent: sec,
        text:
          open.message ||
          (open.onHome
            ? 'Chrome **已在 Facebook 首页**。请回复「**登好了**」完成群组抓取（不要加「吗」）。'
            : 'Chrome **已打开**。请完成登录、进到首页后回复「**登好了**」。'),
        provider: 'local',
        threadId,
        planning,
        needsBossInput: true,
      });
      return;
    }
    finalizeAgentTurn({
      agent: sec,
      text:
        open.message ||
        ('已为您打开 **Facebook**（Chrome 会保持打开，直到您回复「登好了」）。\n\n' +
          '请在 Chrome 窗口**自行输入账号和密码**（含 2FA）。\n\n' +
          '**进入 https://www.facebook.com/ 首页（Home）后**，请回复「登好了」。系统会抓取群组并回复成功或失败。'),
      provider: 'local',
      threadId,
      planning,
      needsBossInput: true,
    });
  } catch (e) {
    finalizeAgentTurn({
      agent: sec,
      text: `无法打开 Facebook：${e.message}\n\n请确认已运行 \`npx playwright install chrome\`（在 AntlerOffice2 目录）。`,
      provider: 'local',
      threadId,
      planning,
      needsBossInput: false,
    });
  }
}

async function runAsSecretary({
  instruction,
  shortTask,
  planning = false,
  rawTask = '',
  threadId = null,
  ownerKey = null,
}) {
  const sec = orgRoles.findSecretary() || { id: 'secretary', role: 'secretary', label: 'Secretary' };
  const ceo = orgRoles.findHiredCeo();
  const secName = sec.label || 'Secretary';
  const taskText = rawTask || instruction;

  if (!planning) {
    const itIntent = secretaryItIntake.classifyItMessage(taskText);
    if (itIntent) {
      const readiness = await secretaryItIntake.getItDevReadiness();
      if (itIntent === 'it_setup' || itIntent === 'it_status' || itIntent === 'it_setup_done') {
        office.work(sec.id, 'IT dev tools…', { label: shortTask, step: 'IT', progress: 1, total: 1 });
        finalizeAgentTurn({
          agent: sec,
          text: secretaryItIntake.buildSetupGuide(readiness),
          provider: 'local',
          threadId,
          planning,
          needsBossInput: !readiness.ready,
        });
        return;
      }
      if (itIntent === 'it_dev_request') {
        if (!readiness.ready) {
          office.work(sec.id, 'IT setup needed', { label: shortTask, step: 'IT', progress: 1, total: 2 });
          finalizeAgentTurn({
            agent: sec,
            text: secretaryItIntake.buildSetupRequiredReply(taskText, readiness),
            provider: 'local',
            threadId,
            planning,
            needsBossInput: true,
          });
          return;
        }
        if (ceo) {
          chat('secretary', '好的，IT Guys 已配置完成。我交给 CEO 安排开发任务。', threadId);
          office.rest(sec.id, '');
          const resumed = await tryResumeCeoPipeline({
            raw: rawTask || instruction,
            threadId,
            ownerKey,
            shortTask,
            planning,
          });
          if (!resumed?.handled) {
            await runAsCeo({ instruction, shortTask, planning, rawTask, threadId, ownerKey });
          }
          return;
        }
      }
    }
  }

  const fbIntent = planning ? null : secretaryFbIntake.classifySecretaryMessage(taskText);

  if (fbIntent === 'fb_list_accounts') {
    finalizeAgentTurn({
      agent: sec,
      text: secretaryFbIntake.buildFbAccountsListReply(),
      provider: 'local',
      threadId,
      planning,
      needsBossInput: false,
    });
    return;
  }

  if (fbIntent === 'fb_login_status') {
    const check = await require('./fb-playwright-engine').detectFacebookHome();
    const reply = secretaryFbIntake.buildLoginStatusReply(check, {
      hasOpenSession: require('./fb-playwright-engine').hasOpenSession(),
    });
    finalizeAgentTurn({
      agent: sec,
      text: reply,
      provider: 'local',
      threadId,
      planning,
      needsBossInput: true,
    });
    return;
  }

  if (fbIntent === 'fb_login') {
    await runSecretaryFbLoginTurn({
      sec,
      secName,
      instruction,
      rawTask: taskText,
      threadId,
      ownerKey,
      planning,
    });
    return;
  }

  if (fbIntent === 'fb_login_done') {
    office.work(sec.id, 'Confirming login…', { label: shortTask, step: 'Groups', progress: 2, total: 3 });
    const result = await require('./fb-playwright-engine').completeLoginFlow();
    finalizeAgentTurn({
      agent: sec,
      text: result.message,
      provider: 'local',
      threadId,
      planning,
      needsBossInput: true,
    });
    return;
  }

  if (fbIntent === 'fb_post') {
    const readiness = secretaryFbIntake.getFbPostingReadiness();
    if (!readiness.ready) {
      office.work(sec.id, 'Checking Facebook…', { label: shortTask, step: 'FB', progress: 1, total: 2 });
      finalizeAgentTurn({
        agent: sec,
        text: secretaryFbIntake.buildLoginRequiredReply(taskText, readiness),
        provider: 'local',
        threadId,
        planning,
        needsBossInput: true,
      });
      return;
    }

    if (ceo) {
      chat('secretary', '好的，我交给 CEO 安排 Marketing 发到群组。', threadId);
      office.rest(sec.id, '');
      const resumed = await tryResumeCeoPipeline({
        raw: rawTask || instruction,
        threadId,
        ownerKey,
        shortTask,
        planning,
      });
      if (!resumed?.handled) {
        await runAsCeo({ instruction, shortTask, planning, rawTask, threadId, ownerKey });
      }
      return;
    }
  }

  if (!ceo) {
    office.work(sec.id, 'Listening…', { label: shortTask, step: 'Reception', progress: 1, total: 2 });
    const fbHint = secretaryFbIntake.secretaryFbSystem(secName);
    const system =
      `You are ${secName}, the executive secretary and the boss's only front-door contact in AntlerOffice. ` +
      `Be warm, concise, and professional. Record what the boss asks for. ` +
      `There is no CEO hired yet — you cannot dispatch group posting to departments. ` +
      `For posting tasks (after FB login), explain they should hire a CEO from the Hire page first. ` +
      `Small talk and clarifying questions are fine.\n\n${fbHint}`;
    const { mcpServers, unconfiguredMcpBlock } = secretaryMcpRuntime();
    const { text, provider, needsBossInput: waitingOnBoss } = await runtime.runTask({
      agent: sec,
      instruction,
      system: `${system}${unconfiguredMcpBlock ? `\n\n${unconfiguredMcpBlock}` : ''}`,
      mcpServers,
      threadId,
      ownerKey,
    });
    finalizeAgentTurn({
      agent: sec,
      text,
      provider,
      threadId,
      planning,
      needsBossInput: waitingOnBoss,
    });
    return;
  }

  chat('secretary', "I'll pass this to the CEO.", threadId);
  office.rest(sec.id, '');

  const resumed = await tryResumeCeoPipeline({
    raw: rawTask || instruction,
    threadId,
    ownerKey,
    shortTask,
    planning,
  });
  if (resumed?.handled) return;

  await runAsCeo({ instruction, shortTask, planning, rawTask, threadId, ownerKey });
}

async function tryResumeCeoPipeline({ raw, threadId, ownerKey, shortTask, planning }) {
  if (planning) return null;
  const pending = ceoPipelinePending.get(threadId);
  if (!pending?.phase) return null;

  const outcome = workflowContext.parseReviewOutcome(raw);
  const ceo = orgRoles.ceoAgentOrFallback();

  if (pending.phase === 'plan_approval') {
    if (!outcome.approved && !outcome.needsRevision) {
      chat('ceo', 'Reply **APPROVED** to execute the plan, or **REVISION:** with your changes.', threadId);
      office.rest(ceo.id, 'Awaiting plan approval…');
      return { handled: true };
    }
    ceoPipelinePending.clear(threadId);
    if (outcome.needsRevision) {
      await runAsCeo({
        instruction: `${pending.instruction || raw}\n\nBoss revision:\n${raw}`,
        shortTask: pending.shortTask || shortTask,
        planning: false,
        rawTask: `${pending.rawTask || raw}\n\nRevision: ${raw}`,
        threadId,
        ownerKey,
      });
      return { handled: true };
    }
    await runAsCeo({
      instruction: pending.instruction || raw,
      shortTask: pending.shortTask || shortTask,
      planning: false,
      rawTask: pending.rawTask || raw,
      threadId,
      ownerKey,
      resumeFrom: 'execute',
      brief: pending.brief || '',
      plan: pending.plan || '',
    });
    return { handled: true };
  }

  if (pending.phase === 'push_approval') {
    if (!outcome.approved && !outcome.needsRevision) {
      chat(
        'ceo',
        'Codex approved the code. Reply **APPROVED** to push to GitHub, or **REVISION:** with changes for IT.',
        threadId,
      );
      office.rest(ceo.id, 'Awaiting push approval…');
      return { handled: true };
    }
    if (outcome.approved) {
      const push = await devPipeline.pushApprovedDev(threadId);
      chat('system', push.ok ? `✓ ${push.text}` : `Push failed: ${push.error}`, threadId, {
        authorName: 'Office',
      });
      ceoPipelinePending.clear(threadId);
      office.rest(ceo.id, push.ok ? 'Pushed ✓' : 'Push failed');
      return { handled: true };
    }
    ceoPipelinePending.patch(threadId, { phase: 'it_revision', revisionNote: raw });
    chat('ceo', 'Understood — IT will revise based on your feedback.', threadId);
    const agent = office.getAgent(pending.agentId) || office.state.agents.find((a) => a.role === 'it');
    if (agent) {
      await runItDevPipelineStep({
        hired: agent,
        instruction: `Boss revision after Codex approval:\n${raw}`,
        plan: pending.plan || '',
        brief: pending.brief || '',
        rawTask: pending.rawTask || raw,
        shortTask: pending.shortTask || shortTask,
        threadId,
        ownerKey,
      });
    }
    return { handled: true };
  }

  if (pending.phase === 'project_path') {
    const root = devPipeline.tryResolveProjectFromBossMessage(raw, threadId);
    if (!root) {
      chat('system', 'Could not resolve that path. Reply with a full path or list number.', threadId, {
        authorName: 'Office',
      });
      return { handled: true };
    }
    const agent = office.getAgent(pending.agentId) || office.state.agents.find((a) => a.role === 'it');
    if (!agent) {
      chat('system', 'IT worker not found — hire IT Guys and try again.', threadId, { authorName: 'Office' });
      ceoPipelinePending.clear(threadId);
      return { handled: true };
    }
    await runItDevPipelineStep({
      hired: agent,
      instruction: pending.instruction || raw,
      plan: pending.plan || '',
      brief: pending.brief || '',
      rawTask: pending.rawTask || raw,
      shortTask: pending.shortTask || shortTask,
      threadId,
      ownerKey,
      projectRoot: root,
    });
    return { handled: true };
  }

  return null;
}

async function runItDevPipelineStep({
  hired,
  instruction,
  plan,
  brief,
  rawTask,
  shortTask,
  threadId,
  ownerKey,
  projectRoot,
}) {
  office.work(hired.id, 'Dev pipeline…', {
    label: shortTask,
    step: 'Writer + reviewers',
    progress: 1,
    total: 3,
  });
  chat('ceo', `Execute · dev pipeline → ${hired.label}`, threadId);

  const result = await devPipeline.runDevPipeline({
    agent: hired,
    instruction,
    plan,
    brief,
    rawTask,
    threadId,
    projectRoot,
    onLog: (line) => chat('system', line, threadId, { authorName: 'IT' }),
  });

  chat(hired.role, result.text, threadId);
  office.rest(hired.id, result.needsBossInput ? 'Awaiting boss…' : result.ok ? 'Done ✓' : 'Failed');

  if (result.awaitingPushApproval) {
    ceoPipelinePending.patch(threadId, {
      phase: 'push_approval',
      plan,
      brief,
      rawTask,
      shortTask,
      agentId: hired.id,
      projectRoot: result.projectRoot,
      branchName: result.branchName,
    });
    chat(
      'ceo',
      `Dev finished on branch \`${result.branchName}\`. Review **APPROVED**.\n\nReply **APPROVED** to push to GitHub, or **REVISION:** for more changes.`,
      threadId,
    );
    office.rest(orgRoles.ceoAgentOrFallback().id, 'Awaiting push approval…');
  }

  return result;
}

const CEO_PHASES = [
  { skillId: 'ceo_brainstorm', label: 'Brainstorm' },
  { skillId: 'ceo_writing_plans', label: 'Plan' },
  { skillId: 'ceo_executing_plans', label: 'Execute' },
  { skillId: 'ceo_review', label: 'Review' },
];

function ensureCeoPhaseSkill(skillId) {
  const agentCatalog = require('./agent-catalog');
  return agentCatalog.ensureBundledSkill(skillId, 'ceo');
}

function ceoPhaseSystem(skillId, ceo, { notes, accountsBlock, unconfiguredMcpBlock }) {
  const sk =
    ensureCeoPhaseSkill(skillId) || registry.listSkills().find((s) => s.id === skillId);
  const name = ceo.label || 'CEO';
  let system = `You are ${name}, CEO of AntlerOffice.\n\n${sk?.system || ''}`;
  system += `\n\nShared office knowledge:\n${notes || '(none yet)'}`;
  if (accountsBlock) system += `\n\n${accountsBlock}`;
  if (unconfiguredMcpBlock) system += `\n\n${unconfiguredMcpBlock}`;
  return system;
}

function ceoMcpRuntime() {
  const { mcpServers: allMcp } = defaultMcpPack.resolveBuiltinMcpRuntimeSpec('ceo');
  const { mcpHasCredentials } = require('./mcp-runtime-helper');
  const mcpServers = (allMcp || []).filter(mcpHasCredentials);
  const unconfiguredMcpBlock = formatUnconfiguredMcpAskBlock(allMcp);
  return { mcpServers, unconfiguredMcpBlock };
}

async function runCeoPhaseTurn({
  ceo,
  skillId,
  phaseLabel,
  instruction,
  threadId,
  ownerKey,
  systemExtras = '',
}) {
  const notes = skills.readSharedNotes();
  const webAccounts = require('./web-accounts-store');
  const accountsBlock = webAccounts.formatAgentBlock();
  const { mcpServers, unconfiguredMcpBlock } = ceoMcpRuntime();
  const system = `${ceoPhaseSystem(skillId, ceo, { notes, accountsBlock, unconfiguredMcpBlock })}${
    systemExtras ? `\n\n${systemExtras}` : ''
  }`;

  const taskP = runAgentTask({
    agent: ceo,
    instruction,
    system,
    mcpServers,
    threadId,
    ownerKey,
  });
  await sleep(400);
  office.setAgent(ceo.id, {
    bubbleText: phaseLabel,
    currentJob: { label: phaseLabel, step: phaseLabel, progress: 2, total: 4 },
  });
  return taskP;
}

async function runCeoExecutePhase({
  ceo,
  instruction,
  brief,
  plan,
  shortTask,
  rawTask,
  threadId,
  ownerKey,
}) {
  const planParser = require('./ceo-plan-parser');
  const steps = planParser.parsePlanSteps(plan);

  if (!steps.length) {
    const routeText = `${instruction}\n\n${plan}`;
    const dept = roster.route(routeText);
    const hired = findHiredAgentFor(dept);

    if (hired) {
      chat('ceo', `Execute · delegating to ${hired.label}.`, threadId);
      const workerInstruction =
        `## CEO brief\n${brief}\n\n## Plan\n${plan}\n\n## Your assignment\n` +
        `Execute the parts of this plan that match your role (${hired.label}).\n\n` +
        `Original ask: ${rawTask || instruction}`;

      if (hired.role === 'it') {
        const result = await runItDevPipelineStep({
          hired,
          instruction: workerInstruction,
          plan,
          brief,
          rawTask,
          shortTask,
          threadId,
          ownerKey,
        });
        return {
          text: result.text || '',
          provider: result.provider || 'dev-pipeline',
          needsBossInput: !!result.needsBossInput,
        };
      }

      const { text, provider, needsBossInput: stepBoss } = await runWorkerTask({
        instruction: workerInstruction,
        agent: hired,
        shortTask,
        rawTask,
        threadId,
        ownerKey,
      });
      chat(hired.role, text, threadId);
      office.rest(hired.id, stepBoss ? 'Waiting…' : 'Done ✓');
      return {
        text: `## Delegated to ${hired.label}\n\n${text}`,
        provider,
        needsBossInput: stepBoss,
      };
    }

    return runCeoPhaseTurn({
      ceo,
      skillId: 'ceo_executing_plans',
      phaseLabel: 'Execute',
      instruction:
        `Original request:\n${rawTask || instruction}\n\n## Brainstorm\n${brief}\n\n## Plan\n${plan}\n\n` +
        'No matching department worker is hired. List HIRE: <template_id> gaps — CEO does not execute worker tasks.',
      threadId,
      ownerKey,
    });
  }

  const workflow = require('./workflow-context');
  const delegated = [];
  const blocked = [];
  let priorOutputs = '';
  let lastProvider = 'demo';
  let needsBossInput = false;

  function managerHandoff(fromAgent, toRoleLabel, note) {
    chat(fromAgent.role, `→ ${toRoleLabel}: ${note}`, threadId, { handoff: true, toRole: toRoleLabel });
  }

  async function delegateStep(step, hired, extra = '') {
    const downgradeNote = extra || '';
    chat('ceo', `Execute · step → ${hired.label}${downgradeNote}`, threadId);

    if (hired.role === 'it' && !planning) {
      const workerInstruction =
        `## CEO brief\n${brief}\n\n## Plan\n${plan}\n\n## This step\n${step.instruction}\n\n` +
        `Original ask: ${rawTask || instruction}`;
      const result = await runItDevPipelineStep({
        hired,
        instruction: workerInstruction,
        plan,
        brief,
        rawTask,
        shortTask,
        threadId,
        ownerKey,
      });
      const text = result.text || '';
      delegated.push({ step, agent: hired.label, text });
      priorOutputs += `\n### ${step.roleLabel || hired.label}\n${text}\n`;
      if (result.needsBossInput) needsBossInput = true;
      return text;
    }

    const artifactBlock = workflow.artifactsBlock(threadId, hired.role);
    let workerInstruction =
      `## CEO brief\n${brief}\n\n## Plan\n${plan}\n\n## This step\n${step.instruction}\n\n` +
      (artifactBlock ? `## Workflow context\n${artifactBlock}\n\n` : '') +
      (priorOutputs ? `## Prior step outputs\n${priorOutputs}\n\n` : '') +
      `## Your assignment\nComplete only this step as ${hired.label}.\n\n` +
      `Original ask: ${rawTask || instruction}`;

    if (step.kind === 'review') {
      workerInstruction +=
        '\n\n**Review output:** Reply with `APPROVED` or `REVISION` and specific feedback for the worker.';
    }

    const { text, provider, needsBossInput: stepBoss } = await runWorkerTask({
      instruction: workerInstruction,
      agent: hired,
      shortTask,
      rawTask,
      threadId,
      ownerKey,
    });
    lastProvider = provider || lastProvider;
    if (stepBoss) needsBossInput = true;

    chat(hired.role, text, threadId);
    office.rest(hired.id, stepBoss ? 'Waiting…' : 'Done ✓');
    workflow.storeArtifact(threadId, hired.role, text);

    if (hired.role === 'marketing') {
      const ctx = workflow.getWorkflowContext(threadId);
      const copyDir = workflow.extractCopyDirection(text);
      if (copyDir) ctx.artifacts.copyDirection = copyDir;
      const designBrief = workflow.extractDesignBrief(text);
      if (designBrief) ctx.artifacts.designBrief = designBrief;
      if (/editor|copy/i.test(step.instruction)) {
        managerHandoff(hired, 'Marketing Editor', 'Copy direction / review notes ready.');
      }
      if (/design|visual/i.test(step.instruction)) {
        managerHandoff(hired, 'Graphic Design', 'Visual brief / design review ready.');
      }
    }

    delegated.push({ step, agent: hired.label, text });
    priorOutputs += `\n### ${step.roleLabel || hired.label}\n${text}\n`;
    return text;
  }

  for (const step of steps) {
    const resolved = planParser.resolveStepAgent(step, { office, roster, findHiredAgentFor });

    if (!resolved.agent) {
      blocked.push({ step, reason: resolved.reason, hireTemplate: resolved.hireTemplate });
      chat('ceo', resolved.message || `Blocked: ${step.raw}`, threadId);
      if (resolved.reason === 'boss') needsBossInput = true;
      continue;
    }

    const hired = resolved.agent;
    const downgradeNote = resolved.downgraded
      ? ` (Manager not hired — downgraded to ${hired.label})`
      : '';
    const text = await delegateStep(step, hired, downgradeNote);

    if (step.kind === 'review') {
      const outcome = workflow.parseReviewOutcome(text);
      const revRole = step.revisionRole;
      if (outcome.needsRevision && revRole && workflow.getRevisionCount(threadId, revRole) < 2) {
        const revStep = {
          role: revRole,
          roleLabel: revRole,
          instruction: `Revise based on manager feedback.\n\n${text}`,
          kind: 'execute',
        };
        const revResolved = planParser.resolveStepAgent(revStep, { office, roster, findHiredAgentFor });
        if (revResolved.agent) {
          workflow.bumpRevisionCount(threadId, revRole);
          chat('ceo', `REVISION loop → ${revResolved.agent.label}`, threadId);
          await delegateStep(revStep, revResolved.agent, ' (revision)');
        } else {
          blocked.push({
            step: revStep,
            reason: 'hire',
            hireTemplate: planParser.HIRE_TEMPLATE_BY_ROLE[revRole] || revRole,
          });
          chat('ceo', `REVISION blocked — hire ${revRole} for revision loop.`, threadId);
        }
      }
    }
  }

  const lines = ['## Execution summary', `Steps parsed: ${steps.length}`];
  if (delegated.length) {
    lines.push('', '## Delegated');
    for (const d of delegated) {
      lines.push(`- **${d.agent}**: ${d.step.instruction}`);
    }
  }
  if (blocked.length) {
    lines.push('', '## Blocked / needs hire');
    for (const b of blocked) {
      const tag = b.reason === 'boss' ? 'BOSS' : `HIRE: ${b.hireTemplate || b.step.role}`;
      lines.push(`- ${tag} — ${b.step.instruction}`);
    }
  }
  if (delegated.length === 1) {
    lines.push('', '## Output', '', delegated[0].text);
  } else if (delegated.length > 1) {
    lines.push('', '## Outputs');
    for (const d of delegated) {
      lines.push(`\n### ${d.agent}\n${d.text}`);
    }
  }

  return { text: lines.join('\n'), provider: lastProvider, needsBossInput };
}

// Hired CEO runs the company pipeline (brainstorm → plan → execute → review) and delegates to workers.
async function runAsCeo({
  instruction,
  shortTask,
  planning = false,
  rawTask = '',
  threadId = null,
  ownerKey = null,
  resumeFrom = null,
  brief: briefIn = '',
  plan: planIn = '',
} = {}) {
  const ceo = orgRoles.ceoAgentOrFallback();
  const ceoName = ceo.label || 'CEO';
  let phaseList = planning ? CEO_PHASES.slice(0, 2) : CEO_PHASES;
  if (resumeFrom === 'execute') {
    phaseList = CEO_PHASES.filter((p) => p.skillId === 'ceo_executing_plans' || p.skillId === 'ceo_review');
  }
  office.work(ceo.id, 'Brainstorm…', { label: shortTask, step: 'Brainstorm', progress: 1, total: phaseList.length });

  let brief = briefIn || '';
  let plan = planIn || '';
  let execution = '';
  let lastProvider = 'demo';
  let waitingOnBoss = false;

  for (let i = 0; i < phaseList.length; i++) {
    const { skillId, label } = phaseList[i];
    office.work(ceo.id, `${label}…`, {
      label: shortTask,
      step: label,
      progress: i + 1,
      total: phaseList.length,
    });
    chat('system', `${ceoName} · ${label}`, threadId, { authorName: 'Office' });

    if (skillId === 'ceo_executing_plans') {
      const result = await runCeoExecutePhase({
        ceo,
        instruction,
        brief,
        plan,
        shortTask,
        rawTask,
        threadId,
        ownerKey,
      });
      execution = result.text;
      lastProvider = result.provider || lastProvider;
      waitingOnBoss = result.needsBossInput;
      if (waitingOnBoss) break;
      continue;
    }

    let phaseInstruction = rawTask || instruction;
    let extras = '';
    if (skillId === 'ceo_writing_plans') {
      extras = `## Brainstorm output\n${brief}`;
    }
    if (skillId === 'ceo_review') {
      const pushPending = ceoPipelinePending.get(threadId);
      extras =
        `## Brainstorm\n${brief}\n\n## Plan\n${plan}\n\n## Execution\n${execution}` +
        (pushPending?.phase === 'push_approval'
          ? `\n\n## Dev push gate\nCodex approved IT changes on branch \`${pushPending.branchName}\`. ` +
            `Ask the boss to reply APPROVED to push to GitHub, or REVISION for more IT work. Do NOT re-review code quality.`
          : '');
      phaseInstruction =
        `Summarize outcomes for the boss. If IT dev completed with Codex approval, ask boss APPROVED to push GitHub.\n\nOriginal request:\n${rawTask || instruction}`;
    }

    const { text, provider, needsBossInput } = await runCeoPhaseTurn({
      ceo,
      skillId,
      phaseLabel: label,
      instruction: phaseInstruction,
      threadId,
      ownerKey,
      systemExtras: extras,
    });
    lastProvider = provider || lastProvider;
    waitingOnBoss = needsBossInput;

    if (skillId === 'ceo_brainstorm') brief = text;
    if (skillId === 'ceo_writing_plans') {
      plan = text;
      if (!planning) {
        ceoPipelinePending.set(threadId, {
          phase: 'plan_approval',
          brief,
          plan,
          instruction,
          shortTask,
          rawTask,
          threadId,
          ownerKey,
        });
        chat(
          'ceo',
          `## Plan\n\n${plan}\n\n---\n**Boss:** Reply **APPROVED** to delegate to department workers, or **REVISION:** with changes.`,
          threadId,
        );
        office.rest(ceo.id, 'Awaiting plan approval…');
        return;
      }
    }
    if (skillId === 'ceo_review') {
      finalizeAgentTurn({
        agent: ceo,
        text,
        provider: lastProvider,
        threadId,
        planning: false,
        needsBossInput: waitingOnBoss,
      });
      return;
    }

    if (waitingOnBoss) break;
  }

  const finalText = planning ? plan : execution || plan || brief;
  if (planning && plan) {
    const file = saveDeliverable('ceo', rawTask || instruction, plan);
    recordDeliverable(ceo, rawTask || instruction, file, { kind: 'plan_complete' });
  }

  finalizeAgentTurn({
    agent: ceo,
    text: finalText,
    provider: lastProvider,
    threadId,
    planning,
    needsBossInput: waitingOnBoss,
  });
}

/** @deprecated use runAsCeo */
async function runAsCoo(opts) {
  return runAsCeo(opts);
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

function savePlanDeliverable({ agentIdOrRole = 'ceo', task, result }) {
  const agent = office.getAgent(agentIdOrRole) || office.getAgent('ceo');
  const skillId = agent?.role || 'ceo';
  const file = saveDeliverable(skillId, task, result);
  if (agent) recordDeliverable(agent, task, file, { kind: 'plan_complete' });
  return file;
}

async function runStandupAgentTurn({ agent, instruction, ownerKey, threadId }) {
  office.work(agent.id, 'Standup report…', {
    label: 'Department standup',
    step: 'Writing',
    progress: 1,
    total: 2,
  });

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
    ? mcpTasklist.assignTasklistAccounts(instruction, mcpBindings, registry)
    : [{ instruction, mcpId: null, accountId: null, accountLabel: null }];
  const useTasklist =
    regAgent &&
    mcpTasklist.hasMultiAccountBindings(mcpBindings, registry) &&
    steps.length > 1;

  await sleep(400);
  office.setAgent(agent.id, {
    bubbleText: 'Drafting report…',
    currentJob: { label: 'Standup', step: 'Producing', progress: 2, total: 2 },
  });

  let text;
  let provider;
  if (useTasklist) {
    const out = await runTaskSteps({
      agent,
      steps,
      baseSystem,
      mcpServers,
      shortTask: 'Standup',
      planning: false,
      rawTask: instruction,
    });
    text = out.text;
    provider = out.provider;
  } else {
    const step = steps[0];
    const mcpBlock = mcpContextForStep(step, mcpServers);
    const system = [baseSystem, mcpBlock].filter(Boolean).join('\n\n');
    const out = await runAgentTask({
      agent,
      instruction: step.accountLabel ? `[${step.accountLabel}] ${step.instruction}` : step.instruction,
      system,
      mcpServers,
      threadId,
      ownerKey,
    });
    text = out.text;
    provider = out.provider;
  }

  office.rest(agent.id, '');
  return { text, provider };
}

async function runStandupCeoSummary({ instruction, ownerKey, threadId }) {
  const ceo = orgRoles.ceoAgentOrFallback();
  const ceoName = ceo.label || 'CEO';
  office.work(ceo.id, 'Summarizing standup…', {
    label: 'CEO summary',
    step: 'Gateway',
    progress: 1,
    total: 2,
  });

  const notes = skills.readSharedNotes();
  const system =
    `You are ${ceoName}, the CEO inside AntlerOffice. Summarize department standup reports clearly for the boss. ` +
    `Focus on decisions needed, risks, and priorities.\n\nShared office knowledge:\n${notes || '(none yet)'}`;

  const { mcpServers: allMcp } = defaultMcpPack.resolveBuiltinMcpRuntimeSpec('ceo');
  const { mcpHasCredentials } = require('./mcp-runtime-helper');
  const mcpServers = (allMcp || []).filter(mcpHasCredentials);

  await sleep(300);
  office.setAgent(ceo.id, {
    bubbleText: 'Writing summary…',
    currentJob: { label: 'CEO summary', step: 'Tools', progress: 2, total: 2 },
  });

  const { text, provider } = await runAgentTask({
    agent: ceo,
    instruction,
    system,
    mcpServers,
    threadId,
    ownerKey,
  });

  office.rest(ceo.id, '');
  return { text, provider };
}

/** @deprecated */
async function runStandupCooSummary(opts) {
  return runStandupCeoSummary(opts);
}

module.exports = {
  handleInstruction,
  savePlanDeliverable,
  runStandupAgentTurn,
  runStandupCeoSummary,
  runStandupCooSummary,
};
