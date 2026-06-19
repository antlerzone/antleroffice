// Fetch agent catalog from ECS official API; fallback to local departments + catalog.json.

const fs = require('node:fs');
const path = require('node:path');
const agentCatalog = require('./agent-catalog');

function ecsBaseUrl() {
  const url = (process.env.ECS_BASE_URL || process.env.ECS_SERVER_URL || '').replace(/\/+$/, '');
  return url;
}

function localDepartmentsSeedPath() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'server', 'data', 'departments.json'),
    path.join(__dirname, '..', '..', 'server', 'data', 'departments.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function localCatalogPath() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'server', 'data', 'catalog.json'),
    path.join(__dirname, '..', '..', 'server', 'data', 'catalog.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseConfigJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function billingCreditsFromDept(dept, tech = {}) {
  const cfg = parseConfigJson(dept.configJson);
  return tech.billingCreditsByInterval || cfg?.billingCreditsByInterval || null;
}

/** Local repo seed prices override stale remote ECS catalog (dev monorepo). */
function loadLocalPricingOverlayMap() {
  const map = new Map();
  const put = (key, pricing) => {
    if (!key || !pricing) return;
    const hasBilling = pricing.billingCreditsByInterval
      && Object.keys(pricing.billingCreditsByInterval).length > 0;
    const hasSalary = Number.isFinite(pricing.salaryCreditsPerMonth);
    if (!hasBilling && !hasSalary) return;
    map.set(key, pricing);
  };

  const deptPath = localDepartmentsSeedPath();
  if (deptPath) {
    const seed = readJsonSafe(deptPath, { departments: [] });
    const catalogPath = localCatalogPath();
    const catalog = catalogPath ? readJsonSafe(catalogPath, { templates: [] }) : { templates: [] };
    const techById = new Map((catalog.templates || []).map((t) => [t.id, t]));
    for (const dept of seed.departments || []) {
      const bundleId = dept.bundleTemplateId || dept.id;
      const tech = techById.get(bundleId) || techById.get(dept.id) || {};
      const pricing = {
        salaryCreditsPerMonth: dept.salaryCreditsPerMonth ?? tech.salaryCreditsPerMonth,
        billingCreditsByInterval: billingCreditsFromDept(dept, tech),
      };
      put(dept.id, pricing);
      put(bundleId, pricing);
      if (dept.role) put(dept.role, pricing);
    }
  }

  for (const t of agentCatalog.loadCatalog() || []) {
    put(t.id, {
      salaryCreditsPerMonth: t.salaryCreditsPerMonth,
      billingCreditsByInterval: t.billingCreditsByInterval || null,
    });
    if (t.role) {
      put(t.role, {
        salaryCreditsPerMonth: t.salaryCreditsPerMonth,
        billingCreditsByInterval: t.billingCreditsByInterval || null,
      });
    }
  }

  return map;
}

function applyLocalPricingOverlay(templates) {
  const overlay = loadLocalPricingOverlayMap();
  if (!overlay.size) return templates;
  return templates.map((t) => {
    for (const k of [t.id, t.departmentId, t.bundleTemplateId, t.templateId, t.role].filter(Boolean)) {
      const p = overlay.get(k);
      if (!p) continue;
      return {
        ...t,
        salaryCreditsPerMonth: p.salaryCreditsPerMonth ?? t.salaryCreditsPerMonth,
        billingCreditsByInterval: p.billingCreditsByInterval ?? t.billingCreditsByInterval,
      };
    }
    return t;
  });
}

function normalizeCategory(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  const allowed = ['operations', 'customer', 'creative', 'growth', 'digital', 'executive'];
  return allowed.includes(raw) ? raw : 'operations';
}

function inferCategory(template = {}) {
  if (template.category) return normalizeCategory(template.category);
  const roleMap = {
    admin: 'operations',
    accounting: 'operations',
    human_resource: 'operations',
    customer_service: 'customer',
    graphic_design: 'creative',
    web_design: 'creative',
    marketing: 'growth',
    web_development: 'digital',
    it: 'digital',
  };
  return roleMap[String(template.role || '').trim().toLowerCase()] || 'operations';
}

function marketSectionFor(template = {}) {
  return inferCategory(template) === 'executive' ? 'leadership' : 'department';
}

function listInstallableBundleIds() {
  const roots = [
    path.join(__dirname, '..', '..', '..', 'server', 'bundles'),
    path.join(__dirname, '..', '..', 'server', 'bundles'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const ids = fs.readdirSync(root).filter((name) =>
      fs.existsSync(path.join(root, name, 'manifest.json')),
    );
    if (ids.length) return ids;
  }
  return [];
}

function isInstallableTemplate(template = {}) {
  if (template.installable === false) return false;
  if (template.installable === true) return true;
  const bundleId = template.bundleTemplateId || template.templateId || template.id;
  return listInstallableBundleIds().includes(bundleId);
}

function mergeDepartmentsWithCatalog(departments, technicalTemplates) {
  const techById = new Map((technicalTemplates || []).map((t) => [t.id, t]));
  return (departments || [])
    .filter((dept) => dept.active !== false)
    .map((dept) => {
      const bundleId = dept.bundleTemplateId || dept.id;
      const tech = techById.get(bundleId) || techById.get(dept.id) || {};
      const category = inferCategory({ ...tech, ...dept, category: dept.category });
      const installable = isInstallableTemplate({
        bundleTemplateId: dept.bundleTemplateId,
        templateId: bundleId,
        id: dept.id,
      });
      const visibility = dept.visibility === 'hidden' ? 'hidden' : 'public';
      const hirePasswordHash = dept.hirePasswordHash || null;
      return {
        ...tech,
        id: dept.id,
        departmentId: dept.id,
        templateId: bundleId,
        bundleTemplateId: dept.bundleTemplateId || null,
        category,
        marketSection: marketSectionFor({ category }),
        name: dept.name || tech.name || dept.id,
        tagline: dept.tagline || tech.tagline || '',
        description: dept.description || tech.description || dept.tagline || tech.tagline || '',
        examples: Array.isArray(dept.examples) && dept.examples.length
          ? dept.examples
          : tech.examples || [],
        role: dept.role || tech.role,
        salaryCreditsPerMonth: dept.salaryCreditsPerMonth ?? tech.salaryCreditsPerMonth,
        billingCreditsByInterval:
          tech.billingCreditsByInterval
          || billingCreditsFromDept(dept, tech)
          || null,
        salaryUsdPerMonth: dept.salaryUsdPerMonth ?? tech.salaryUsdPerMonth,
        featured: !!(dept.featured ?? tech.featured),
        sortOrder: Number(dept.sortOrder) || 999,
        catalogUuid: dept.catalogUuid || tech.catalogUuid || null,
        visibility,
        hidden: visibility === 'hidden',
        requiresHirePassword: visibility === 'hidden' && !!hirePasswordHash,
        hirePasswordHash,
        _hirePasswordHash: hirePasswordHash,
        installable,
      };
    })
    .filter((t) => t.installable)
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
}

function loadLocalDepartmentsMerged() {
  const deptPath = localDepartmentsSeedPath();
  if (!deptPath) return null;
  const seed = readJsonSafe(deptPath, { departments: [] });
  const catalogPath = localCatalogPath();
  const catalog = catalogPath
    ? readJsonSafe(catalogPath, { templates: [] })
    : { templates: agentCatalog.loadCatalog() };
  const merged = mergeDepartmentsWithCatalog(seed.departments, catalog.templates || []);
  return merged.length ? merged : null;
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
  if (remote?.length) {
    return applyLocalPricingOverlay(remote.filter(isInstallableTemplate));
  }
  const localMerged = loadLocalDepartmentsMerged();
  if (localMerged?.length) return localMerged;
  return agentCatalog
    .loadCatalog()
    .map((t) => ({
      ...t,
      departmentId: t.departmentId || t.id,
      category: inferCategory(t),
      marketSection: marketSectionFor(t),
      sortOrder: Number(t.sortOrder) || 999,
      installable: isInstallableTemplate(t),
    }))
    .filter(isInstallableTemplate);
}

function templateHiredKeys(template) {
  return [template.id, template.departmentId, template.bundleTemplateId, template.templateId].filter(Boolean);
}

function isTemplateHired(template, hired) {
  return templateHiredKeys(template).some((key) => hired.has(key));
}

async function catalogWithStatusMerged() {
  const templates = await loadCatalogMerged();
  const registry = require('./registry-store');
  const hired = new Set(
    registry
      .listAgents()
      .filter((a) => registry.isOnTeamAgent(a))
      .map((a) => a.templateId)
      .filter(Boolean),
  );

  return templates.map((t) => {
    const skillNames = (t.skillIds || [])
      .map((id) => agentCatalog.bundledSkillDef(id)?.name)
      .filter(Boolean);
    const mcpNames = (t.mcps || []).map((m) => m.name || m.slug).filter(Boolean);
    const category = inferCategory(t);
    return registry.enrichCatalogTemplate({
      ...t,
      category,
      marketSection: marketSectionFor({ category }),
      departmentId: t.departmentId || t.id,
      installable: isInstallableTemplate(t),
      skillNames,
      mcpNames,
      includesLabel: [
        skillNames.length ? `${skillNames.length} skill${skillNames.length === 1 ? '' : 's'}` : '',
        mcpNames.length ? `${mcpNames.length} MCP${mcpNames.length === 1 ? '' : 's'}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      hired: isTemplateHired(t, hired),
      source: ecsBaseUrl() ? 'ecs' : 'local',
    });
  });
}

module.exports = {
  ecsBaseUrl,
  fetchCatalogFromEcs,
  loadCatalogMerged,
  catalogWithStatusMerged,
  inferCategory,
  marketSectionFor,
};
