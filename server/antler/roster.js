// Single source of truth for the office org chart.
// Each entry = one NPC employee (role) with the skill it performs.
// `match` keywords route a boss instruction to the right department.
const DEPARTMENTS = [
  {
    role: 'secretary',
    label: 'Reception',
    charSprite: 0,
    skillId: null,
    routable: false,
  },
  {
    role: 'coo',
    label: 'COO · OpenClaw',
    charSprite: 5,
    skillId: null,
    routable: false,
  },
  {
    role: 'customer_service',
    label: 'Customer Service',
    charSprite: 2,
    skillId: 'customer_service',
    routable: true,
    match: /(customer|reply|complain|support|inquiry|ticket)/i,
  },
  {
    role: 'graphic_design',
    label: 'Graphic Design',
    charSprite: 4,
    skillId: 'graphic_design',
    routable: true,
    match: /(design|poster|logo|banner|graphic|artwork|mockup)/i,
  },
  {
    role: 'marketing',
    label: 'Marketing',
    charSprite: 3,
    skillId: 'marketing',
    routable: true,
    match: /(market|\bpost\b|posting|caption|campaign|promo|copywriting)/i,
  },
  {
    role: 'accounting',
    label: 'Accounting',
    charSprite: 1,
    skillId: 'accounting',
    routable: true,
    match: /(account|invoice|finance|tax|payroll|expense|report)/i,
  },
  {
    role: 'admin',
    label: 'Admin',
    charSprite: 2,
    skillId: 'admin',
    routable: true,
    match: /(admin|schedule|form|document|spreadsheet|organize|filing)/i,
  },
  {
    role: 'it',
    label: 'IT',
    charSprite: 1,
    skillId: 'general',
    routable: true,
    match: /(it|agent|automation|script|build|code|crawler|technical)/i,
  },
  {
    role: 'human_resource',
    label: 'AntlerOffice Human Resource',
    charSprite: 2,
    skillId: 'create_saas_worker',
    routable: true,
    match: /(create npc|创建.*worker|上架|catalog|saas|new template|worker template|human resource|\bhr\b)/i,
  },
];

function byRole(role) {
  return DEPARTMENTS.find((d) => d.role === role) || null;
}

function residents() {
  return DEPARTMENTS;
}

// NPCs seeded into the office on boot. Only the COO · OpenClaw supervisor is a
// built-in default; every other role is a worker the client hires (adds) itself.
// The rest of DEPARTMENTS stays as a keyword→skill catalog used by route().
function defaults() {
  return DEPARTMENTS.filter((d) => d.role === 'coo');
}

// Pick the department that best matches the instruction; default to IT.
function route(instruction) {
  const text = String(instruction || '');
  for (const d of DEPARTMENTS) {
    if (d.routable && d.match && d.match.test(text)) return d;
  }
  return byRole('it');
}

module.exports = { DEPARTMENTS, byRole, residents, defaults, route };
