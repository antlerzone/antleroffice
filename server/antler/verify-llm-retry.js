// Offline verification for llm.js retry layer. Run: node verify-llm-retry.js
// Stubs global fetch — no network, no API key needed.

const assert = require('assert');

let calls = [];
let script = [];

global.fetch = async (url, options) => {
  calls.push({ url, options });
  const step = script.shift();
  if (!step) throw new Error('script exhausted');
  if (step.throw) {
    const e = new TypeError(step.throw); // fetch network errors are TypeErrors
    throw e;
  }
  return {
    ok: step.status >= 200 && step.status < 300,
    status: step.status,
    headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? step.retryAfter || null : null) },
    text: async () => step.body || '',
    json: async () => JSON.parse(step.body || '{}'),
  };
};

const { callOpenAI, fetchWithRetry } = require('./llm');

const okBody = JSON.stringify({ choices: [{ message: { content: 'hello world' } }] });

async function main() {
  // 1. Transient 429 then success → retried, succeeds.
  calls = [];
  script = [{ status: 429, body: 'rate limited', retryAfter: '0.05' }, { status: 200, body: okBody }];
  const t0 = Date.now();
  const out1 = await callOpenAI({ apiKey: 'k', prompt: 'hi' });
  assert.strictEqual(out1, 'hello world', 'should return text after retry');
  assert.strictEqual(calls.length, 2, '429 should be retried once then succeed');
  assert.ok(Date.now() - t0 >= 40, 'should honor Retry-After delay');
  console.log('PASS 1: 429 → retry → success (honors Retry-After)');

  // 2. Permanent 401 → thrown immediately, exactly 1 call, old error format kept.
  calls = [];
  script = [{ status: 401, body: 'bad key' }];
  let err2 = null;
  try {
    await callOpenAI({ apiKey: 'bad', prompt: 'hi' });
  } catch (e) {
    err2 = e;
  }
  assert.ok(err2, '401 must throw');
  assert.strictEqual(calls.length, 1, '401 must NOT be retried');
  assert.ok(/^OpenAI 401: bad key/.test(err2.message), 'error format preserved: ' + err2.message);
  console.log('PASS 2: 401 → no retry, error format preserved');

  // 3. Network drop then success → retried.
  calls = [];
  script = [{ throw: 'fetch failed' }, { status: 200, body: okBody }];
  const out3 = await callOpenAI({ apiKey: 'k', prompt: 'hi' });
  assert.strictEqual(out3, 'hello world');
  assert.strictEqual(calls.length, 2, 'network error should be retried');
  console.log('PASS 3: network drop → retry → success');

  // 4. Persistent 503 → gives up after max attempts (3), throws last error.
  calls = [];
  script = [
    { status: 503, body: 'down', retryAfter: '0.01' },
    { status: 503, body: 'down', retryAfter: '0.01' },
    { status: 503, body: 'down', retryAfter: '0.01' },
  ];
  let err4 = null;
  try {
    await fetchWithRetry('OpenAI', 'https://x', {});
  } catch (e) {
    err4 = e;
  }
  assert.ok(err4 && err4.status === 503, 'should throw last 503');
  assert.strictEqual(calls.length, 3, 'should stop after 3 attempts');
  console.log('PASS 4: persistent 503 → 3 attempts then give up');

  // 5. Abort signal stops retries immediately.
  calls = [];
  script = [{ status: 429, body: 'rl', retryAfter: '5' }];
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  let err5 = null;
  const t5 = Date.now();
  try {
    await fetchWithRetry('OpenAI', 'https://x', { signal: ac.signal });
  } catch (e) {
    err5 = e;
  }
  assert.ok(err5, 'abort must throw');
  assert.ok(Date.now() - t5 < 2000, 'abort must not wait out the 5s Retry-After');
  console.log('PASS 5: abort cancels pending retry wait');

  console.log('\nAll 5 checks passed.');
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
