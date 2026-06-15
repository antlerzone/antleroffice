const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

function registryPath() {
  return path.join(__dirname, '..', '..', 'skills', 'registry.json');
}

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
  } catch {
    return { skills: [] };
  }
}

function notesDir() {
  return path.join(getDataDir(), 'notes');
}

// Shared "RAG-lite": read every note file and concatenate. Good enough for MVP;
// swap for a vector index later without changing callers.
function readSharedNotes(limitChars = 4000) {
  const dir = notesDir();
  let out = '';
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') && !f.endsWith('.txt')) continue;
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      out += `\n# ${f}\n${body}\n`;
      if (out.length > limitChars) break;
    }
  } catch {
    /* no notes yet */
  }
  return out.slice(0, limitChars).trim();
}

function appendNote(name, text) {
  const dir = notesDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const safe = String(name || 'note').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);
  const file = path.join(dir, `${safe}.md`);
  fs.appendFileSync(file, `\n${text}\n`, 'utf8');
  return file;
}

module.exports = { loadRegistry, readSharedNotes, appendNote, notesDir };
