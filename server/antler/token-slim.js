// Token slimming layer (inspired by OpenHuman "TokenJuice").
// Shrinks big payloads BEFORE they reach any LLM, without losing meaning:
//   - HTML → plain text (only when the payload clearly looks like HTML)
//   - data:...;base64 blobs → short placeholder (these are pure token waste)
//   - very long URLs → origin + trimmed path
//   - whitespace runs and 3+ blank lines collapsed
//   - consecutive duplicate lines deduped ("(repeated xN)")
//   - final head+tail cut when still over budget
// CJK / emoji / multi-byte text is never stripped — all rules are ASCII-targeted
// or structural, so 中文 content passes through untouched.

const DEFAULT_MAX_CHARS = 12000; // ~4-6k tokens for mixed zh/en text
const SLIM_MIN_CHARS = 3000; // below this, don't bother — short prompts are cheap

function looksLikeHtml(s) {
  // Needs a real tag density, not just one "<div>" quoted in prose.
  const tags = (s.match(/<\/?[a-z][a-z0-9-]*(\s[^<>]*)?>/gi) || []).length;
  return tags >= 10 && /<\/(div|p|span|td|li|a|body|table|script|style)>/i.test(s);
}

function stripHtml(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^<>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripBase64(s) {
  // data URIs and bare base64 walls (>200 chars of base64 alphabet).
  return String(s)
    .replace(/data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]{40,}/gi, '[binary data removed]')
    .replace(/(?:^|\s)[A-Za-z0-9+/]{200,}={0,2}(?=\s|$)/g, ' [base64 removed] ');
}

function shortenUrls(s) {
  return String(s).replace(/https?:\/\/[^\s"'<>)\]]{100,}/g, (url) => {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname.slice(0, 40)}…`;
    } catch {
      return url.slice(0, 80) + '…';
    }
  });
}

function collapseWhitespace(s) {
  return String(s)
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n');
}

function dedupeLines(s) {
  const lines = String(s).split('\n');
  const out = [];
  let prev = null;
  let count = 0;
  const flush = () => {
    if (prev === null) return;
    out.push(prev);
    if (count > 1) out.push(`(repeated x${count})`);
    prev = null;
    count = 0;
  };
  for (const line of lines) {
    const key = line.trim();
    if (key && prev !== null && key === prev.trim()) {
      count += 1;
      continue;
    }
    flush();
    prev = line;
    count = 1;
  }
  flush();
  return out.join('\n');
}

function headTailCut(s, maxChars) {
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head - 60;
  return (
    s.slice(0, head) +
    `\n\n[... ${s.length - head - tail} chars trimmed to save tokens ...]\n\n` +
    s.slice(s.length - Math.max(tail, 0))
  );
}

/**
 * Slim a payload destined for an LLM prompt. Safe by default:
 * short inputs are returned untouched; transforms never remove CJK text.
 * @param {string} text
 * @param {{ maxChars?: number, force?: boolean }} [opts]
 */
function slimForLLM(text, opts = {}) {
  let s = String(text || '');
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  if (!opts.force && s.length < SLIM_MIN_CHARS) return s;

  if (looksLikeHtml(s)) s = stripHtml(s);
  s = stripBase64(s);
  s = shortenUrls(s);
  s = dedupeLines(s);
  s = collapseWhitespace(s);
  s = headTailCut(s.trim(), maxChars);
  return s;
}

module.exports = { slimForLLM, stripHtml, stripBase64, shortenUrls, dedupeLines, headTailCut };
