/**
 * NPC Onboarding Configs
 *
 * Each NPC in the catalog can have an onboarding config.
 * The wizard reads this and renders the appropriate steps.
 *
 * To add onboarding for a new NPC:
 *   1. Add an entry to NPC_ONBOARDING_CONFIGS keyed by the template ID
 *   2. Define steps (choice, api_credentials, browser_login, info)
 *   3. Optionally add role-specific personality traits
 *
 * No code changes needed in the wizard — it reads this file dynamically.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PersonalityTrait {
  id: string
  label: string
  emoji: string
}

export interface OnboardingChoice {
  value: string
  label: string
  emoji?: string
  hint?: string
}

export interface OnboardingField {
  /** 'username' and 'password' map directly to web-accounts-store fields */
  key: 'username' | 'password' | string
  label: string
  placeholder?: string
  type: 'text' | 'password'
  prefix?: string
  suffix?: string
  /** hint shown below the field */
  hint?: string
}

export type OnboardingStepType =
  | 'choice'          // radio / card selection
  | 'api_credentials' // form with username + password (saves to web-accounts-store)
  | 'browser_login'   // opens Chrome, waits for boss to log in
  | 'info'            // read-only information panel
  | 'env_setup'       // detect + auto-install a desktop tool (Electron only)

export interface OnboardingStep {
  id: string
  type: OnboardingStepType
  /** Step title (shown in header) */
  title?: string
  /** Main question or instruction */
  question?: string
  /** Supporting text below question */
  hint?: string
  /** Show this step only if a prior step's answer matches */
  showWhen?: { stepId: string; value: string | string[] }
  /** For 'choice' type */
  options?: OnboardingChoice[]
  /** For 'api_credentials' type */
  fields?: OnboardingField[]
  /** For 'api_credentials': which platform this credential belongs to */
  credentialWebsite?: string
  credentialWebsiteUrl?: string
  /** For 'browser_login': platform key (facebook, xhs, instagram...) */
  platform?: string
  platformUrl?: string
  /** Inline tutorial text shown in collapsible panel */
  tutorialSteps?: string[]
  /** Whether this step can be skipped */
  optional?: boolean
  /** For 'env_setup': which desktop tool to detect / install */
  tool?: 'node' | 'appium' | 'adb' | 'android_studio'
  /** For 'env_setup'/'info': a download page to open as fallback */
  downloadUrl?: string
  /**
   * For 'api_credentials' steps: after saving the account, also call
   * POST /api/onboard/mcp-pack/apply with these extra body params.
   * Key = field key in credFields, value = body param name in the API.
   * e.g. { password: 'glifApiKey', enableGraphicDesign: 'true' }
   */
  mcpApplyParams?: Record<string, string>
  /** 候选 MCP：存完账号后只安装这一个 slug（没选的不装） */
  installsMcp?: string
}

export interface NpcOnboardingConfig {
  templateId: string
  /** NPC's greeting message on the intro screen */
  greeting: string
  /** What this NPC can do — shown on done screen */
  capabilities: string[]
  /** Example command boss can say to COO */
  completionHint: string
  /** Extra personality traits specific to this role */
  extraPersonality?: PersonalityTrait[]
  /** Setup steps beyond intro + personality */
  steps: OnboardingStep[]
}

// ── Common personality pool (all NPCs draw from this) ─────────────────────────

export const COMMON_PERSONALITY_POOL: PersonalityTrait[] = [
  { id: 'detail_oriented', label: '细心仔细', emoji: '🔍' },
  { id: 'proactive',       label: '主动积极', emoji: '⚡' },
  { id: 'methodical',      label: '有条不紊', emoji: '📋' },
  { id: 'humorous',        label: '幽默风趣', emoji: '😄' },
  { id: 'efficient',       label: '简洁高效', emoji: '🚀' },
  { id: 'warm',            label: '温暖亲切', emoji: '🤝' },
  { id: 'rigorous',        label: '严谨认真', emoji: '🎯' },
  { id: 'creative',        label: '创意无限', emoji: '💡' },
  { id: 'reliable',        label: '稳重可靠', emoji: '⚓' },
  { id: 'energetic',       label: '活力满满', emoji: '🌟' },
]

