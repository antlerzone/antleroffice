// Gateway → Pixel Office bridge.
// Listens to OpenClaw Gateway SSE/WS events and mirrors agent activity into
// office-state so pa-bridge can animate NPCs in real time (typing, tools, etc.).

const office = require('./office-state');
const debugLog = require('./debug-log');

/** @type {Map<string, number>} openclawAgentId → active run count */
const activeRuns = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} office agent id → idle timer */
const idleTimers = new Map();

function asRecord(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function asString(v) {
  return v == null ? '' : String(v).trim();
}

function extractSessionKey(payload) {
  const row = asRecord(payload);
  if (!row) return '';
  return asString(row.sessionKey || row.session);
}

function extractOpenClawAgentId(payload) {
  const row = asRecord(payload);
  if (!row) return 'main';

  const key = extractSessionKey(row);
  if (key) {
    const m = key.match(/^agent:([^:]+):/);
    if (m?.[1]) return m[1];
  }

  if (row.agentId) return asString(row.agentId) || 'main';
  const data = asRecord(row.data) || asRecord(row.payload);
  if (data?.agentId) return asString(data.agentId) || 'main';
  return 'main';
}

function resolveOfficeAgent(openclawId) {
  const id = asString(openclawId) || 'main';
  const agents = office.state.agents;

  let hit = agents.find((a) => a.openclawAgentId === id);
  if (!hit && (id === 'main' || id === 'default')) {
    hit = office.getAgent('coo');
  }
  if (!hit) {
    hit = agents.find((a) => !a.external && (a.id === `user:${id}` || a.id === id));
  }
  return hit || null;
}

function triggerOfficeRefresh() {
  try {
    require('./pa-bridge').refreshOfficeBroadcast();
  } catch {
    /* pa-bridge not loaded yet */
  }
}

function clearIdleTimer(officeAgentId) {
  const t = idleTimers.get(officeAgentId);
  if (t) clearTimeout(t);
  idleTimers.delete(officeAgentId);
}

function bumpRun(openclawId) {
  activeRuns.set(openclawId, (activeRuns.get(openclawId) || 0) + 1);
}

function endRun(openclawId) {
  const n = (activeRuns.get(openclawId) || 0) - 1;
  if (n <= 0) activeRuns.delete(openclawId);
  else activeRuns.set(openclawId, n);
}

function scheduleIdle(officeAgent, delayMs = 2200) {
  clearIdleTimer(officeAgent.id);
  idleTimers.set(
    officeAgent.id,
    setTimeout(() => {
      idleTimers.delete(officeAgent.id);
      if ((activeRuns.get(officeAgent.openclawAgentId || 'main') || 0) > 0) return;
      office.rest(officeAgent.id, '');
      triggerOfficeRefresh();
    }, delayMs),
  );
}

function setWorking(officeAgent, bubbleText, step) {
  clearIdleTimer(officeAgent.id);
  office.work(officeAgent.id, bubbleText || 'Working…', step
    ? { label: step, step, progress: 1, total: 2 }
    : null);
  triggerOfficeRefresh();
}

function resolveChatState(eventName, row) {
  const ev = eventName.toLowerCase();
  if (ev.includes('delta')) return 'delta';
  return asString(row?.state || row?.phase || row?.type).toLowerCase();
}

function handleGatewayEvent(event, payload) {
  const ev = asString(event).toLowerCase();
  if (!ev) return;

  const openclawId = extractOpenClawAgentId(payload);
  const officeAgent = resolveOfficeAgent(openclawId);
  if (!officeAgent || officeAgent.external) return;

  const row = asRecord(payload) || {};
  const data = asRecord(row.data) || {};

  if (ev === 'agent' || ev.startsWith('agent.')) {
    if (ev === 'agent') {
      const stream = asString(row.stream).toLowerCase();

      if (stream === 'lifecycle') {
        const phase = asString(data.phase).toLowerCase();
        if (phase === 'start') {
          bumpRun(openclawId);
          setWorking(officeAgent, 'Thinking…', 'Thinking');
          return;
        }
        if (phase === 'end' || phase === 'error') {
          endRun(openclawId);
          if (!activeRuns.has(openclawId)) scheduleIdle(officeAgent);
          return;
        }
      }

      if (stream === 'tool') {
        const toolName = asString(data.name || data.tool || data.toolName);
        const phase = asString(data.phase || data.state).toLowerCase();
        if (phase === 'start' || phase === 'update') {
          bumpRun(openclawId);
          setWorking(officeAgent, toolName ? `Using ${toolName}…` : 'Using tool…', toolName || 'Tool');
          return;
        }
        if (phase === 'result') {
          setWorking(officeAgent, toolName ? `${toolName} done` : 'Tool done', 'Thinking');
          return;
        }
      }

      if (stream === 'assistant') {
        bumpRun(openclawId);
        const raw = asString(data.content || data.text || data.delta);
        const preview = raw.length > 52 ? `${raw.slice(0, 52)}…` : raw;
        setWorking(officeAgent, preview || 'Replying…', 'Replying');
        return;
      }

      if (stream === 'compaction') {
        const phase = asString(data.phase).toLowerCase();
        if (phase === 'start') {
          setWorking(officeAgent, 'Organizing context…', 'Context');
        }
        return;
      }

      return;
    }

    if (ev === 'agent.started' || ev === 'agent.thinking') {
      bumpRun(openclawId);
      setWorking(officeAgent, 'Thinking…', 'Thinking');
      return;
    }
    if (ev === 'agent.done') {
      endRun(openclawId);
      scheduleIdle(officeAgent);
    }
    return;
  }

  if (ev === 'chat' || ev.startsWith('chat.')) {
    const state = resolveChatState(ev, row);
    if (state === 'delta') {
      bumpRun(openclawId);
      setWorking(officeAgent, 'Replying…', 'Replying');
      return;
    }
    if (state === 'final' || state === 'done' || state === 'aborted' || state === 'error') {
      endRun(openclawId);
      scheduleIdle(officeAgent);
    }
    return;
  }

  if (ev.startsWith('tool.')) {
    if (ev === 'tool.call') {
      bumpRun(openclawId);
      const d = asRecord(row.payload) || row;
      const toolName = asString(d.name || d.tool || d.toolName);
      setWorking(officeAgent, toolName ? `Using ${toolName}…` : 'Using tool…', toolName || 'Tool');
      return;
    }
    if (ev === 'tool.result') {
      setWorking(officeAgent, 'Thinking…', 'Thinking');
    }
    return;
  }

  if (ev === 'model.streaming') {
    bumpRun(openclawId);
    setWorking(officeAgent, 'Replying…', 'Replying');
  }
}

function attachGateway(gateway) {
  if (!gateway || typeof gateway.on !== 'function') return () => {};

  const handler = (event, payload) => {
    try {
      handleGatewayEvent(event, payload);
    } catch (e) {
      debugLog.logWarn('gateway→office', e.message);
    }
  };

  gateway.on('event', handler);
  return () => gateway.off('event', handler);
}

module.exports = {
  attachGateway,
  handleGatewayEvent,
  resolveOfficeAgent,
  extractOpenClawAgentId,
};
