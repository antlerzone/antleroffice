// Pixel-Agents office bridge.
//
// Serves the real pixel-agents webview (vendored under web/office-pa) by speaking
// its WebSocket ServerMessage protocol, and mirrors our in-memory office-state
// (department NPCs, working/resting) into that office so the genuine characters
// walk to their desks, type while working, and sit idle when resting.
//
// Protocol reference: pixel-agents core/asyncapi.yaml. We emit only the subset the
// webview needs to render and animate agents — no Claude hooks involved.

const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const office = require('./office-state');
const officeShare = require('./office-share');
const officeMemberAuth = require('./office-member-auth');

const ASSETS_FILE = path.join(__dirname, 'pa-assets.generated.json');

let assets = null;
function loadAssets() {
  if (assets) return assets;
  try {
    assets = JSON.parse(fs.readFileSync(ASSETS_FILE, 'utf-8'));
  } catch (e) {
    console.error('[pa-bridge] failed to load assets:', e.message);
    assets = {};
  }
  return assets;
}

// ── String agent id <-> numeric pixel-agents id ────────────────────────────
const idMap = new Map(); // office agent id (string) -> numeric id
let nextNum = 1;
function numFor(stringId) {
  let n = idMap.get(stringId);
  if (n === undefined) {
    n = nextNum++;
    idMap.set(stringId, n);
  }
  return n;
}

// Track last broadcast state per agent for diffing.
const lastSeen = new Map(); // stringId -> { npcState, bubbleText, num }
const toolIds = new Map(); // stringId -> current toolId

const clients = new Set();
/** @type {Map<WebSocket, { id: string, name: string, role: string, connectedAt: number }>} */
const viewerMeta = new Map();
let lastSelection = { agentId: null, by: null, at: 0 };

function getOfficePresence() {
  return {
    viewers: [...viewerMeta.values()].map((v) => ({
      id: v.id,
      name: v.name,
      role: v.role,
      connectedAt: v.connectedAt,
    })),
    selection: lastSelection,
    viewerCount: viewerMeta.size,
  };
}

function broadcastOfficeMeta() {
  broadcast({
    type: 'officePresence',
    viewers: getOfficePresence().viewers,
    selection: lastSelection,
  });
}

function proxyWsToHost(req, socket, head, share) {
  const target = share.hostUrl.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws';
  const wss = new WebSocketServer({ noServer: true });

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const headers = share.memberToken ? { 'X-Office-Member-Token': share.memberToken } : {};
    const upstream = new WebSocket(target, { headers });

    const closeBoth = () => {
      try {
        clientWs.close();
      } catch {
        /* ignore */
      }
      try {
        upstream.close();
      } catch {
        /* ignore */
      }
    };

    upstream.on('open', () => {
      clientWs.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
      upstream.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
      });
    });
    upstream.on('close', closeBoth);
    upstream.on('error', closeBoth);
    clientWs.on('close', () => upstream.close());
    clientWs.on('error', closeBoth);
  });
}

function attachClient(ws, viewer) {
  clients.add(ws);
  viewerMeta.set(ws, {
    id: viewer.id,
    name: viewer.name,
    role: viewer.role,
    connectedAt: Date.now(),
  });
  broadcastOfficeMeta();
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  for (const ws of clients) send(ws, msg);
}

// Messages that bring a freshly-connected webview fully up to date.
function sendInitialState(ws) {
  const a = loadAssets();

  send(ws, {
    type: 'providerCapabilities',
    readingTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
    subagentToolNames: ['Task', 'Agent'],
  });

  // Asset load order matters: characters → floors → walls → furniture, so the
  // dynamic furniture catalog is ready before the layout references it.
  if (a.characterSpritesLoaded) send(ws, a.characterSpritesLoaded);
  if (a.floorTilesLoaded) send(ws, a.floorTilesLoaded);
  if (a.wallTilesLoaded) send(ws, a.wallTilesLoaded);
  if (a.furnitureAssetsLoaded) send(ws, a.furnitureAssetsLoaded);

  // existingAgents MUST arrive before layoutLoaded: the webview buffers these
  // agents and only instantiates the characters when layoutLoaded flushes them.
  const snap = office.snapshot();
  const ids = [];
  const agentMeta = {};
  const folderNames = {};
  for (const ag of snap.agents) {
    const n = numFor(ag.id);
    ids.push(n);
    agentMeta[n] = { palette: ag.charSprite || 0, hueShift: ag.hueShift || 0 };
    folderNames[n] = ag.label || ag.role;
  }
  send(ws, {
    type: 'existingAgents',
    agents: ids,
    agentMeta,
    folderNames,
    externalAgents: {},
  });

  // layoutLoaded flushes the buffered agents into the office.
  send(ws, a.layoutLoaded || { type: 'layoutLoaded', layout: null });

  send(ws, {
    type: 'settingsLoaded',
    soundEnabled: false,
    lastSeenVersion: '1.3.0',
    extensionVersion: 'AntlerOffice',
    watchAllSessions: false,
    alwaysShowLabels: true,
    hooksEnabled: false,
    hooksInfoShown: true,
    externalAssetDirectories: [],
  });

  // Per-agent current activity (after layoutLoaded so characters exist).
  for (const ag of snap.agents) {
    const n = numFor(ag.id);
    emitAgentActivity(ag, n, (m) => send(ws, m));
  }

  send(ws, {
    type: 'officePresence',
    viewers: getOfficePresence().viewers,
    selection: lastSelection,
  });
}

