// One-time desktop sign-in handoff: browser completes OAuth → Electron picks up bossToken.

const TTL_MS = 3 * 60 * 1000;
let pending = null;
let timer = null;

function clearPending() {
  pending = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function setPending(payload) {
  clearPending();
  pending = { ...payload, at: Date.now() };
  timer = setTimeout(clearPending, TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function takePending() {
  if (!pending) return null;
  if (Date.now() - pending.at > TTL_MS) {
    clearPending();
    return null;
  }
  const data = { ...pending };
  delete data.at;
  clearPending();
  return data;
}

function peekPending() {
  if (!pending) return null;
  if (Date.now() - pending.at > TTL_MS) {
    clearPending();
    return null;
  }
  const { at, ...rest } = pending;
  return rest;
}

module.exports = {
  setPending,
  takePending,
  peekPending,
  clearPending,
};
