// Built-in office agents (Secretary) — resume / overview for My Agents page.

const roster = require('./roster');
const defaultMcpPack = require('./default-mcp-pack');
const { splitMcpIds, buildAdditionalCapabilities } = require('./agent-overview-build');

function normSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

const BUILTIN_RESUME = {
  secretary: {
    description:
      'Your COO and the only Chat front door. The COO handles Facebook login (opens Chrome for you), then asks if you want to post to groups before delegating the work.',
    examples: [
      '「我要登入 Facebook」— COO opens Chrome for one-time login.',
      'Reply「登好了」— COO asks whether to post to groups.',
      '「发到所有群名带房的群」— COO delegates to Marketing Junior.',
    ],
    jobScopeExtra: {
      key: 'routing',
      icon: 'gear',
      label: 'Front door',
      text: 'Boss → COO (login FB / posting) → Marketing Junior (execute).',
    },
  },
  coo: {
    description:
      'Your hired COO runs the company pipeline: brainstorm, plan, delegate to department workers, and review outcomes. Must be hired from the Agents page.',
    examples: [
      'Ask your COO to plan a product launch and assign Marketing.',
      'Have the COO research a competitor and summarize findings.',
      'Tell the COO to save a web login with a display name via AntlerOffice Tools.',
    ],
    jobScopeExtra: {
      key: 'routing',
      icon: 'gear',
      label: 'Delegation',
      text: 'Routes specialist work to hired department NPCs when their role matches.',
    },
  },
  ceo: {
    description:
      'Your hired COO runs the company pipeline: brainstorm, plan, delegate to department workers, and review outcomes. Must be hired from the Agents page.',
    examples: [
      'Ask your COO to plan a product launch and assign Marketing.',
      'Have the COO research a competitor and summarize findings.',
      'Tell the COO to save a web login with a display name via AntlerOffice Tools.',
    ],
    jobScopeExtra: {
      key: 'routing',
      icon: 'gear',
      label: 'Delegation',
      text: 'Routes specialist work to hired department NPCs when their role matches.',
    },
  },
};

async function buildBuiltinOverview(role, { office, registry }) {
  const dept = roster.byRole(role);
  if (!dept) return null;

  const liveNpc = office.getAgent(role);
  const saved = registry.getBuiltinAgentSettings(role);
  const label = saved.label || dept.label || role;
  const preset = BUILTIN_RESUME[role] || BUILTIN_RESUME[role === 'ceo' ? 'coo' : role] || {};

  const bindings = defaultMcpPack.getBuiltinRoleBindings(role === 'ceo' ? 'coo' : role) || [];
  const mcpsList = registry.listMcps();
  const currentMcpIds = bindings.map((b) => b.mcpId);
  const lookupRole = role === 'ceo' ? 'coo' : role;
  const baseMcpSlugs = (defaultMcpPack.ROLE_SLUGS[lookupRole] || []).map(normSlug);
  const mcpSplit = splitMcpIds(currentMcpIds, { mcpIds: [], mcpSlugs: baseMcpSlugs }, mcpsList);

  const mapMcp = (ids) =>
    ids.map((mcpId) => {
      const m = mcpsList.find((x) => x.id === mcpId);
      return { id: mcpId, name: m?.name || mcpId };
    });

  const baseMcps = mapMcp(mcpSplit.base);
  const additionalMcps = mapMcp(mcpSplit.additional);
  const mcpDetails = [...baseMcps, ...additionalMcps.map((m) => ({ ...m, additional: true }))];

  const defaultMcpNames = (defaultMcpPack.ROLE_SLUGS[lookupRole] || [])
    .map((slug) => defaultMcpPack.MCP_DEFS[slug]?.name)
    .filter(Boolean);

  const toolText =
    baseMcps.length > 0
      ? baseMcps.map((m) => m.name).join(' · ')
      : defaultMcpNames.length > 0
        ? defaultMcpNames.join(' · ')
        : role === 'secretary'
          ? 'OpenClaw Gateway (main)'
          : 'AntlerOffice Tools';

  const additionalCapabilities = buildAdditionalCapabilities({
    additionalSkills: [],
    additionalOpenclaw: [],
    additionalMcps,
  });

  const roleLabel = String(role).replace(/_/g, ' ');
  const jobScope = [
    {
      key: 'role',
      icon: 'briefcase',
      label: 'Office role',
      text:
        role === 'secretary'
          ? `${label} — your built-in front door. Default contact in Boss Chat.`
          : `${label} — hired company leader. Delegates to department workers.`,
    },
  ];
  if (preset.jobScopeExtra) jobScope.push(preset.jobScopeExtra);
  jobScope.push(
    {
      key: 'tools',
      icon: 'wrench',
      label: 'Integrated tools (included)',
      text: toolText,
    },
    {
      key: 'channels',
      icon: 'gear',
      label: 'Channels',
      text:
        role === 'secretary'
          ? 'Inbound Telegram and other channels route to the COO by default unless you change the target.'
          : 'Receives work forwarded from the COO front door.',
    },
  );

  const orgRoles = require('./org-roles');
  const openclaw = require('./openclaw-config');
  let soulPreview = '';
  let modelRef = '';
  const ocAgentId = role === 'secretary' ? 'main' : liveNpc?.openclawAgentId || null;
  const soulAgentId = ocAgentId || 'main';
  const soulFile = openclaw.readAgentWorkspaceFile(soulAgentId, 'SOUL.md');
  if (soulFile.ok) soulPreview = openclaw.soulPreviewFromContent(soulFile.content);
  if (ocAgentId) {
    const modelInfo = await openclaw.getAgentModelRef(ocAgentId);
    modelRef = modelInfo.modelRef || '';
  }

  const description =
    preset.description || `${label} is a built-in AntlerOffice agent.`;
  const examples = preset.examples || [
    `Ask ${label} for help with everyday office operations.`,
    `Delegate a task and let ${label} route it to the right team member.`,
  ];

  return {
    ok: true,
    builtin: true,
    role,
    agent: {
      id: role,
      name: label,
      role,
      runtime: 'openclaw',
      builtin: true,
      sprite: liveNpc?.charSprite ?? saved.sprite ?? dept.charSprite,
      hueShift: liveNpc?.hueShift ?? saved.hueShift ?? 0,
    },
    live: liveNpc
      ? {
          npcState: liveNpc.npcState,
          bubbleText: liveNpc.bubbleText || '',
          currentJob: liveNpc.currentJob || null,
        }
      : { npcState: 'resting', bubbleText: '', currentJob: null },
    description,
    examples,
    jobScope,
    skills: [],
    mcps: mcpDetails,
    baseMcps,
    additionalMcps,
    additionalCapabilities,
    openclawSkills: [],
    knowledge: [],
    recentDeliverables: registry
      .listDeliverables()
      .filter((d) => d.agentId === role)
      .slice(0, 8),
    openclawAvailable: true,
    soulPreview,
    modelRef,
  };
}

module.exports = { buildBuiltinOverview, BUILTIN_RESUME };
