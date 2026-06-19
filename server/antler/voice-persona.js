const fs = require('node:fs');
const path = require('node:path');

function personaPath(name) {
  return path.join(__dirname, 'personas', `${name}.md`);
}

function loadPersona(name, vars = {}) {
  const file = personaPath(name);
  if (!fs.existsSync(file)) return '';
  let text = fs.readFileSync(file, 'utf8').trim();
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${key}}`, String(value ?? ''));
  }
  return text;
}

function buildJarvisPersonaSnippet(honorific = 'boss', template) {
  if (!honorific && !template) return '';
  const raw = String(template || '').trim() || loadPersona('jarvis', {});
  if (!raw) return '';
  return loadPersonaFromText(raw, { honorific: honorific || 'boss' });
}

function loadPersonaFromText(text, vars = {}) {
  let out = String(text || '').trim();
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, String(value ?? ''));
  }
  return out;
}

function getJarvisTemplate() {
  return loadPersona('jarvis', {});
}

module.exports = {
  loadPersona,
  loadPersonaFromText,
  buildJarvisPersonaSnippet,
  getJarvisTemplate,
};
