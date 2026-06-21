// SSE broadcast for office chat / snapshot updates (Plan 4b + Boss Chat realtime).

const clients = new Set();

function subscribe(res, filters = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const client = {
    res,
    agentId: filters.agentId ? String(filters.agentId) : null,
    threadId: filters.threadId ? String(filters.threadId) : null,
  };

  clients.add(client);
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const ping = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {}\n\n`);
    } catch {
      clearInterval(ping);
    }
  }, 25000);

  res.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

function matches(client, payload) {
  if (payload.threadId && client.threadId && client.threadId !== payload.threadId) return false;
  if (payload.agentId && client.agentId && client.agentId !== payload.agentId) return false;
  return true;
}

function emit(event, payload = {}) {
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    if (!matches(client, payload)) continue;
    try {
      client.res.write(line);
    } catch {
      clients.delete(client);
    }
  }
}

function notifyChatUpdate({ threadId, agentId } = {}) {
  emit('chat', { threadId: threadId || null, agentId: agentId || null, at: Date.now() });
}

function notifyOfficeUpdate(payload = {}) {
  emit('office', { ...payload, at: Date.now() });
}

function notifyCeoDecision(payload = {}) {
  emit('ceoDecision', { ...payload, at: Date.now() });
  notifyChatUpdate({ threadId: payload.threadId || null });
  notifyOfficeUpdate({ kind: 'ceoDecision', threadId: payload.threadId || null });
}

module.exports = {
  subscribe,
  emit,
  notifyChatUpdate,
  notifyOfficeUpdate,
  notifyCeoDecision,
};
