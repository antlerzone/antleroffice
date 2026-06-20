// Fetch agent catalog from ECS official API; fallback to local departments + catalog.json.

const fs = require('node:fs');
const path = require('node:path');
const agentCatalog = require('./agent-catalog');
const ceoPricing = require('./ceo-pricing');

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
      const tech = techById.get(dept.id) || techById.get(bundleId) || {};
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
    marketing_editor: 'growth',
    marketing_junior: 'growth',
    product_research: 'growth',
    sales: 'growth',
    business_development: 'growth',
    web_development: 'digital',
    it: 'digital',
    ceo: 'executive',
  };
  return roleMap[String(template.role || '').trim().toLowerCase()] || 'operations';
}

function marketSectionFor(template = {}) {
  if (template.marketSection === 'leadership' || template.marketSection === 'department') {
    return template.marketSection;
  }
  if (String(template.role || '').trim().toLowerCase() === 'ceo') return 'leadership';
  return inferCategory(template) === 'executive' ? 'leadership' : 'department';
}

function catalogIdentityKeys(template = {}) {
  const keys = new Set();
  for (const k of [template.id, template.departmentId, template.bundleTemplateId, template.templateId]) {
    if (k) keys.add(String(k));
  }
  return keys;
}

/** CEO and other built-in leadership templates — always listable without a bundle folder. */
function injectMandatoryLocalTemplates(templates) {
  const seen = new Set();
  for (const t of templates || []) {
    for (const k of catalogIdentityKeys(t)) seen.add(k);
  }
  const extras = (agentCatalog.loadCatalog() || [])
    .filter((t) => isInstallableTemplate(t) || t.role === 'ceo')
    .filter((t) => ![...catalogIdentityKeys(t)].some((k) => seen.has(k)))
    .map((t) => ({
      ...t,
      departmentId: t.departmentId || t.id,
      category: inferCategory(t),
      marketSection: marketSectionFor(t),
      sortOrder: Number(t.sortOrder) || 999,
      installable: true,
      visibility: t.visibility || 'public',
      hidden: false,
    }))
    .map((t) => ceoPricing.applyCeoCatalogPricing(t));
  if (!extras.length) return templates;
  return [...extras, ...(templates || [])].sort(
    (a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || String(a.name).localeCompare(String(b.name)),
  );
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
      const tech = techById.get(dept.id) || techById.get(bundleId) || {};
      const category = inferCategory({ ...tech, ...dept, category: dept.category });
      const installable =
        tech.installable === true
        || isInstallableTemplate({
          bundleTemplateId: dept.bundleTemplateId,
          templateId: bundleId,
          id: dept.id,
          installable: tech.installable,
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

function mergeLocalMonorepoCatalog(remoteTemplates) {
  const localMerged = loadLocalDepartmentsMerged();
  if (!localMerged?.length) return remoteTemplates || [];

  const byId = new Map((remoteTemplates || []).map((t) => [t.id, t]));
  for (const local of localMerged) {
    const remote = byId.get(local.id);
    byId.set(local.id, remote ? { ...remote, ...local } : local);
  }
  return [...byId.values()].sort(
    (a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || String(a.name).localeCompare(String(b.name)),
  );
}

async function loadCatalogMerged() {
  const remote = await fetchCatalogFromEcs();
  if (remote?.length) {
    return injectMandatoryLocalTemplates(
      mergeLocalMonorepoCatalog(applyLocalPricingOverlay(remote.filter(isInstallableTemplate))),
    );
  }
  const localMerged = loadLocalDepartmentsMerged();
  if (localMerged?.length) return injectMandatoryLocalTemplates(localMerged);
  return injectMandatoryLocalTemplates(
    agentCatalog
      .loadCatalog()
      .map((t) => ({
        ...t,
        departmentId: t.departmentId || t.id,
        category: inferCategory(t),
        marketSection: marketSectionFor(t),
        sortOrder: Number(t.sortOrder) || 999,
        installable: isInstallableTemplate(t),
      }))
      .filter(isInstallableTemplate),
  );
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
    const bundleId = t.bundleTemplateId || t.id;
    const skillNames = (t.skillIds || [])
      .map((id) => agentCatalog.skillDisplayName(id, bundleId))
      .filter(Boolean);
    const mcpNames = (t.mcps || []).map((m) => m.name || m.slug).filter(Boolean);
    const category = inferCategory(t);
    const priced = ceoPricing.applyCeoCatalogPricing({
      ...t,
      category,
      marketSection: marketSectionFor({ category, role: t.role, marketSection: t.marketSection }),
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
    return registry.enrichCatalogTemplate(priced);
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