// ── Shared: CEO coding-comprehension level ────────────────────────────────────
// Asked when onboarding any IT-department role. The answer is the CEO's OWN
// technical level (not the NPC's) and is saved globally as dev.ceoCodingLevel —
// every COO→CEO report then adapts its explanation depth to this level.
export const CODING_LEVEL_STEP: OnboardingStep = {
  id: 'coding_level',
  type: 'choice',
  question: '在开始前 — 您对编程 / 技术的了解程度是？',
  hint: '选好后，COO 以后跟您汇报任何技术相关的事，都会自动用最适合您的讲法。选错了也没关系——之后随时跟 COO 说「我看不懂，讲简单点」或「把我的技术等级改成开发者」就能改。',
  options: [
    { value: '1', label: '完全不懂', emoji: '🐣', hint: '不带任何代码名词，全大白话；您只需点头 / 摇头' },
    { value: '2', label: '懂一点',   emoji: '🌱', hint: '认得一些术语，不确定时可以随时追问' },
    { value: '3', label: '我是开发者', emoji: '🦾', hint: '技术细节直接讲，不用简化' },
  ],
}

// AI 视频生成（Motion）——三个 IT 角色共用，请人时问一次
export const MOTION_VIDEO_STEP: OnboardingStep = {
  id: 'enable_motion_video',
  type: 'choice',
  question: '要开启 AI 视频生成（Motion）吗？',
  hint: '用一句话生成产品演示片、宣传片、Logo 动画等。需要登录 Motion 账号、按用量计费。默认不开；之后随时跟 COO 说「开启 / 关闭视频生成」都能改。',
  optional: true,
  options: [
    { value: 'no',  label: '暂时不开（推荐）', emoji: '🚫', hint: '需要时再开，先不占额度' },
    { value: 'yes', label: '现在开启',         emoji: '🎬', hint: '第一次使用时会弹出让您登录 Motion 账号' },
  ],
}

const MOTION_ENABLED_NOTE: OnboardingStep = {
  id: 'motion_enabled_note',
  type: 'info',
  showWhen: { stepId: 'enable_motion_video', value: 'yes' },
  title: '已开启视频生成',
  hint: '第一次让 TA 做视频时，会弹出浏览器请您登录 Motion 账号并授权；之后就能直接用。费用走您的 Motion 账号额度。',
  optional: true,
}

// ── NPC Onboarding Configs ────────────────────────────────────────────────────

