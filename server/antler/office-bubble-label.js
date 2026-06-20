// Format NPC overlay text for the pixel office (ToolOverlay status line).

const PHASE = {
  thinking: 'Processing',
  processing: 'Processing',
  'producing deliverable': 'Processing',
  typing: 'Writing',
  replying: 'Writing',
  searching: 'Searching',
  validating: 'Validating',
  waiting: 'Waiting',
  context: 'Organizing',
  tools: 'Running tools',
};

function clip(s, max = 54) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function normalizeStep(step) {
  return String(step || '')
    .trim()
    .toLowerCase();
}

function classifyToolName(toolName) {
  const n = String(toolName || '').trim();
  const low = n.toLowerCase();
  if (!n) return { step: 'processing', prefix: 'Processing' };
  if (/valid|verify|check|lint|test|schema|audit/.test(low)) {
    return { step: 'validating', prefix: 'Validating', detail: n };
  }
  if (/browser|web|search|fetch|curl|firecrawl|perplexity/.test(low)) {
    return { step: 'searching', prefix: 'Searching', detail: n };
  }
  if (/exec|bash|shell|command|terminal|run/.test(low)) {
    return { step: 'processing', prefix: 'Running', detail: n };
  }
  if (/read|write|edit|grep|glob|file/.test(low)) {
    return { step: 'processing', prefix: 'Processing', detail: n };
  }
  return { step: 'processing', prefix: 'Using', detail: n };
}

function formatPhaseLine(prefix, detail) {
  const d = clip(detail, 40);
  if (!d) return `${prefix}…`;
  return clip(`${prefix}: ${d}`);
}

function formatOfficeBubble(agent) {
  if (!agent) return '';

  if (agent.npcState !== 'working') {
    const rest = clip(agent.bubbleText, 48);
    if (rest && !/^done/i.test(rest) && !/^idle$/i.test(rest)) return rest;
    return '';
  }

  const job = agent.currentJob || {};
  const step = normalizeStep(job.step);
  const taskLabel = clip(job.label, 40);
  const raw = String(agent.bubbleText || '').trim();

  if (/^(processing|validating|searching|writing|running|organizing|waiting):/i.test(raw)) {
    return clip(raw);
  }

  if (/^using /i.test(raw) || /^thinking/i.test(raw)) {
    const tool = raw.replace(/^using\s+/i, '').replace(/…$/, '').trim();
    const { prefix, detail } = classifyToolName(tool);
    return formatPhaseLine(prefix, detail || taskLabel);
  }

  const prefix = PHASE[step] || (step ? step.charAt(0).toUpperCase() + step.slice(1) : 'Processing');
  if (taskLabel) return formatPhaseLine(prefix, taskLabel);
  if (raw) return clip(raw);
  return `${prefix}…`;
}

function jobFingerprint(agent) {
  const job = agent?.currentJob;
  if (!job) return '';
  return `${job.step || ''}|${job.label || ''}|${job.progress || 0}`;
}

module.exports = { formatOfficeBubble, classifyToolName, formatPhaseLine, jobFingerprint };
