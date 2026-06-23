'use strict';

const https = require('https');

const OPENAI_HOST = 'api.openai.com';
const OPENAI_SESSION_PATH = '/v1/realtime/client_secrets';
const OPENAI_DEFAULT_MODEL = 'gpt-4o-realtime-preview-2024-12-17';

function httpsPost(host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: host, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); }
        catch { resolve({ status: res.statusCode, body: data, raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('OpenAI session request timed out')));
    req.write(bodyStr);
    req.end();
  });
}

async function createOpenAISession({ apiKey, model, voice, useAudioOut, systemPrompt }) {
  const sessionModel = model || OPENAI_DEFAULT_MODEL;
  const sessionConfig = { type: 'realtime', model: sessionModel };
  if (useAudioOut && voice) sessionConfig.voice = voice;
  if (systemPrompt && systemPrompt.trim()) sessionConfig.instructions = systemPrompt.trim();
  const requestBody = { session: sessionConfig };
  console.log('[voice-realtime] POST', OPENAI_SESSION_PATH, JSON.stringify(requestBody));
  const { status, body: json, raw } = await httpsPost(
    OPENAI_HOST, OPENAI_SESSION_PATH, { Authorization: 'Bearer ' + apiKey }, requestBody,
  );
  console.log('[voice-realtime] status:', status, raw && raw.slice(0, 200));
  if (status !== 200) {
    const msg = (typeof json === 'object' && json && json.error && json.error.message)
      ? json.error.message : 'OpenAI Realtime session failed (HTTP ' + status + ')';
    throw new Error(msg);
  }
  const ephemeralKey = json && json.value;
  if (!ephemeralKey) throw new Error('OpenAI did not return an ephemeral key');
  console.log('[voice-realtime] ephemeral key obtained, model:', sessionModel);
  return { value: ephemeralKey, model: sessionModel };
}

async function createDoubaoSession() {
  throw new Error('Doubao Realtime not yet implemented.');
}

