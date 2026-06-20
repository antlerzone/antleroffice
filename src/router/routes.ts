import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { titleKey: 'routes.login', public: true },
  },
  {
    path: '/boss/login',
    redirect: { name: 'Login' },
  },
  {
    path: '/auth/desktop-complete',
    name: 'AuthDesktopComplete',
    component: () => import('@/views/AuthDesktopComplete.vue'),
    meta: { titleKey: 'routes.login', public: true },
  },
  {
    path: '/portal',
    name: 'Portal',
    component: () => import('@/views/antler/PortalPage.vue'),
    meta: { titleKey: 'routes.portal', ecsPortal: true },
  },
  {
    path: '/',
    component: () => import('@/layouts/DefaultLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        redirect: { name: 'Portal' },
      },
      // ── AntlerOffice 2.0 boss menu ────────────────────────────────────────
      {
        path: 'office',
        name: 'PixelOffice',
        component: () => import('@/views/antler/PixelOfficePage.vue'),
        meta: { titleKey: 'routes.pixelOffice', icon: 'BusinessOutline', gateway: 'openclaw', tier: 'boss', fullBleed: true },
      },
      {
        path: 'home',
        redirect: { name: 'Portal' },
        meta: { hidden: true },
      },
      {
        path: 'payslip',
        name: 'Payslip',
        component: () => import('@/views/antler/PayslipPage.vue'),
        meta: { titleKey: 'routes.payslip', icon: 'ReceiptOutline', gateway: 'openclaw', tier: 'boss' },
      },
      {
        path: 'home/payslip',
        redirect: { name: 'Payslip' },
        meta: { hidden: true },
      },
      {
        path: 'hire',
        redirect: { name: 'AntlerAgents', query: { tab: 'browse' } },
        meta: { hidden: true },
      },
      {
        path: 'skins',
        name: 'AntlerSkins',
        component: () => import('@/views/antler/SkinsPage.vue'),
        meta: { titleKey: 'routes.antlerSkins', icon: 'ColorPaletteOutline', gateway: 'openclaw', tier: 'boss' },
      },
      {
        path: 'channels',
        name: 'AntlerChannels',
        component: () => import('@/views/antler/AntlerChannelsPage.vue'),
        meta: { titleKey: 'routes.antlerChannels', icon: 'GitNetworkOutline', gateway: 'openclaw', tier: 'boss', menuPinFromBottom: 3 },
      },
      {
        path: 'connect',
        redirect: { name: 'AntlerChannels' },
        meta: { hidden: true },
      },
      {
        path: 'integrations',
        redirect: { name: 'Models' },
        meta: { hidden: true },
      },
      {
        path: 'accounts',
        name: 'WebAccounts',
        component: () => import('@/views/antler/AccountsPage.vue'),
        meta: { titleKey: 'routes.webAccounts', icon: 'KeyOutline', gateway: 'openclaw', tier: 'boss', menuPinFromBottom: 2 },
      },
      {
        path: 'agents',
        name: 'AntlerAgents',
        component: () => import('@/views/antler/AntlerAgentsPage.vue'),
        meta: { titleKey: 'routes.agents', icon: 'PeopleOutline', gateway: 'openclaw', tier: 'boss' },
      },
      {
        path: 'dev/npc-hire-layout',
        name: 'NpcHireLayoutSandbox',
        component: () => import('@/views/dev/NpcHireLayoutSandbox.vue'),
        meta: {
          title: 'NPC Hire Layout',
          icon: 'MoveOutline',
          gateway: 'openclaw',
          tier: 'boss',
          hidden: true,
          fullBleed: true,
        },
      },
      {
        path: 'skills',
        name: 'AntlerSkills',
        component: () => import('@/views/antler/AntlerSkillsPage.vue'),
        meta: { titleKey: 'routes.skills', icon: 'ExtensionPuzzleOutline', gateway: 'openclaw', tier: 'boss' },
      },
      {
        path: 'materials',
        name: 'AntlerMaterials',
        component: () => import('@/views/antler/MaterialsPage.vue'),
        meta: { titleKey: 'routes.materials', icon: 'FolderOpenOutline', gateway: 'openclaw', tier: 'boss' },
      },
      {
        path: 'office-settings',
        redirect: { name: 'Settings' },
        meta: { hidden: true },
      },
      {
        path: 'jobs',
        name: 'AntlerCompleteJob',
        component: () => import('@/views/antler/AntlerCompleteJobPage.vue'),
        meta: { titleKey: 'routes.completeJob', icon: 'CheckmarkDoneOutline', gateway: 'openclaw', tier: 'boss' },
      },
      {
        path: 'schedule',
        name: 'AntlerSchedule',
        component: () => import('@/views/antler/AntlerSchedulePage.vue'),
        meta: { titleKey: 'routes.schedule', icon: 'CalendarOutline', gateway: 'openclaw', tier: 'boss' },
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('@/views/antler/AntlerOfficeSettingsPage.vue'),
        meta: { titleKey: 'routes.settings', icon: 'SettingsOutline', gateway: 'openclaw', tier: 'boss', menuPinFromBottom: 1 },
      },
      // ── OpenClaw Admin (advanced) ─────────────────────────────────────────
      {
        path: 'admin',
        name: 'AdminDashboard',
        component: () => import('@/views/Dashboard.vue'),
        meta: { titleKey: 'routes.adminDashboard', icon: 'AnalyticsOutline', gateway: 'openclaw', tier: 'advanced' },
      },
      {
        path: 'admin/gateway',
        redirect: { name: 'Settings' },
        meta: { hidden: true },
      },
      {
        path: 'chat',
        name: 'Chat',
        component: () => import('@/views/chat/ChatPage.vue'),
        meta: { titleKey: 'routes.chat', icon: 'ChatboxEllipsesOutline', gateway: 'openclaw', tier: 'advanced' },
      },
      {
        path: 'sessions',
        name: 'Sessions',
        component: () => import('@/views/sessions/SessionsPage.vue'),
        meta: { titleKey: 'routes.sessions', icon: 'ChatbubblesOutline', gateway: 'openclaw', tier: 'advanced' },
      },
      {
        path: 'sessions/:key',
        name: 'SessionDetail',
        component: () => import('@/views/sessions/SessionDetailPage.vue'),
        meta: { titleKey: 'routes.sessionDetail', hidden: true },
      },
      {
        path: 'memory',
        name: 'Memory',
        component: () => import('@/views/memory/MemoryPage.vue'),
        meta: { titleKey: 'routes.memory', icon: 'BookOutline', gateway: 'openclaw', tier: 'advanced' },
      },
      {
        path: 'cron',
        redirect: { name: 'AntlerSchedule' },
        meta: { hidden: true },
      },
      {
        path: 'cron-admin',
        name: 'Cron',
        component: () => import('@/views/cron/CronPage.vue'),
        meta: { titleKey: 'routes.cronAdmin', icon: 'CalendarOutline', gateway: 'openclaw', tier: 'advanced', hidden: true },
      },
      {
        path: 'models',
        name: 'Models',
        component: () => import('@/views/models/ModelsPage.vue'),
        meta: { titleKey: 'routes.models', icon: 'SparklesOutline', gateway: 'openclaw', tier: 'boss' },
      },
      {
        path: 'config',
        redirect: { name: 'Models' },
        meta: { hidden: true },
      },
      {
        path: 'skills-admin',
        name: 'Skills',
        component: () => import('@/views/skills/SkillsPage.vue'),
        meta: { titleKey: 'routes.skillsAdmin', icon: 'ExtensionPuzzleOutline', gateway: 'openclaw', tier: 'advanced', hidden: true },
      },
      {
        path: 'tools',
        redirect: { name: 'AntlerSkills' },
        meta: { hidden: true },
      },
      {
        path: 'system',
        name: 'System',
        component: () => import('@/views/system/SystemPage.vue'),
        meta: { titleKey: 'routes.system', icon: 'PulseOutline', gateway: 'openclaw', tier: 'advanced' },
      },
      {
        path: 'terminal',
        name: 'Terminal',
        component: () => import('@/views/terminal/TerminalPage.vue'),
        meta: { titleKey: 'routes.terminal', icon: 'TerminalOutline', gateway: 'openclaw', tier: 'advanced', hidden: true },
      },
      {
        path: 'remote-desktop',
        name: 'RemoteDesktop',
        component: () => import('@/views/remote-desktop/RemoteDesktopPage.vue'),
        meta: { titleKey: 'routes.remoteDesktop', icon: 'DesktopOutline', gateway: 'openclaw', tier: 'advanced', hidden: true },
      },
      {
        path: 'files',
        name: 'Files',
        component: () => import('@/views/files/FilesPage.vue'),
        meta: { titleKey: 'routes.files', icon: 'FolderOutline', gateway: 'openclaw', tier: 'advanced' },
      },
      {
        path: 'agents-admin',
        name: 'OpenClawAgents',
        component: () => import('@/views/agents/AgentsPage.vue'),
        meta: { titleKey: 'routes.openClawAgents', icon: 'PeopleOutline', gateway: 'openclaw', tier: 'advanced', hidden: true },
      },
      {
        path: 'workshop',
        name: 'Workshop',
        component: () => import('@/views/office/OfficePage.vue'),
        meta: { titleKey: 'routes.workshop', icon: 'ConstructOutline', gateway: 'openclaw', tier: 'advanced' },
      },
      {
        path: 'myworld',
        redirect: { name: 'PixelOffice' },
        meta: { hidden: true },
      },
      {
        path: 'backup',
        name: 'Backup',
        component: () => import('@/views/backup/BackupPage.vue'),
        meta: { titleKey: 'routes.backup', icon: 'ArchiveOutline', gateway: 'openclaw', tier: 'advanced' },
      },
      {
        path: 'monitor',
        name: 'Monitor',
        component: () => import('@/views/monitor/MonitorPage.vue'),
        meta: { titleKey: 'routes.monitor', icon: 'PulseOutline', hidden: true },
      },
      {
        path: 'hermes/:pathMatch(.*)*',
        redirect: { name: 'PixelOffice' },
        meta: { hidden: true },
      },
    ],
  },
]
