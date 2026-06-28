// Build agent resume overview — base (catalog/hire) vs additional (added later).

function normSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function resolveBaseline(agent, catalog) {
  if (Array.isArray(agent.baselineSkillIds)) {
    return {
      skillIds: agent.baselineSkillIds || [],
      openclawSkillNames: agent.baselineOpenclawSkillNames || [],
      mcpIds: agent.baselineMcpIds || [],
      mcpSlugs: [],
    };
  }
  return {
    skillIds: catalog?.skillIds || [],
    openclawSkillNames: catalog?.openclawSkillNames || [],
    mcpIds: [],
    mcpSlugs: (catalog?.mcps || []).map((m) => normSlug(m.slug || m.name)).filter(Boolean),
  };
}

function splitIds(current = [], base = []) {
  const baseSet = new Set(base);
  return {
    base: current.filter((id) => baseSet.has(id)),
    additional: current.filter((id) => !baseSet.has(id)),
  };
}

function splitNames(current = [], base = []) {
  const baseSet = new Set(base.map((n) => normSlug(n)));
  return {
    base: current.filter((n) => baseSet.has(normSlug(n))),
    additional: current.filter((n) => !baseSet.has(normSlug(n))),
  };
}

function splitMcpIds(currentIds = [], baseline, mcpsList = []) {
  const baseIdSet = new Set(baseline.mcpIds || []);
  const baseSlugSet = new Set((baseline.mcpSlugs || []).map(normSlug));
  const base = [];
  const additional = [];
  for (const mcpId of currentIds) {
    const m = mcpsList.find((x) => x.id === mcpId);
    const slug = normSlug(m?.slug || m?.name || '');
    if (baseIdSet.has(mcpId) || (slug && baseSlugSet.has(slug))) base.push(mcpId);
    else additional.push(mcpId);
  }
  return { base, additional };
}

function mapSkillDetails(ids, { agent, allSkills, agentCatalog }) {
  return ids.map((sid) => {
    const s = allSkills.find((x) => x.id === sid);
    const bundled = agent.templateId ? agentCatalog.bundledSkillDef(sid, agent.templateId) : null;
    const def = s || bundled || {};
    const system = def.system || '';
    const version = Number.isFinite(Number(def.version)) && Number(def.version) >= 1
      ? Math.floor(Number(def.version))
      : 1;
    return {
      id: sid,
      name: def.name || String(sid).replace(/_/g, ' '),
      systemPreview: system ? String(system).slice(0, 280) : '',
      version,
      description: typeof def.description === 'string' ? def.description : '',
    };
  });
}

function mapMcpDetails(ids, mcpsList) {
  return ids.map((mcpId) => {
    const m = mcpsList.find((x) => x.id === mcpId);
    return { id: mcpId, name: m?.name || mcpId };
  });
}

function buildAdditionalCapabilities({ additionalSkills, additionalOpenclaw, additionalMcps }) {
  const rows = [];
  for (const s of additionalSkills) {
    rows.push({ kind: 'skill', id: s.id, label: 'Additional skill', name: s.name, detail: s.systemPreview || '' });
  }
  for (const name of additionalOpenclaw) {
    rows.push({ kind: 'openclaw', id: name, label: 'Additional workflow', name, detail: '' });
  }
  for (const m of additionalMcps) {
    rows.push({ kind: 'mcp', id: m.id, label: 'Additional MCP', name: m.name, detail: '' });
  }
  return rows;
}