// Translate one office agent's state into the pixel protocol.
function emitAgentActivity(ag, num, sink) {
  if (ag.npcState === 'working') {
    const toolId = toolIds.get(ag.id) || `t-${num}-${Date.now()}`;
    toolIds.set(ag.id, toolId);
    sink({
      type: 'agentToolStart',
      id: num,
      toolId,
      status: ag.bubbleText || `${ag.label} working…`,
      toolName: 'Edit',
    });
    sink({ type: 'agentStatus', id: num, status: 'active' });
  } else {
    sink({ type: 'agentToolsClear', id: num });
    // 'idle' is not 'active' nor 'waiting': character sits calmly at its desk.
    sink({ type: 'agentStatus', id: num, status: 'idle' });
    toolIds.delete(ag.id);
  }
}

// Poll the office snapshot and broadcast deltas to all connected webviews.
function pollAndBroadcast() {
  const snap = office.snapshot();
  const present = new Set();

  for (const ag of snap.agents) {
    present.add(ag.id);
    const prev = lastSeen.get(ag.id);
    const num = numFor(ag.id);

    if (!prev) {
      // New agent appeared at runtime (e.g. IT spawned a temp worker).
      broadcast({ type: 'agentCreated', id: num, folderName: ag.label || ag.role });
      emitAgentActivity(ag, num, broadcast);
      lastSeen.set(ag.id, { npcState: ag.npcState, bubbleText: ag.bubbleText, num });
      continue;
    }

    if (prev.npcState !== ag.npcState || prev.bubbleText !== ag.bubbleText) {
      // For a fresh tool label while working, rotate the toolId so the bubble updates.
      if (ag.npcState === 'working' && prev.npcState === 'working') {
        toolIds.set(ag.id, `t-${num}-${Date.now()}`);
      }
      emitAgentActivity(ag, num, broadcast);
      lastSeen.set(ag.id, { npcState: ag.npcState, bubbleText: ag.bubbleText, num });
    }
  }

  // Removed agents.
  for (const [stringId, prev] of lastSeen) {
    if (!present.has(stringId)) {
      broadcast({ type: 'agentClosed', id: prev.num });
      lastSeen.delete(stringId);
      toolIds.delete(stringId);
      idMap.delete(stringId);
    }
  }
}

let pollTimer = null;

function onClientMessage(ws, msg) {
  if (msg && msg.type === 'webviewReady') sendInitialState(ws);
  else if (msg && msg.type === 'focusAgent') {
    const viewer = viewerMeta.get(ws);
    for (const [stringId, num] of idMap) {
      if (num === msg.id) {
        office.setSelected(stringId);
        lastSelection = {
          agentId: stringId,
          by: viewer?.name || 'Viewer',
          at: Date.now(),
        };
        broadcastOfficeMeta();
        break;
      }
    }
  }
}

function detachClient(ws) {
  clients.delete(ws);
  viewerMeta.delete(ws);
  broadcastOfficeMeta();
}

function attachPaBridge(httpServer) {
  loadAssets();
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      /* ignore */
    }
    if (pathname !== '/ws') return;

    const share = officeShare.getShareInfo();
    if (share.enabled && share.role === 'member' && share.hostUrl) {
      proxyWsToHost(req, socket, head, share);
      return;
    }

    void (async () => {
      const memberToken = req.headers['x-office-member-token'];
      let viewer = { id: 'host-local', name: 'Host', role: 'owner' };

      if (memberToken) {
        if (!share.enabled || !share.officeId) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        const verified = await officeMemberAuth.verifyMemberWithEcs(share.officeId, memberToken);
        if (!verified.ok) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        viewer = {
          id: `member-${verified.userId || memberToken.slice(0, 8)}`,
          name: verified.name || 'Member',
          role: verified.role || 'member',
        };
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        attachClient(ws, viewer);
        ws.on('message', (data) => {
          let msg;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          onClientMessage(ws, msg);
        });
        ws.on('close', () => detachClient(ws));
        ws.on('error', () => detachClient(ws));
      });
    })().catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  });

  if (!pollTimer) pollTimer = setInterval(pollAndBroadcast, 500);
  return wss;
}

function refreshOfficeBroadcast() {
  pollAndBroadcast();
}

module.exports = { attachPaBridge, getOfficePresence, refreshOfficeBroadcast };
