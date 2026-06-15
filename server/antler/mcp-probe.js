// HTTP MCP reachability + auth detection before saving to the registry.
// Stdio MCP (npx playwright, etc.) cannot be probed — caller must skip or start HTTP standalone first.

const DEFAULT_TIMEOUT_MS = 5000;
const REACHABLE_STATUSES = new Set([200, 204, 401, 403, 405, 406, 415]);

const MCP_HEADERS = {
  Accept: 'application/json, text/event-stream',
  'User-Agent': 'AntlerOffice-MCP-Probe/1.0',
};

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'antleroffice-probe', version: '1.0.0' },
  },
});

function normalizeHttpUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;
  try {
    const href = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    const u = new URL(href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

function probeCandidates(url) {
  const parsed = normalizeHttpUrl(url);
  if (!parsed) return [];
  const out = [parsed.toString()];
  const path = parsed.pathname.replace(/\/+$/, '') || '';
  if (!path || path === '/') {
    out.push(new URL('/mcp', parsed.origin).toString());
  }
  return [...new Set(out)];
}

function inferAuthType(status, headers, bodyText) {
  const www = String(headers?.get?.('www-authenticate') || headers?.['www-authenticate'] || '').toLowerCase();
  const body = String(bodyText || '').toLowerCase();

  if (body.includes('oauth') || body.includes('authorize_url') || body.includes('authorization_url')) {
    return 'oauth';
  }
  if (www.includes('apikey') || www.includes('api-key') || body.includes('api_key') || body.includes('api key')) {
    return 'api_key';
  }
  if (www.includes('bearer') || body.includes('bearer') || body.includes('access_token')) {
    return 'bearer';
  }
  if (status === 401 || status === 403) return 'bearer';
  return 'none';
}

async function fetchAttempt(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '';
    }
    return {
      ok: true,
      url,
      status: res.status,
      headers: res.headers,
      bodyText: bodyText.slice(0, 2048),
    };
  } catch (err) {
    const message =
      err && typeof err === 'object' && err.name === 'AbortError'
        ? `Timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, url, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function classifyAttempt(attempt) {
  if (!attempt.ok) {
    return { reachable: false, error: attempt.error, probedUrl: attempt.url };
  }
  const { status, headers, bodyText, url } = attempt;
  if (status === 404) {
    return { reachable: false, error: 'HTTP 404 Not Found', probedUrl: url, statusCode: status };
  }
  if (!REACHABLE_STATUSES.has(status) && status >= 500) {
    return {
      reachable: true,
      probedUrl: url,
      statusCode: status,
      authRequired: false,
      suggestedAuthType: 'none',
      warning: `Server responded with HTTP ${status}`,
    };
  }
  if (status === 401 || status === 403) {
    const suggestedAuthType = inferAuthType(status, headers, bodyText);
    return {
      reachable: true,
      probedUrl: url,
      statusCode: status,
      authRequired: true,
      suggestedAuthType,
    };
  }
  if (REACHABLE_STATUSES.has(status) || (status >= 200 && status < 500)) {
    return {
      reachable: true,
      probedUrl: url,
      statusCode: status,
      authRequired: false,
      suggestedAuthType: 'none',
    };
  }
  return { reachable: false, error: `Unexpected HTTP ${status}`, probedUrl: url, statusCode: status };
}

async function probeOneUrl(url, timeoutMs) {
  const getAttempt = await fetchAttempt(url, { method: 'GET', headers: MCP_HEADERS }, timeoutMs);
  if (
    getAttempt.ok &&
    (getAttempt.status === 405 || getAttempt.status === 406 || getAttempt.status === 415)
  ) {
    const postAttempt = await fetchAttempt(
      url,
      {
        method: 'POST',
        headers: { ...MCP_HEADERS, 'Content-Type': 'application/json' },
        body: INIT_BODY,
      },
      timeoutMs,
    );
    const postResult = classifyAttempt(postAttempt);
    if (postResult.reachable) return postResult;
  }

  return classifyAttempt(getAttempt);
}

/**
 * Probe an HTTP MCP endpoint for reachability and auth requirements.
 * @returns {Promise<{ reachable: boolean, probedUrl?: string, authRequired?: boolean, suggestedAuthType?: string, statusCode?: number, error?: string, warning?: string, probedAt: number }>}
 */
async function probe({ url, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const probedAt = Date.now();
  const parsed = normalizeHttpUrl(url);
  if (!parsed) {
    return {
      reachable: false,
      error: 'Invalid or missing HTTP URL',
      probedAt,
    };
  }

  const candidates = probeCandidates(url);
  const errors = [];

  for (const candidate of candidates) {
    const result = await probeOneUrl(candidate, timeoutMs);
    if (result.reachable) {
      return { ...result, probedAt, candidatesTried: candidates };
    }
    errors.push(result.error || `Failed on ${candidate}`);
  }

  return {
    reachable: false,
    error: errors[0] || 'MCP server unreachable',
    probedAt,
    candidatesTried: candidates,
  };
}

function applyProbeToMcpBody(body, probeResult) {
  if (!probeResult?.reachable) return body;
  const next = { ...body };
  if (probeResult.probedUrl && typeof probeResult.probedUrl === 'string') {
    next.url = probeResult.probedUrl;
  }
  next.authRequired = !!probeResult.authRequired;
  next.suggestedAuthType = probeResult.suggestedAuthType || 'none';
  next.lastProbeAt = probeResult.probedAt;
  return next;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  normalizeHttpUrl,
  probeCandidates,
  probe,
  applyProbeToMcpBody,
};