function buildHiredAgentOverview(agent, { catalog, allSkills, mcpsList, agentCatalog, liveNpc }) {
  const baseline = resolveBaseline(agent, catalog);
  const currentSkillIds = agent.skillIds || [];
  const currentOpenclaw = agent.openclawSkillNames || [];
  const currentMcpIds = agent.mcpBindings?.length
    ? agent.mcpBindings.map((b) => b.mcpId)
    : agent.mcpIds || [];

  const skillSplit = splitIds(currentSkillIds, baseline.skillIds);
  const openclawSplit = splitNames(currentOpenclaw, baseline.openclawSkillNames);
  const mcpSplit = splitMcpIds(currentMcpIds, baseline, mcpsList);

  const baseSkills = mapSkillDetails(skillSplit.base, { agent, allSkills, agentCatalog });
  const additionalSkills = mapSkillDetails(skillSplit.additional, { agent, allSkills, agentCatalog });
  const baseMcps = mapMcpDetails(mcpSplit.base, mcpsList);
  const additionalMcps = mapMcpDetails(mcpSplit.additional, mcpsList);

  // Built-in skills this role *could* have at its latest version, that the
  // hired agent has NOT learned yet. Compare against the role's current catalog
  // skill set (not the baseline frozen at hire time) so newly-added built-in
  // capabilities surface here as "lockable" learn targets.
  const latestRoleSkillIds =
    catalog && Array.isArray(catalog.skillIds) && catalog.skillIds.length
      ? catalog.skillIds
      : baseline.skillIds || [];
  const learnedSet = new Set(currentSkillIds);
  const lockedSkillIds = latestRoleSkillIds.filter((id) => !learnedSet.has(id));
  const lockedSkills = mapSkillDetails(lockedSkillIds, { agent, allSkills, agentCatalog });

  // Learned skills that have since been upgraded — the worker's recorded version
  // is older than the skill's current version. Surfaced so the detail page can
  // offer a one-click "Update to vN".
  const learnedVersions =
    agent.skillVersions && typeof agent.skillVersions === 'object' ? agent.skillVersions : {};
  const outdatedSkills = mapSkillDetails(currentSkillIds, { agent, allSkills, agentCatalog })
    .filter((s) => {
      const learnedV = learnedVersions[s.id];
      return learnedV != null && Number(learnedV) < Number(s.version);
    })
    .map((s) => ({ ...s, learnedVersion: Number(learnedVersions[s.id]) }));

  const roleLabel = String(agent.role || 'worker').replace(/_/g, ' ');
  const jobScope = [
    {
      key: 'role',
      icon: 'briefcase',
      label: 'Office role',
      text: `${roleLabel} — ${catalog?.tagline || `Handles ${roleLabel} tasks in your office.`}`,
    },
    {
      key: 'skills',
      icon: 'gear',
      label: 'ECS skills (included)',
      text: baseSkills.length
        ? baseSkills.map((s) => s.name).join(' · ')
        : 'No bundled ECS skills.',
    },
    {
      key: 'openclaw',
      icon: 'gear',
      label: 'OpenClaw workflows (included)',
      text: openclawSplit.base.length
        ? openclawSplit.base.join(' · ')
        : 'No bundled OpenClaw workflows.',
    },
    {
      key: 'tools',
      icon: 'wrench',
      label: 'Integrated tools (included)',
      text: baseMcps.length ? baseMcps.map((m) => m.name).join(' · ') : 'No bundled MCP tools.',
    },
  ];

  const additionalCapabilities = buildAdditionalCapabilities({
    additionalSkills,
    additionalOpenclaw: openclawSplit.additional,
    additionalMcps,
  });

  return {
    jobScope,
    skills: [...baseSkills, ...additionalSkills.map((s) => ({ ...s, additional: true }))],
    mcps: [...baseMcps, ...additionalMcps.map((m) => ({ ...m, additional: true }))],
    baseSkills,
    additionalSkills,
    lockedSkills,
    outdatedSkills,
    baseMcps,
    additionalMcps,
    additionalOpenclawSkills: openclawSplit.additional,
    additionalCapabilities,
    description:
      catalog?.description ||
      catalog?.tagline ||
      `${agent.name} is your ${roleLabel} agent in AntlerOffice.`,
    examples: Array.isArray(catalog?.examples) ? catalog.examples : [],
    openclawSkills: currentOpenclaw,
    live: liveNpc
      ? {
          npcState: liveNpc.npcState,
          bubbleText: liveNpc.bubbleText || '',
          currentJob: liveNpc.currentJob || null,
        }
      : { npcState: 'resting', bubbleText: '', currentJob: null },
    catalog: catalog
      ? {
          id: catalog.id,
          name: catalog.name,
          tagline: catalog.tagline,
          description: catalog.description,
          examples: catalog.examples,
        }
      : null,
  };
}

module.exports = {
  buildHiredAgentOverview,
  resolveBaseline,
  splitMcpIds,
  buildAdditionalCapabilities,
};
