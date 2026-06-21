// Single source of truth for the office org chart.
// Secretary = sole external front door (OpenClaw main). CEO is hired, not seeded here.
const DEPARTMENTS = [
  {
    role: 'secretary',
    label: 'Secretary',
    charSprite: 0,
    skillId: null,
    routable: false,
  },
  {
    role: 'coo',
    label: 'COO',
    charSprite: 5,
    skillId: null,
    routable: false,
  },
  {
    role: 'antlerhub_admin',
    label: 'AntlerHub Admin',
    charSprite: 3,
    skillId: 'antlerhub_portal_admin',
    routable: true,
    match: /(antlerhub|antler hub|ota|channel manager|homestay|listing sync|system\.antlerzone)/i,
  },
  {
    role: 'coliving_admin',
    label: 'Coliving Admin',
    charSprite: 2,
    skillId: 'coliving_portal_admin',
    routable: true,
    match: /(coliving|vacant room|tenant|portal\.colivingjb|room details|colivin)/i,
  },
  {
    role: 'antlerchat_cs',
    label: 'AntlerChat Support',
    charSprite: 2,
    skillId: 'antlerchat_support',
    routable: true,
    match: /(antlerchat|antler chat|support ticket|help desk|user question)/i,
  },
  {
    role: 'customer_service',
    label: 'Customer Service Senior',
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
    match: /(design|poster|logo|banner|graphic|artwork|mockup|cover image|visual)/i,
  },
  {
    role: 'marketing_junior',
    label: 'Marketing Junior',
    charSprite: 3,
    skillId: 'fb_publish',
    routable: true,
    match: /(publish|schedule|upload|\bfb\b|facebook|xhs|小红书|post to group|fb group)/i,
  },
  {
    role: 'marketing_editor',
    label: 'Marketing Editor',
    charSprite: 3,
    skillId: 'copy_editor',
    routable: true,
    match: /(copy|caption|write post|draft|edit copy|文案|润色|headline|hashtag)/i,
  },
  {
    role: 'marketing',
    label: 'Marketing Manager',
    charSprite: 3,
    skillId: 'marketing_strategist',
    routable: true,
    match: /(marketing manager|campaign plan|channel mix|marketing strategy|quarterly promo|sign-off|multi-platform)/i,
  },
  {
    role: 'accounting',
    label: 'Accounting Manager',
    charSprite: 1,
    skillId: 'financial_planner',
    routable: true,
    match: /(account|invoice|finance|tax|payroll|expense|report|budget|bookkeep|reconcil)/i,
  },
  {
    role: 'admin',
    label: 'Admin Manager',
    charSprite: 2,
    skillId: 'admin_assistant',
    routable: true,
    match: /(admin|schedule|form|document|spreadsheet|organize|filing|meeting notes|agenda)/i,
  },
  {
    role: 'it',
    label: 'IT Coding',
    charSprite: 1,
    skillId: 'general',
    routable: true,
    match: /(it|agent|automation|script|build|code|crawler|technical|bug|fix|deploy)/i,
  },
  {
    role: 'human_resource',
    label: 'AntlerOffice Human Resource',
    charSprite: 2,
    skillId: 'create_saas_worker',
    routable: true,
    match: /(create npc|创建.*worker|上架|catalog|saas|new template|worker template|human resource|\bhr\b)/i,
  },
  {
    role: 'sales',
    label: 'Sales Senior',
    charSprite: 3,
    skillId: 'sales_strategist',
    routable: true,
    match: /(sales|pipeline|outbound|prospect|quota|crm|deal|revenue|pricing strategy)/i,
  },
  {
    role: 'business_development',
    label: 'Business Development Manager',
    charSprite: 3,
    skillId: 'bd_manager',
    routable: true,
    match: /(business development|\bbd\b|partnership|channel partner|reseller|negotiat|alliance)/i,
  },
  {
    role: 'product_research',
    label: 'Product Research',
    charSprite: 4,
    skillId: 'product_researcher',
    routable: true,
    match: /(competitor|competitive|product research|market research|benchmark|positioning|rival)/i,
  },
];

function byRole(role) {
  const normalized = role === 'ceo' ? 'coo' : role;
  return DEPARTMENTS.find((d) => d.role === normalized) || null;
}

function residents() {
  return DEPARTMENTS;
}

// Built-in office NPCs on boot: Secretary (free front door) + COO station (vacant until hired).
function defaults() {
  return DEPARTMENTS.filter((d) => d.role === 'secretary' || d.role === 'coo');
}

function route(instruction) {
  const text = String(instruction || '');
  for (const d of DEPARTMENTS) {
    if (d.routable && d.match && d.match.test(text)) return d;
  }
  return byRole('it');
}

module.exports = { DEPARTMENTS, byRole, residents, defaults, route };