function httpsGet(host, path, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname: host, path, method: 'GET', headers };
    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function buildOfficeContext() {
  const lines = [];
  try {
    const store = require('./store');
    const s = store.readSettings();
    const name = (s && s.office && s.office.desktopDisplayName) || (s && s.boss && s.boss.name) || '';
    if (name) lines.push('Company / office name: ' + name);
  } catch (e) { /* ignore */ }
  try {
    const office = require('./office-state');
    const agents = office.snapshot().agents.filter(function(a) { return a.external; });
    if (agents.length) {
      const agentLines = agents.map(function(a) {
        const skills = (a.skillIds || []).join(', ') || 'no skills';
        return '  - ' + (a.label || a.id) + ' (role: ' + (a.role || 'n/a') + ', skills: ' + skills + ')';
      });
      lines.push('Hired agents (' + agents.length + '):\n' + agentLines.join('\n'));
    } else {
      lines.push('Hired agents: none');
    }
  } catch (e) { /* ignore */ }
  try {
    const registry = require('./registry-store');
    const skills = registry.listSkills();
    if (skills.length) lines.push('Installed skills: ' + skills.map(function(s) { return s.name || s.id; }).join(', '));
  } catch (e) { /* ignore */ }
  try {
    const openclaw = require('./openclaw-config');
    const channels = await openclaw.channelsList().catch(function() { return []; });
    if (channels.length) {
      lines.push('Channels (' + channels.length + '):\n' + channels.map(function(c) {
        return '  - ' + c.provider + '/' + (c.accountId || c.account || 'default') + ' (' + (c.status || 'unknown') + ')';
      }).join('\n'));
    } else {
      lines.push('Channels: none configured');
    }
  } catch (e) { /* ignore */ }
  try {
    const registry = require('./registry-store');
    const deliverables = registry.listDeliverables();
    const now = Date.now();
    const TWO_DAYS = 48 * 60 * 60 * 1000;
    const active = deliverables.filter(function(d) { return d.status !== 'complete' && d.status !== 'archived'; });
    if (active.length) {
      lines.push('Active work (' + active.length + '):\n' + active.slice(0, 10).map(function(d) {
        return '  - [' + d.status + '] ' + (d.agentLabel || 'Agent') + ': ' + (d.summary || d.task || '').slice(0, 120);
      }).join('\n'));
    } else {
      lines.push('Active work: none');
    }
    const recentDone = deliverables.filter(function(d) {
      return d.status === 'complete' && d.createdAt && (now - d.createdAt) < TWO_DAYS;
    });
    if (recentDone.length) {
      lines.push('Completed in last 48h (' + recentDone.length + '):\n' + recentDone.slice(0, 15).map(function(d) {
        const when = new Date(d.createdAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        return '  - [' + when + '] ' + (d.agentLabel || 'Agent') + ': ' + (d.summary || d.task || '').slice(0, 120);
      }).join('\n'));
    }
  } catch (e) { /* ignore */ }
  try {
    const registry = require('./registry-store');
    const standups = registry.listDeliverables().filter(function(d) {
      return Array.isArray(d.standupSections) && d.standupSections.length > 0;
    }).slice(0, 3);
    if (standups.length) {
      lines.push('Recent standup reports:\n' + standups.map(function(d) {
        const when = d.createdAt ? new Date(d.createdAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'unknown';
        const period = (d.reportPeriod && (d.reportPeriod.label || d.reportPeriod.periodLabel)) || '';
        const sections = d.standupSections.map(function(s) { return '    [' + s.label + '] ' + s.text.slice(0, 200); }).join('\n');
        return '  Standup ' + (period ? '(' + period + ') ' : '') + when + ':\n' + sections;
      }).join('\n\n'));
    }
  } catch (e) { /* ignore */ }
  try {
    const hooStore = require('./coo-heartbeat-config-store');
    const cfg = (hooStore.readConfig && hooStore.readConfig()) || {};
    if (cfg.enabled) lines.push('COO heartbeat: enabled (schedule: ' + (cfg.schedule || 'n/a') + ')');
  } catch (e) { /* ignore */ }
  return lines.join('\n');
}

function registerRealtimeRoutes(app) {
  app.get('/api/voice/realtime/models', async function(req, res) {
    const apiKey = String(req.query.apiKey || '').trim();
    if (!apiKey) return res.status(400).json({ ok: false, error: 'apiKey required' });
    try {
      const { status, body } = await httpsGet(OPENAI_HOST, '/v1/models', { Authorization: 'Bearer ' + apiKey });
      if (status !== 200) return res.status(status).json({ ok: false, error: (body && body.error && body.error.message) || 'HTTP ' + status });
      const all = (body && body.data || []).map(function(m) { return m.id; });
      const realtime = all.filter(function(id) { return id.includes('realtime'); });
      res.json({ ok: true, realtime, all });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/realtime/session', async function(req, res) {
    try {
      const body = req.body || {};
      const provider = body.provider || 'openai';
      const apiKey = body.apiKey;
      const model = body.model;
      const voice = body.voice;
      const modalities = body.modalities;
      const systemPrompt = body.systemPrompt;
      if (!String(apiKey || '').trim()) return res.status(400).json({ ok: false, error: 'apiKey is required' });
      const useAudioOut = !modalities || modalities.includes('audio');
      let session;
      if (provider === 'openai') {
        session = await createOpenAISession({ apiKey: apiKey.trim(), model, voice, useAudioOut, systemPrompt });
      } else if (provider === 'doubao') {
        session = await createDoubaoSession();
      } else {
        return res.status(400).json({ ok: false, error: 'Unknown provider: ' + provider });
      }
      res.json({ ok: true, provider, model: session.model || model || OPENAI_DEFAULT_MODEL, session });
    } catch (e) {
      console.error('[voice-realtime] session error:', e.message);
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/voice/office-context', async function(_req, res) {
    try {
      const context = await buildOfficeContext();
      res.json({ ok: true, context });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Voice OS pipeline — intent router → parallel dept data → streaming speak events (SSE).
  app.post('/api/voice/realtime/turn', async function(req, res) {
    const voiceApiPrefs = require('./voice-api-preferences-store');
    const { runRealtimeTurn } = require('./voice-realtime-orchestrator');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    try {
      const body = req.body || {};
      const ownerKey = String(body.ownerKey || 'local:boss').trim() || 'local:boss';
      const resolved = voiceApiPrefs.resolveSttApiKey(ownerKey, body.openaiApiKey);

      send({ type: 'connected', at: Date.now() });

      const result = await runRealtimeTurn({
        text: body.text,
        ownerKey,
        ownerName: String(body.ownerName || 'Boss').trim() || 'Boss',
        threadId: body.threadId,
        replyLanguage: body.replyLanguage === 'zh' ? 'zh' : body.replyLanguage === 'en' ? 'en' : null,
        personaEnabled: body.personaEnabled !== false,
        honorific: String(body.honorific || 'boss').trim() || 'boss',
        personaPrompt: String(body.personaPrompt || ''),
        apiKey: resolved.apiKey,
        signal: abort.signal,
        onEvent: send,
      });

      send({ type: 'done', ok: result.ok !== false, text: result.text || '', intent: result.intent });
      res.end();
    } catch (e) {
      if (!abort.signal.aborted) {
        send({ type: 'error', error: e.message || String(e) });
        send({ type: 'done', ok: false });
      }
      res.end();
    }
  });
}

module.exports = { registerRealtimeRoutes, buildOfficeContext };
