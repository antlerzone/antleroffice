// Per-thread marketing workflow artifacts (CEO execute phase).

const contexts = new Map();

const ARTIFACT_KEYS = {
  product_research: 'research',
  marketing: 'plan',
  marketing_editor: 'copyDraft',
  graphic_design: 'designAssets',
  marketing_junior: 'publishPack',
};

const DEFAULT_ARTIFACTS = () => ({
  research: '',
  plan: '',
  copyDirection: '',
  copyDraft: '',
  designBrief: '',
  designAssets: '',
  publishPack: '',
});

function getWorkflowContext(threadId) {
  const key = String(threadId || 'default');
  if (!contexts.has(key)) {
    contexts.set(key, { artifacts: DEFAULT_ARTIFACTS(), revisionCounts: {} });
  }
  return contexts.get(key);
}

function clearWorkflowContext(threadId) {
  if (threadId) contexts.delete(String(threadId));
}

function revisionKey(threadId, role) {
  return `${threadId || 'default'}:${role}`;
}

function getRevisionCount(threadId, role) {
  const ctx = getWorkflowContext(threadId);
  return ctx.revisionCounts[role] || 0;
}

function bumpRevisionCount(threadId, role) {
  const ctx = getWorkflowContext(threadId);
  ctx.revisionCounts[role] = (ctx.revisionCounts[role] || 0) + 1;
  return ctx.revisionCounts[role];
}

function storeArtifact(threadId, role, text) {
  const ctx = getWorkflowContext(threadId);
  const key = ARTIFACT_KEYS[role];
  if (key && text) ctx.artifacts[key] = text;
  return ctx.artifacts;
}

function artifactsBlock(threadId, role) {
  const { artifacts } = getWorkflowContext(threadId);
  const lines = [];
  if (role === 'marketing_editor' && artifacts.copyDirection) {
    lines.push(`### Copy direction\n${artifacts.copyDirection}`);
  }
  if (role === 'graphic_design' && artifacts.designBrief) {
    lines.push(`### Visual brief\n${artifacts.designBrief}`);
  }
  if (artifacts.research) lines.push(`### Research\n${artifacts.research}`);
  if (artifacts.plan) lines.push(`### Department plan\n${artifacts.plan}`);
  if (artifacts.copyDraft && role !== 'marketing_editor') {
    lines.push(`### Copy draft\n${artifacts.copyDraft}`);
  }
  if (artifacts.designAssets && role !== 'graphic_design') {
    lines.push(`### Design assets\n${artifacts.designAssets}`);
  }
  return lines.length ? lines.join('\n\n') : '';
}

function parseReviewOutcome(text) {
  const body = String(text || '');
  const approved = /\bAPPROVED\b/i.test(body) || /\bapprove(d)?\b/i.test(body) && !/\bnot approved\b/i.test(body);
  const needsRevision =
    /\bREVISION\b/i.test(body) ||
    /\bneeds changes\b/i.test(body) ||
    /\brevise\b/i.test(body) ||
    /\breject(ed)?\b/i.test(body);
  return { approved: approved && !needsRevision, needsRevision };
}

function extractCopyDirection(managerText) {
  const m = String(managerText || '').match(/##\s*Briefs? for Editor[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
  return m ? m[1].trim() : '';
}

function extractDesignBrief(managerText) {
  const m = String(managerText || '').match(/##\s*(?:Visual brief|Briefs? for Design)[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
  return m ? m[1].trim() : '';
}

module.exports = {
  getWorkflowContext,
  clearWorkflowContext,
  storeArtifact,
  artifactsBlock,
  parseReviewOutcome,
  extractCopyDirection,
  extractDesignBrief,
  getRevisionCount,
  bumpRevisionCount,
  ARTIFACT_KEYS,
};
