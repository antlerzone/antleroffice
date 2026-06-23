// Retell AI REST client — uses the boss's own (encrypted) API key.
// Docs: https://docs.retellai.com/api-references
// All calls authenticate with `Authorization: Bearer <API_KEY>`.

const retellStore = require('./retell-store');

const BASE_URL = 'https://api.retellai.com';

class RetellError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RetellError';
    this.status = status;
  }
}

function requireKey() {
  const key = retellStore.getApiKey();
  if (!key) {
    throw new RetellError(
      'No Retell API key configured. The boss must add their Retell API key in Models / Integrations first.',
      428,
    );
  }
  return key;
}

async function request(method, path, body) {
  const key = requireKey();
  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new RetellError(`Could not reach Retell: ${e instanceof Error ? e.message : String(e)}`, 0);
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg = (data && (data.error_message || data.message || data.error)) || `Retell API error (${res.status})`;
    throw new RetellError(typeof msg === 'string' ? msg : JSON.stringify(msg), res.status);
  }
  return data;
}

/** Is a key configured? (no secret returned) */
function status() {
  return retellStore.getStatus();
}

/** GET /list-agents — the boss's voice agents. */
async function listAgents() {
  const data = await request('GET', '/list-agents');
  return Array.isArray(data) ? data : data.agents || data;
}

/** GET /list-phone-numbers — numbers available to call FROM. */
async function listPhoneNumbers() {
  const data = await request('GET', '/list-phone-numbers');
  return Array.isArray(data) ? data : data.phone_numbers || data;
}

/**
 * POST /v2/create-phone-call — place an outbound call.
 * @param {{ fromNumber:string, toNumber:string, agentId?:string,
 *           dynamicVariables?:object, metadata?:object }} opts
 */
async function createPhoneCall(opts = {}) {
  const fromNumber = String(opts.fromNumber || '').trim();
  const toNumber = String(opts.toNumber || '').trim();
  if (!fromNumber) throw new RetellError('fromNumber is required', 400);
  if (!toNumber) throw new RetellError('toNumber is required', 400);

  const body = { from_number: fromNumber, to_number: toNumber };
  if (opts.agentId) body.override_agent_id = String(opts.agentId).trim();
  if (opts.dynamicVariables && typeof opts.dynamicVariables === 'object') {
    body.retell_llm_dynamic_variables = opts.dynamicVariables;
  }
  if (opts.metadata && typeof opts.metadata === 'object') {
    body.metadata = opts.metadata;
  }
  return request('POST', '/v2/create-phone-call', body);
}

/** GET /v2/get-call/{callId} — fetch a call's status / outcome. */
async function getCall(callId) {
  const id = String(callId || '').trim();
  if (!id) throw new RetellError('callId is required', 400);
  return request('GET', `/v2/get-call/${encodeURIComponent(id)}`);
}

module.exports = {
  RetellError,
  status,
  listAgents,
  listPhoneNumbers,
  createPhoneCall,
  getCall,
  BASE_URL,
};
