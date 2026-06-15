// Fetch agent catalog from ECS official API; fallback to local catalog.json.

const agentCatalog = require('./agent-catalog');

function ecsBaseUrl() {
  const url = (process.env.ECS_BASE_URL || process.env.ECS_SERVER_URL || '').replace(/\/+$/, '');
  return url;
}

async function fetchCatalogFromEcs() {
  const base = ecsBaseUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/catalog/agents`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.templates) ? data.templates : null;
  } catch {
    return null;
  }
}

async function loadCatalogMerged() {
  const remote = await fetchCatalogFromEcs();
  if (remote?.length) return remote;
  return agentCatalog.loadCatalog();
}

async function catalogWithStatusMerged() {
  const templates = await loadCatalogMerged();
  const registry = require('./registry-store');
  const hired = new Set(registry.listAgents().map((a) => a.templateId).filter(Boolean));

  return templates.map((t) => {
    const skillNames = (t.skillIds || [])
      .map((id) => agentCatalog.bundledSkillDef(id)?.name)
      .filter(Boolean);
    const mcpNames = (t.mcps || []).map((m) => m.name || m.slug).filter(Boolean);
    return registry.enrichCatalogTemplate({
      ...t,
      skillNames,
      mcpNames,
      includesLabel: [
        skillNames.length ? `${skillNames.length} skill${skillNames.length === 1 ? '' : 's'}` : '',
        mcpNames.length ? `${mcpNames.length} MCP${mcpNames.length === 1 ? '' : 's'}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      hired: hired.has(t.id),
      source: ecsBaseUrl() ? 'ecs' : 'local',
    });
  });
}

module.exports = {
  ecsBaseUrl,
  fetchCatalogFromEcs,
  loadCatalogMerged,
  catalogWithStatusMerged,
};