const NPC_ONBOARDING_CONFIGS: Record<string, NpcOnboardingConfig> = {

  // ── COO ───────────────────────────────────────────────────────────────────
  ceo: {
    templateId: 'ceo',
    greeting: '您好老板！很荣幸担任公司的 COO。我会帮您制定战略、规划任务、并带领团队执行。',
    capabilities: ['制定公司战略', '规划季度目标', '协调各部门工作', '分析经营成果'],
    completionHint: '跟 COO 说：「帮我分析下这个季度的方向」',
    extraPersonality: [
      { id: 'strategic', label: '战略眼光', emoji: '♟️' },
      { id: 'decisive',  label: '果断决策', emoji: '⚡' },
    ],
    steps: [
      {
        id: 'company_focus',
        type: 'choice',
        question: '您公司目前最想专注在哪个方向？',
        hint: '这会帮助我优先处理最重要的事情',
        optional: true,
        options: [
          { value: 'growth',     label: '业务增长',   emoji: '📈' },
          { value: 'operations', label: '运营优化',   emoji: '⚙️' },
          { value: 'product',    label: '产品开发',   emoji: '🛠️' },
          { value: 'team',       label: '团队建设',   emoji: '👥' },
          { value: 'finance',    label: '财务管控',   emoji: '💰' },
        ],
      },
    ],
  },

  // ── Accounting Manager ────────────────────────────────────────────────────
  accounting_manager: {
    templateId: 'accounting_manager',
    greeting: '老板好！我是您的会计经理，负责记账、对账和财务报告。在开始之前，想了解一下您的财务工具。',
    capabilities: ['开发票', '记录收款', '月末对账', '查询财务报表'],
    completionHint: '跟 COO 说：「叫会计经理帮 ABC 公司开一张 RM100 的发票」',
    extraPersonality: [
      { id: 'precise',  label: '精确严谨', emoji: '🔢' },
      { id: 'discreet', label: '保密谨慎', emoji: '🔒' },
    ],
    steps: [
      {
        id: 'software',
        type: 'choice',
        question: '您公司目前用什么软件记账？',
        hint: '选好了我就能直接连接，不需要每次告诉我怎么登录',
        options: [
          { value: 'bukku',        label: 'Bukku',       emoji: '📊', hint: '马来西亚本地会计软件' },
          { value: 'xero',         label: 'Xero',        emoji: '📈' },
          { value: 'quickbooks',   label: 'QuickBooks',  emoji: '💼' },
          { value: 'sql',          label: 'SQL Account', emoji: '🗂️', hint: '马来西亚本地 ERP' },
          { value: 'spreadsheet',  label: 'Excel / Google Sheet', emoji: '📝' },
          { value: 'none',         label: '还没有',      emoji: '❓' },
        ],
      },
      {
        id: 'connect_bukku',
        type: 'api_credentials',
        showWhen: { stepId: 'software', value: 'bukku' },
        title: '连接您的 Bukku 账号',
        hint: '需要两样东西，在 Bukku → Control Panel → Integrations 里找到',
        credentialWebsite: 'bukku',
        installsMcp: 'bukku',
        fields: [
          {
            key: 'username',
            label: '公司网址前缀',
            placeholder: 'companyabc',
            suffix: '.bukku.my',
            type: 'text',
            hint: '例如 https://companyabc.bukku.my，填 companyabc',
          },
          {
            key: 'password',
            label: '连接密钥（Access Token）',
            placeholder: '粘贴您的 Access Token',
            type: 'password',
            hint: 'Control Panel → Integrations → 开启 API Access → 复制 Token',
          },
        ],
        tutorialSteps: [
          '登录您的 Bukku 账号',
          '点击右上角头像 → Control Panel',
          '找到 Integrations → 开启 API Access 开关 → Save',
          '复制 Access Token，粘贴到上方',
        ],
        optional: true,
      },
      {
        id: 'connect_xero',
        type: 'info',
        showWhen: { stepId: 'software', value: 'xero' },
        title: 'Xero 连接',
        hint: 'Xero 使用 OAuth 授权。请告诉 COO「帮我连接 Xero」，COO 会引导您完成授权流程。',
        optional: true,
      },
      {
        id: 'multi_company',
        type: 'choice',
        showWhen: { stepId: 'software', value: ['bukku', 'xero', 'quickbooks', 'sql'] },
        question: '您需要管理多家公司的账目吗？',
        hint: '例如您是会计事务所，管理多个客户',
        optional: true,
        options: [
          { value: 'single', label: '只有一家公司', emoji: '🏢' },
          { value: 'multi',  label: '多家公司',     emoji: '🏙️', hint: '可稍后在「账号管理」里批量添加' },
        ],
      },
    ],
  },

  // ── Marketing Manager ─────────────────────────────────────────────────────
  marketing_manager: {
    templateId: 'marketing_manager',
    greeting: '老板好！我是市场经理，负责制定内容计划、协调发布节奏、带领编辑和设计团队。先了解一下您的业务。',
    capabilities: ['制定内容日历', '审核文案和设计', '协调多平台发布', '分析营销效果'],
    completionHint: '跟 COO 说：「叫市场经理帮我制定下周的内容计划」',
    extraPersonality: [
      { id: 'trend_aware', label: '洞察趋势', emoji: '📡' },
      { id: 'storyteller', label: '擅长叙事', emoji: '✍️' },
    ],
    steps: [
      {
        id: 'platforms',
        type: 'choice',
        question: '您主要在哪些平台做营销？',
        hint: '可以选多个，我会重点关注这些渠道',
        optional: true,
        options: [
          { value: 'facebook',   label: 'Facebook',  emoji: '📘' },
          { value: 'instagram',  label: 'Instagram', emoji: '📸' },
          { value: 'xhs',        label: '小红书',    emoji: '📕' },
          { value: 'tiktok',     label: 'TikTok',    emoji: '🎵' },
          { value: 'linkedin',   label: 'LinkedIn',  emoji: '💼' },
          { value: 'email',      label: '电子邮件',  emoji: '📧' },
        ],
      },
      {
        id: 'industry',
        type: 'choice',
        question: '您的主要业务是？',
        hint: '这样我能用更准确的行业语言写内容',
        optional: true,
        options: [
          { value: 'retail',    label: '零售 / 电商',   emoji: '🛍️' },
          { value: 'fnb',       label: '餐饮 / F&B',    emoji: '🍽️' },
          { value: 'services',  label: '专业服务',       emoji: '⚖️' },
          { value: 'property',  label: '房地产',         emoji: '🏠' },
          { value: 'education', label: '教育',           emoji: '📚' },
          { value: 'tech',      label: '科技 / SaaS',    emoji: '💻' },
          { value: 'other',     label: '其他',           emoji: '❓' },
        ],
      },
    ],
  },

  // ── Marketing Editor ──────────────────────────────────────────────────────
  marketing_editor: {
    templateId: 'marketing_editor',
    greeting: '老板好！我是内容编辑，专门负责写文案、做标题、打磨发布前的每一篇内容。',
    capabilities: ['写社媒文案', '起内容标题', '审核发布内容', '多语言撰写'],
    completionHint: '跟 COO 说：「叫编辑帮我写一篇 Facebook 新品推广文案」',
    steps: [
      {
        id: 'language',
        type: 'choice',
        question: '您的内容主要用什么语言？',
        hint: '我会默认用这个语言写，除非另有要求',
        optional: true,
        options: [
          { value: 'zh', label: '中文',       emoji: '🀄' },
          { value: 'en', label: 'English',    emoji: '🇬🇧' },
          { value: 'ms', label: 'Bahasa',     emoji: '🇲🇾' },
          { value: 'mix', label: '中英夹杂',  emoji: '🔀', hint: '马来西亚常见风格' },
        ],
      },
      {
        id: 'tone',
        type: 'choice',
        question: '您品牌的内容风格？',
        optional: true,
        options: [
          { value: 'casual',      label: '轻松亲切', emoji: '😊' },
          { value: 'professional', label: '专业正式', emoji: '👔' },
          { value: 'playful',     label: '活泼有趣', emoji: '🎉' },
          { value: 'luxury',      label: '高端优雅', emoji: '✨' },
        ],
      },
    ],
  },

  // ── Marketing Junior ──────────────────────────────────────────────────────
  marketing_junior: {
    templateId: 'marketing_junior',
    greeting: '老板好！我是市场助理，专门负责把内容上传到 Facebook 和小红书，按时发布不延误！',
    capabilities: ['上传 Facebook 帖子', '发布小红书笔记', '按计划表执行发布', '记录发布状态'],
    completionHint: '跟 COO 说：「叫市场助理把这篇文案发到小红书」',
    steps: [
      {
        id: 'fb_account',
        type: 'choice',
        question: '需要连接 Facebook 账号吗？',
        hint: '连接后我才能帮您发帖，不连接也可以稍后设置',
        optional: true,
        options: [
          { value: 'yes', label: '现在连接', emoji: '🔗', hint: '会打开 Chrome，您自己登录' },
          { value: 'no',  label: '稍后再说', emoji: '⏳' },
        ],
      },
      {
        id: 'connect_facebook',
        type: 'browser_login',
        showWhen: { stepId: 'fb_account', value: 'yes' },
        title: '连接 Facebook',
        question: '点击下方按钮，Chrome 会打开 Facebook 登录页。\n登录完成后回来点「完成」。',
        platform: 'facebook',
        platformUrl: 'https://www.facebook.com',
        optional: true,
      },
      {
        id: 'xhs_account',
        type: 'choice',
        question: '需要连接小红书账号吗？',
        optional: true,
        options: [
          { value: 'yes', label: '现在连接', emoji: '🔗' },
          { value: 'no',  label: '稍后再说', emoji: '⏳' },
        ],
      },
      {
        id: 'connect_xhs',
        type: 'browser_login',
        showWhen: { stepId: 'xhs_account', value: 'yes' },
        title: '连接小红书',
        question: '点击下方按钮，Chrome 会打开小红书登录页。\n登录完成后回来点「完成」。',
        platform: 'xhs',
        platformUrl: 'https://www.xiaohongshu.com',
        optional: true,
      },
    ],
  },

  // ── Sales Senior ──────────────────────────────────────────────────────────
  sales_senior: {
    templateId: 'sales_senior',
    greeting: '老板好！我是销售经理，负责分析客户画像、管理销售漏斗、制定拓客策略。',
    capabilities: ['分析目标客户', '制定销售策略', '管理销售漏斗', '追踪成交进度'],
    completionHint: '跟 COO 说：「叫销售经理帮我分析这个月的线索质量」',
    extraPersonality: [
      { id: 'persuasive', label: '善于说服', emoji: '💬' },
      { id: 'goal_driven', label: '目标导向', emoji: '🎯' },
    ],
    steps: [
      {
        id: 'sales_channel',
        type: 'choice',
        question: '您主要通过什么渠道获客？',
        optional: true,
        options: [
          { value: 'referral',  label: '转介绍',    emoji: '🤝' },
          { value: 'social',    label: '社交媒体',  emoji: '📱' },
          { value: 'cold',      label: '主动开发',  emoji: '📞' },
          { value: 'inbound',   label: '内容引流',  emoji: '📥' },
          { value: 'events',    label: '活动展会',  emoji: '🎪' },
        ],
      },
      {
        id: 'crm',
        type: 'choice',
        question: '您用什么管理客户资料？',
        optional: true,
        options: [
          { value: 'excel',      label: 'Excel / Sheet', emoji: '📊' },
          { value: 'notion',     label: 'Notion',        emoji: '📝' },
          { value: 'hubspot',    label: 'HubSpot',       emoji: '🟠' },
          { value: 'salesforce', label: 'Salesforce',    emoji: '☁️' },
          { value: 'none',       label: '还没有',        emoji: '❓' },
        ],
      },
    ],
  },

  // ── Customer Service Senior ───────────────────────────────────────────────
  customer_service_senior: {
    templateId: 'customer_service_senior',
    greeting: '老板好！我是客服主管，负责处理客户问题、编写 FAQ、培训回复话术。让我了解一下您的客服场景。',
    capabilities: ['撰写客服回复', '建立 FAQ 库', '处理投诉升级', '多渠道支持'],
    completionHint: '跟 COO 说：「叫客服帮我回复这个客户的投诉」',
    steps: [
      {
        id: 'support_channel',
        type: 'choice',
        question: '客户主要通过什么联系您？',
        optional: true,
        options: [
          { value: 'whatsapp', label: 'WhatsApp', emoji: '💬' },
          { value: 'email',    label: '电子邮件', emoji: '📧' },
          { value: 'facebook', label: 'Facebook', emoji: '📘' },
          { value: 'phone',    label: '电话',     emoji: '📞' },
          { value: 'chat',     label: '网站聊天', emoji: '🌐' },
        ],
      },
      {
        id: 'response_style',
        type: 'choice',
        question: '您希望客服的回复风格是？',
        optional: true,
        options: [
          { value: 'friendly',     label: '亲切友好', emoji: '😊' },
          { value: 'professional', label: '专业正式', emoji: '👔' },
          { value: 'empathetic',   label: '感同身受', emoji: '💙' },
          { value: 'concise',      label: '简洁直接', emoji: '⚡' },
        ],
      },
    ],
  },

  // ── Admin Manager ─────────────────────────────────────────────────────────
  admin_manager: {
    templateId: 'admin_manager',
    greeting: '老板好！我是行政主管，负责安排日程、整理文件、记录会议、处理内部事务。',
    capabilities: ['安排会议日程', '整理会议记录', '管理文件', '跟进行动项'],
    completionHint: '跟 COO 说：「叫行政帮我整理昨天会议的行动项」',
    steps: [
      {
        id: 'calendar_tool',
        type: 'choice',
        question: '您用什么日历工具？',
        optional: true,
        options: [
          { value: 'google',   label: 'Google Calendar', emoji: '📅' },
          { value: 'outlook',  label: 'Outlook',         emoji: '📆' },
          { value: 'apple',    label: 'Apple Calendar',  emoji: '🍎' },
          { value: 'notion',   label: 'Notion',          emoji: '📝' },
          { value: 'none',     label: '不用日历',         emoji: '❓' },
        ],
      },
    ],
  },

  // ── Business Development Manager ──────────────────────────────────────────
  business_development_manager: {
    templateId: 'business_development_manager',
    greeting: '老板好！我是业务拓展经理，负责挖掘合作机会、搭建渠道关系、推进商业谈判。',
    capabilities: ['分析合作机会', '撰写商业提案', '管理合作管线', '推进谈判策略'],
    completionHint: '跟 COO 说：「叫 BD 经理找 3 个潜在分销合作伙伴」',
    extraPersonality: [
      { id: 'networker',   label: '善于社交', emoji: '🤝' },
      { id: 'analytical',  label: '数据思维', emoji: '📊' },
    ],
    steps: [
      {
        id: 'bd_focus',
        type: 'choice',
        question: '您目前最想拓展的方向？',
        optional: true,
        options: [
          { value: 'distribution', label: '分销渠道',   emoji: '🔗' },
          { value: 'enterprise',   label: '企业客户',   emoji: '🏢' },
          { value: 'partnership',  label: '品牌合作',   emoji: '🤝' },
          { value: 'geographic',   label: '地区扩张',   emoji: '🗺️' },
          { value: 'digital',      label: '数字渠道',   emoji: '💻' },
        ],
      },
    ],
  },

  // ── Product Research ──────────────────────────────────────────────────────
  product_research: {
    templateId: 'product_research',
    greeting: '老板好！我是产品研究员，负责竞品分析、市场调研、用户反馈整理，帮您做更好的产品决策。',
    capabilities: ['竞品分析', '市场调研报告', '用户痛点梳理', '产品定位建议'],
    completionHint: '跟 COO 说：「叫产品研究员分析我们的三个主要竞争对手」',
    steps: [
      {
        id: 'research_focus',
        type: 'choice',
        question: '您最想研究哪个方向？',
        optional: true,
        options: [
          { value: 'competitors', label: '竞品分析',  emoji: '🔍' },
          { value: 'market',      label: '市场机会',  emoji: '📈' },
          { value: 'users',       label: '用户需求',  emoji: '👥' },
          { value: 'trends',      label: '行业趋势',  emoji: '📡' },
          { value: 'pricing',     label: '定价策略',  emoji: '💰' },
        ],
      },
    ],
  },

  // ── Human Resource ────────────────────────────────────────────────────────
  human_resource: {
    templateId: 'human_resource',
    greeting: '老板好！我是人力资源专员，负责为您的 AntlerOffice 创建新的 NPC 员工模板。',
    capabilities: ['设计 NPC 员工模板', '编写技能包', '创建部门配置', '管理员工目录'],
    completionHint: '跟 COO 说：「叫 HR 帮我创建一个小红书专员 NPC」',
    steps: [
      {
        id: 'first_npc',
        type: 'choice',
        question: '您最想先创建什么类型的 NPC？',
        optional: true,
        options: [
          { value: 'social',   label: '社媒专员',   emoji: '📱', hint: '小红书、抖音、FB' },
          { value: 'finance',  label: '财务会计',   emoji: '💰' },
          { value: 'cs',       label: '客服专员',   emoji: '💬' },
          { value: 'ops',      label: '运营助理',   emoji: '⚙️' },
          { value: 'custom',   label: '自定义角色', emoji: '✨' },
        ],
      },
    ],
  },

  // ── Security Worker ───────────────────────────────────────────────────────
  agent_security: {
    templateId: 'agent_security',
    greeting: '老板好！我是安全自动化 worker，负责在手机上自动跑门禁/访客/物业系统的活。开工前需要先把运行环境装好、把手机连上。',
    capabilities: ['自动跑 iCares/Veemios/eCommunity/GProp/Klik Asia', '访客/房产登记自动化', '结果上传云端', '心跳与任务轮询'],
    completionHint: '环境装好、手机连上后，我会自动领到一个 worker 编号并开始接 job。',
    steps: [
      {
        id: 'env_intro',
        type: 'info',
        title: '第一步：了解需要装什么',
        question: '我需要以下三样工具才能工作：',
        tutorialSteps: [
          'Android Studio —— 含安卓 SDK 与模拟器',
          'ADB —— 电脑和手机对话的桥（随 Android Studio 一起装）',
          'Appium —— 帮我自动点手机的引擎',
        ],
      },
      {
        id: 'install_android_studio',
        type: 'env_setup',
        tool: 'android_studio',
        optional: true,
        title: '第二步：装 Android Studio',
        question: '点「打开下载页」下载 Android Studio，一路下一步装好即可。',
        downloadUrl: 'https://developer.android.com/studio',
        tutorialSteps: [
          '下载后运行安装器，勾选 Android SDK / Platform-Tools',
          '装完打开一次，让它补齐 SDK 组件',
        ],
      },
      {
        id: 'verify_adb',
        type: 'env_setup',
        tool: 'adb',
        optional: true,
        title: '第三步：确认 ADB 能用',
        question: '点「检测」看 ADB 装好没；没有就点「打开下载页」装 platform-tools。',
        downloadUrl: 'https://developer.android.com/tools/releases/platform-tools',
        tutorialSteps: [
          'Platform-Tools 一般随 Android Studio 一起装好',
          '若检测不到，把 platform-tools 目录加进系统 PATH',
        ],
      },
      {
        id: 'check_node',
        type: 'env_setup',
        tool: 'node',
        optional: true,
        title: '第四步：装 Node.js',
        question: '点「检测」看 Node 装好没；没有就点「自动安装」（用 winget）。',
        downloadUrl: 'https://nodejs.org/',
        tutorialSteps: ['Appium 依赖 Node.js', '自动安装失败时可点下载页手动装'],
      },
      {
        id: 'install_appium',
        type: 'env_setup',
        tool: 'appium',
        optional: true,
        title: '第五步：装 Appium',
        question: '点「检测」看 Appium 装好没；没有就点「自动安装」（npm i -g appium）。',
        downloadUrl: 'https://appium.io/',
        tutorialSteps: [
          '需要先装好 Node.js',
          '装完会自动补 uiautomator2 驱动',
        ],
      },
      {
        id: 'connect_phone',
        type: 'info',
        title: '第六步：连上手机',
        question: '用数据线把安卓手机插到电脑，开启「USB 调试」。',
        tutorialSteps: [
          '手机：设置 → 关于手机 → 连点版本号 7 次打开开发者选项',
          '开发者选项里打开「USB 调试」，插线后手机上点「允许」',
          '插好后我会自动认到这台机、分配一个 worker 编号',
        ],
      },
    ],
  },

  // ── Graphic Design ────────────────────────────────────────────────────────
  graphic_design: {
    templateId: 'graphic_design',
    greeting: '老板好！我是像素艺术设计师，专门为您的 AntlerOffice NPC 创建独特的角色外观！',
    capabilities: ['设计 NPC 像素皮肤', '创建角色外观', '商业授权设计', '风格定制', 'AI 生图工作流'],
    completionHint: '跟 COO 说：「叫设计师给我的会计 NPC 做一个绿色系皮肤」',
    extraPersonality: [
      { id: 'creative', label: '创意无限', emoji: '🎨' },
      { id: 'aesthetic', label: '美感敏锐', emoji: '✨' },
    ],
    steps: [
      {
        id: 'art_style',
        type: 'choice',
        question: '您偏好什么风格的 NPC 外观？',
        optional: true,
        options: [
          { value: 'professional', label: '商务专业', emoji: '👔' },
          { value: 'cute',         label: '可爱萌系', emoji: '🐱' },
          { value: 'cool',         label: '酷炫个性', emoji: '😎' },
          { value: 'fantasy',      label: '奇幻风格', emoji: '🧙' },
        ],
      },
      {
        id: 'glif_setup',
        type: 'choice',
        question: '是否为设计师安装 Glif AI 生图工具？',
        hint: 'Glif 让设计师能直接调用 AI 图像生成、风格转换等工作流，无需另外配置模型。',
        options: [
          { value: 'yes', label: '安装 Glif', emoji: '🎨', hint: '需要 Glif API Key' },
          { value: 'no',  label: '先跳过',    emoji: '⏭️', hint: '之后可在 Integrations → MCP 手动添加' },
        ],
      },
      {
        id: 'glif_api_key',
        type: 'api_credentials',
        title: '连接 Glif AI 工作流',
        question: '请输入您的 Glif API Key',
        hint: '从 glif.app/settings/api-tokens 获取 API Token，粘贴到下方即可。',
        showWhen: { stepId: 'glif_setup', value: 'yes' },
        credentialWebsite: 'glif',
        credentialWebsiteUrl: 'https://glif.app/settings/api-tokens',
        fields: [
          {
            key: 'password',
            label: 'Glif API Token',
            placeholder: 'Bearer glif_...',
            type: 'password',
            hint: '在 glif.app → Settings → API Tokens 里生成',
          },
        ],
        tutorialSteps: [
          '打开 glif.app 并登录您的账号',
          '点击右上角头像 → Settings → API Tokens',
          '点击「Create Token」生成新的 API Token',
          '复制 Token（以 Bearer 开头）并贴到下方',
        ],
        mcpApplyParams: { password: 'glifApiKey', _enableGraphicDesign: 'true' },
        optional: true,
      },
    ],
  },

  // ── IT Guys ───────────────────────────────────────────────────────────────
  // Note: IT / Dev templates already have ItGuysSetupModal for API key config.
  // We add personality + context here; ItGuysSetupModal handles the actual keys.
  it_guys: {
    templateId: 'it_guys',
    greeting: '老板好！我是 IT 专员，负责配置 MCP 工具、写自动化脚本、处理技术集成问题。',
    capabilities: ['配置 MCP 工具', '编写自动化脚本', '处理 API 集成', '系统维护排查'],
    completionHint: '跟 COO 说：「叫 IT 帮我配置 Slack MCP 工具」',
    extraPersonality: [
      { id: 'technical', label: '技术专精', emoji: '⌨️' },
      { id: 'problem_solver', label: '解决问题', emoji: '🔧' },
    ],
    steps: [CODING_LEVEL_STEP],
  },

  // ── IT Engineer (A · all-rounder) ─────────────────────────────────────────
  it_allrounder: {
    templateId: 'it_allrounder',
    greeting: '老板好！我是您的全能 IT 工程师，本地写代码、改网页、做小工具，写完会自己先审一遍再交。',
    capabilities: ['本地写功能代码', '改网页 / 写小工具', '写完自审一遍', 'Git 提交（上传需您批准）'],
    completionHint: '跟 COO 说：「叫 IT 工程师帮我加一个导出按钮」',
    extraPersonality: [
      { id: 'technical',  label: '技术专精', emoji: '⌨️' },
      { id: 'systematic', label: '系统思维', emoji: '🧩' },
    ],
    steps: [CODING_LEVEL_STEP, MOTION_VIDEO_STEP, MOTION_ENABLED_NOTE],
  },

  // ── IT Reviewer (B · 复查 + 测试) ─────────────────────────────────────────
  it_reviewer: {
    templateId: 'it_reviewer',
    greeting: '老板好！我是代码复查员，IT 工程师写完后我再查第二遍、真跑测试，不过关就打回重写。',
    capabilities: ['复查代码改动', '真跑项目测试', '不过关打回重写', '只读、绝不动手改'],
    completionHint: '跟 COO 说：「这次让复查员把关再上传」',
    extraPersonality: [
      { id: 'rigorous', label: '严谨认真', emoji: '🎯' },
      { id: 'detail_oriented', label: '细心仔细', emoji: '🔍' },
    ],
    steps: [CODING_LEVEL_STEP, MOTION_VIDEO_STEP, MOTION_ENABLED_NOTE],
  },

  cursor_developer: {
    templateId: 'cursor_developer',
    greeting: '老板好！我是 Cursor 开发工程师，负责用 Cursor CLI 写代码、审查代码、提交功能。',
    capabilities: ['用 Cursor 写功能代码', '代码审查', 'Git 提交', '技术文档'],
    completionHint: '跟 COO 说：「叫开发工程师修复登录页面的 bug」',
    extraPersonality: [
      { id: 'technical',  label: '技术专精', emoji: '⌨️' },
      { id: 'systematic', label: '系统思维', emoji: '🧩' },
    ],
    steps: [CODING_LEVEL_STEP],
  },

  claude_developer: {
    templateId: 'claude_developer',
    greeting: '老板好！我是 Claude 开发工程师，用 Claude Code CLI 帮您写代码、做代码审查。',
    capabilities: ['用 Claude Code 写功能', '代码审查', 'Git 提交', '架构设计'],
    completionHint: '跟 COO 说：「叫开发工程师重构这个函数」',
    extraPersonality: [
      { id: 'technical',  label: '技术专精', emoji: '⌨️' },
      { id: 'systematic', label: '系统思维', emoji: '🧩' },
    ],
    steps: [CODING_LEVEL_STEP],
  },

  codex_developer: {
    templateId: 'codex_developer',
    greeting: '老板好！我是 Codex 开发工程师，用 OpenAI Codex CLI 帮您写代码和做审查。',
    capabilities: ['用 Codex 写功能代码', '代码审查', 'Git 提交', '自动化测试'],
    completionHint: '跟 COO 说：「叫开发工程师帮我写一个 API 接口」',
    extraPersonality: [
      { id: 'technical',  label: '技术专精', emoji: '⌨️' },
      { id: 'systematic', label: '系统思维', emoji: '🧩' },
    ],
    steps: [CODING_LEVEL_STEP],
  },
  cto: {
    templateId: 'cto',
    greeting: '老板好！我是 CTO，负责出技术主意、统筹大项目，也是团队里唯一能动 ECS 服务器的人。',
    capabilities: ['给技术建议与方案', '统筹复杂开发任务', '审查代码', '部署 / 上线到 ECS（需您批准）'],
    completionHint: '跟 COO 说：「问 CTO 这个功能该怎么设计」',
    extraPersonality: [
      { id: 'strategic', label: '战略眼光', emoji: '♟️' },
      { id: 'technical', label: '技术专精', emoji: '⌨️' },
    ],
    steps: [
      CODING_LEVEL_STEP,
      {
        id: 'enable_ssh',
        type: 'choice',
        question: '现在就给 CTO 开通服务器（SSH）访问吗？',
        hint: '默认不开最安全。开通后，CTO 每次操作服务器仍需您逐次批准；IT Engineer 和 Reviewer 永远碰不到服务器。之后也能随时跟 COO 说「开通 / 关闭服务器访问」来调整。',
        options: [
          { value: 'no', label: '暂时不开（推荐）', emoji: '🔒', hint: 'CTO 先只做技术建议和统筹，碰不到服务器' },
          { value: 'yes', label: '现在开通 SSH', emoji: '🔓', hint: '仍需每次操作时您点头批准' },
        ],
      },
      {
        id: 'ssh_enabled_note',
        type: 'info',
        showWhen: { stepId: 'enable_ssh', value: 'yes' },
        title: '已开通服务器访问',
        hint: '服务器地址和登录用户可以稍后在 Settings → Dev tools 填写，或直接跟 COO 说「把服务器地址设成 …」。每次真正操作服务器前，CTO 都会回来请您批准。',
        optional: true,
      },
      MOTION_VIDEO_STEP,
      MOTION_ENABLED_NOTE,
    ],
  },
}

// ── Public helpers ─────────────────────────────────────────────────────────────

export function getNpcOnboardingConfig(templateId: string): NpcOnboardingConfig | null {
  return NPC_ONBOARDING_CONFIGS[templateId] ?? null
}

export function buildPersonalityPool(config: NpcOnboardingConfig): PersonalityTrait[] {
  const extra = config.extraPersonality ?? []
  // Put role-specific traits first, then fill from common pool
  const seen = new Set(extra.map((t) => t.id))
  const fill = COMMON_PERSONALITY_POOL.filter((t) => !seen.has(t.id))
  return [...extra, ...fill]
}

export function rollPersonality(pool: PersonalityTrait[], count = 3): PersonalityTrait[] {
  const shuffled = [...pool].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count)
}
