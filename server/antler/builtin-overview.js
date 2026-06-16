// Built-in office agents (COO) — resume / overview for My Agents page.

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
  coo: {
    description:
      'Your chief operating officer and default Boss Chat contact. COO talks with you directly, routes tasks to the right hired specialist when possible, saves web login accounts on your behalf, and uses research tools to answer business questions.',
    examples: [
      'Tell COO: "Save account — display name Mom\'s house, username xxx, password yyy."',
      'Ask COO to research a competitor website and summarize what they offer.',
      'Give COO a task about marketing — COO will assign it to your Marketing hire if you have one.',
    ],
    jobScopeExtra: {
      key: 'routing',
      icon: 'gear',
      label: 'Task routing',
      text: 'Reads your request and delegates to a hired NPC when their role matches (design, marketing, HR, IT, etc.).',
    },
  },
};

function buildBuiltinOverview(role, { office, registry }) {
  const dept = roster.byRole(role);
  if (!dept) return null;

  const liveNpc = office.getAgent(role);
  const saved = registry.getBuiltinAgentSettings(role);
  const label = saved.label || dept.label || role;
  const preset = BUILTIN_RESUME[role] || {};

  const bindings = defaultMcpPack.getBuiltinRoleBindings(role) || [];
  const mcpsList = registry.listMcps();
  const currentMcpIds = bindings.map((b) => b.mcpId);
  const baseMcpSlugs = (defaultMcpPack.ROLE_SLUGS[role] || []).map(normSlug);
  const mcpSplit = splitMcpIds(currentMcpIds, { mcpIds: [], mcpSlugs: baseMcpSlugs }, mcpsList);

  const mapMcp = (ids) =>
    ids.map((mcpId) => {
      const m = mcpsList.find((x) => x.id === mcpId);
      return { id: mcpId, name: m?.name || mcpId };
    });

  const baseMcps = mapMcp(mcpSplit.base);
  const additionalMcps = mapMcp(mcpSplit.additional);
  const mcpDetails = [...baseMcps, ...additionalMcps.map((m) => ({ ...m, additional: true }))];

  const defaultMcpNames = (defaultMcpPack.ROLE_SLUGS[role] || [])
    .map((slug) => defaultMcpPack.MCP_DEFS[slug]?.name)
    .filter(Boolean);

  const toolText =
    baseMcps.length > 0
      ? baseMcps.map((m) => m.name).join(' · ')
      : defaultMcpNames.length > 0
        ? defaultMcpNames.join(' · ')
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
      text: `${label} — your built-in ${roleLabel} supervisor. Default contact in Boss Chat.`,
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
      text: 'Inbound Telegram and other channels route to COO by default unless you change the target.',
    },
  );

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
  };
}

module.exports = { buildBuiltinOverview, BUILTIN_RESUME };
