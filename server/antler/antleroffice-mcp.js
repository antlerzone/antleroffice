// AntlerOffice Tools — local HTTP MCP server for SaaS NPC authoring (via ECS server).
// Bound to HR agent via catalog mcps[] (default http://127.0.0.1:8931/mcp).

const http = require('node:http');

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

const webAccounts = () => require('./web-accounts-store');

const TOOLS = [
  {
    name: 'list_web_accounts',
    description:
      'List saved web login accounts (alias + display name only). Passwords and cookies are never returned.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_account',
    description:
      'Resolve a web account by alias. Returns safe metadata (browser_profile, session_id) — never username/password.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Account alias, e.g. tnb_home.' },
      },
      required: ['alias'],
    },
  },
  {
    name: 'save_web_account',
    description:
      'Save a website login to the encrypted local vault. display_name is required (boss-visible label). Alias auto-generated if omitted. Never log or echo the password.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Login username or email.' },
        password: { type: 'string', description: 'Login password.' },
        display_name: {
          type: 'string',
          description: 'Required display name for the boss UI, e.g. 妈妈家 or TNB Account A.',
        },
        label: { type: 'string', description: 'Same as display_name (alternative field name).' },
        alias: { type: 'string', description: 'Optional alias; updates existing account if found.' },
      },
      required: ['username', 'password', 'display_name'],
    },
  },
  {
    name: 'list_saas_workers',
    description:
      'List SaaS NPC workers (departments + technical templates + installable bundles) from the ECS server catalog.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_saas_worker',
    description: 'Get one SaaS worker by department id or template id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Department id or bundle template id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_saas_worker',
    description:
      'Create a full SaaS NPC: catalog.json entry, installable bundle, and department listing. Writes to server/ for git push to ECS.',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: {
          type: 'string',
          description: 'Technical template id (snake_case), e.g. marketing_posts.',
        },
        department: {
          type: 'object',
          description:
            'Marketplace department row (id, name, tagline, category, salaryCreditsPerMonth, visibility, hirePassword when hidden, ...).',
        },
        template: {
          type: 'object',
          description:
            'Technical template fields (role, description, examples[], skillIds, openclawSkillNames, mcps, sprite, ...).',
        },
        skills: {
          type: 'array',
          description: 'ECS skill defs: [{ id, name, system }].',
        },
        openclawSkills: {
          type: 'array',
          description: 'OpenClaw SKILL.md files: [{ folderName, markdown }].',
        },
      },
      required: ['templateId', 'department', 'template', 'skills'],
    },
  },
  {
    name: 'check_app_update',
    description: 'Check whether a new AntlerOffice desktop version is available on GitHub Releases.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_app_update',
    description:
      'Schedule AntlerOffice update after Boss approval. Use when Boss says "update at 2am" or "update tonight".',
    inputSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'Target version, e.g. 2.1.0' },
        scheduled_at: { type: 'string', description: 'ISO datetime when Boss wants the update' },
        pre_approved: { type: 'boolean', description: 'True if Boss already approved restart' },
      },
      required: ['scheduled_at'],
    },
  },
  {
    name: 'fb_poster_add_article',
    description:
      'Add copy to the built-in FB article library (Playwright engine in AntlerOffice — no :3090).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        images: { type: 'string', description: 'Comma-separated image URLs' },
        note: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'fb_poster_schedule',
    description:
      'Schedule FB group posts via built-in Playwright engine. Needs account_username, group_ids, scheduled_at, article_id or content.',
    inputSchema: {
      type: 'object',
      properties: {
        account_username: { type: 'string' },
        group_ids: { type: 'string', description: 'Comma-separated FB group ids' },
        article_id: { type: 'string' },
        content: { type: 'string' },
        scheduled_at: { type: 'string', description: 'ISO datetime' },
        schedule_mode: { type: 'string', description: 'local_timer (default)' },
      },
      required: ['account_username', 'group_ids', 'scheduled_at'],
    },
  },
  {
    name: 'fb_poster_list_schedule',
    description: 'List scheduled FB jobs (built-in Playwright engine).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fb_poster_schedule_results',
    description: 'List FB post job history (built-in Playwright engine).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fb_poster_open_account',
    description:
      'Open Chrome on Facebook. Boss enters username/password manually. Reply 登好了 when home feed is visible. No email required.',
    inputSchema: {
      type: 'object',
      properties: {
        account_username: {
          type: 'string',
          description: 'Optional label for profile folder; omit to use default boss profile',
        },
      },
    },
  },
  {
    name: 'fb_poster_reload_groups',
    description:
      'After FB login, scrape joined groups for this account into the poster cache (required before name filter / schedule).',
    inputSchema: {
      type: 'object',
      properties: {
        account_username: { type: 'string' },
      },
      required: ['account_username'],
    },
  },
  {
    name: 'fb_poster_groups_matching',
    description:
      'List FB groups whose name contains a substring (e.g. 房). Use before scheduling to all matching groups.',
    inputSchema: {
      type: 'object',
      properties: {
        account_username: { type: 'string' },
        name_contains: { type: 'string', description: 'Substring match on group name (case-insensitive)' },
      },
      required: ['account_username', 'name_contains'],
    },
  },
  {
    name: 'coliving_list_vacant_rooms',
    description:
      'List vacant rooms from Coliving MCP (colivinjb.com). Stub until COLIVING_MCP_URL is configured.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max rooms to return' },
      },
    },
  },
  {
    name: 'coliving_get_room_details',
    description: 'Get one vacant room payload (photos, price, location) from Coliving MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string' },
      },
      required: ['room_id'],
    },
  },
  {
    name: 'antlerhub_list_fb_accounts',
    description: 'List FB accounts registered in AntlerOffice Playwright engine.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'antlerhub_list_fb_groups',
    description: 'List FB groups for an account from fb-group-poster clubs cache.',
    inputSchema: {
      type: 'object',
      properties: {
        account_username: { type: 'string' },
      },
      required: ['account_username'],
    },
  },
  {
    name: 'run_vacant_room_pipeline',
    description:
      'Trigger CEO marketing workflow for a vacant room (Coliving webhook equivalent). Pass room object with roomId, title, price, location, mediaUrls.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'object', description: 'Vacant room payload' },
        room_id: { type: 'string' },
        title: { type: 'string' },
        price: { type: 'string' },
        location: { type: 'string' },
        mediaUrls: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'admin_list_inbox',
    description:
      'List CEO-uploaded files waiting in Materials Admin Vault/_inbox/. Admin classifies and archives each file.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'admin_list_vault_index',
    description: 'Read Admin Vault index (filed documents by company and category).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'admin_archive_document',
    description:
      'Move a file from Admin Vault/_inbox/ (or another Materials path) into Admin Vault/{Company}/{Category}/ and update index.md.',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: {
          type: 'string',
          description: 'Materials-relative path, e.g. Admin Vault/_inbox/2026-06-20-ssm.pdf',
        },
        company: {
          type: 'string',
          description: 'Coliving | CleanLemons | AntlerHub | Shared',
        },
        category: {
          type: 'string',
          description: 'Corporate | Licenses | Contracts | Invoices | Other',
        },
        notes: { type: 'string', description: 'Optional filing note for COO lookup' },
      },
      required: ['source_path', 'company', 'category'],
    },
  },
  {
    name: 'coliving_add_expense',
    description:
      'Record operational expense in Coliving portal (room utilities, maintenance, etc.). Requires Coliving OAuth.',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string', description: 'Default MYR' },
        category: { type: 'string', description: 'utilities | maintenance | cleaning | other' },
        description: { type: 'string' },
        date: { type: 'string', description: 'ISO date' },
      },
      required: ['amount', 'description'],
    },
  },
  {
    name: 'website_learn_start',
    description:
      'Start Website Learning Mode (observe only). Boss operates Chrome; IT Junior records actions. profile_mode: ephemeral | persistent | workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_name: { type: 'string' },
        start_url: { type: 'string' },
        profile_mode: { type: 'string', enum: ['ephemeral', 'persistent', 'workflow'] },
        profile_label: { type: 'string' },
      },
      required: ['workflow_name', 'profile_mode'],
    },
  },
  {
    name: 'website_learn_poll',
    description: 'Poll incremental learning events (mouse, navigate, input) for an active session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        since_seq: { type: 'number' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'website_learn_screenshot',
    description: 'Manual screenshot + visible form fields during learning.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'website_learn_stop',
    description: 'Stop observe recording for a learning session.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'website_learn_export',
    description: 'Export workflow artifacts (playwright.ts, input_mapping.json, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        workflow_name: { type: 'string' },
      },
    },
  },
  {
    name: 'website_learn_simulate_once',
    description: 'Replay learned workflow once for Boss approval (IT Junior drives Chrome).',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_name: { type: 'string' },
        slow_mo_ms: { type: 'number' },
      },
      required: ['workflow_name'],
    },
  },
  {
    name: 'website_learn_batch_run',
    description: 'Batch run workflow from CSV/JSON file. Writes result.csv and result.json.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_name: { type: 'string' },
        excel_path: { type: 'string', description: 'Path to .csv or .json batch file' },
      },
      required: ['workflow_name', 'excel_path'],
    },
  },
  {
    name: 'website_learn_list_workflows',
    description: 'List saved website learning workflows.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function ecsBaseUrl() {
  return (
    process.env.ECS_BASE_URL ||
    process.env.ECS_SERVER_URL ||
    'http://localhost:3030'
  ).replace(/\/+$/, '');
}

function fbEngine() {
  return require('./fb-playwright-engine');
}

function websiteLearnEngine() {
  return require('./website-learn-engine');
}

function colivingBaseUrl() {
  return (process.env.COLIVING_MCP_URL || '').replace(/\/+$/, '');
}

function colivingAuthFromStore() {
  try {
    const portal = require('./portal-partner-oauth');
    for (const partnerId of ['coliving', 'antlerchat', 'antlerhub']) {
      const headers = portal.authHeaders(partnerId);
      if (headers) return { headers, apiBase: portal.apiBase(partnerId) };
    }
  } catch {
    return null;
  }
  return null;
}

async function colivingJson(path, opts = {}) {
  const store = colivingAuthFromStore();
  if (store) {
    const apiBase = store.apiBase.endsWith('/api') ? store.apiBase : `${store.apiBase}/api`;
    const url = path.includes('coliving-mcp')
      ? `${apiBase}${path.startsWith('/') ? path : `/${path}`}`
      : `${apiBase}/coliving-mcp/invoke`;
    const body =
      path.includes('coliving-mcp') || opts.body
        ? opts.body
        : JSON.stringify({
            toolId: path.includes('rooms/')
              ? 'coliving.inventory.room_detail'
              : 'coliving.inventory.search',
            query: '',
            params: path.includes('rooms/')
              ? { roomId: path.split('/rooms/')[1]?.split('?')[0] }
              : { limit: Number((path.match(/limit=(\d+)/) || [])[1]) || 20 },
          });
    const res = await fetch(url, {
      ...opts,
      method: path.includes('coliving-mcp') ? (opts.method || 'GET') : 'POST',
      body: body && typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
      headers: { ...store.headers, ...(opts.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
    return res.json().catch(() => ({}));
  }

  const base = colivingBaseUrl();
  if (!base) {
    return { stub: true, message: 'Sign in to Coliving Portal when hiring Coliving Admin, or set COLIVING_MCP_URL' };
  }
  const res = await fetch(`${base}${path.startsWith('/') ? path : `/${path}`}`, {
    ...opts,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  return res.json().catch(() => ({}));
}

function adminHeaders(extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
  const token = process.env.ECS_ADMIN_TOKEN;
  if (token) headers['x-admin-token'] = token;
  return headers;
}

async function ecsAdminJson(path, opts = {}) {
  const url = `${ecsBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...opts,
    headers: adminHeaders(opts.headers),
    signal: AbortSignal.timeout(Number(process.env.ECS_ADMIN_TIMEOUT_MS) || 30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `ECS admin HTTP ${res.status}`);
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

function toolText(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'list_web_accounts': {
      return toolText({ accounts: webAccounts().listAgentAccounts() });
    }
    case 'get_account': {
      const alias = String(args.alias || '').trim();
      if (!alias) throw new Error('alias is required');
      const account = webAccounts().resolveAgentAccount(alias);
      if (!account) throw new Error(`account not found: ${alias}`);
      return toolText(account);
    }
    case 'save_web_account': {
      const username = String(args.username || '').trim();
      const password = String(args.password || '').trim();
      const displayName = String(args.display_name || args.label || '').trim();
      if (!username || !password) throw new Error('username and password are required');
      if (!displayName) throw new Error('display_name is required');
      const account = webAccounts().saveAccount({
        username,
        password,
        displayName,
        alias: args.alias,
      });
      return toolText({
        ok: true,
        alias: account.alias,
        display_name: account.displayName,
        username_masked: account.usernameMasked,
      });
    }
    case 'list_saas_workers': {
      const data = await ecsAdminJson('/api/admin/catalog/workers');
      return toolText(data);
    }
    case 'get_saas_worker': {
      const id = String(args.id || '').trim();
      if (!id) throw new Error('id is required');
      const data = await ecsAdminJson(`/api/admin/catalog/workers/${encodeURIComponent(id)}`);
      return toolText(data);
    }
    case 'create_saas_worker': {
      const data = await ecsAdminJson('/api/admin/catalog/workers', {
        method: 'POST',
        body: JSON.stringify(args),
      });
      return toolText(data);
    }
    case 'check_app_update': {
      const pkg = require('../../package.json');
      const schedule = require('./app-updater.cjs').readSchedule();
      return toolText({
        currentVersion: pkg.version,
        pendingVersion: schedule.pendingVersion,
        scheduledAt: schedule.scheduledAt,
        message: 'Boss must approve in the desktop app or ask COO to schedule an update time.',
      });
    }
    case 'schedule_app_update': {
      const appUpdater = require('./app-updater.cjs');
      const scheduledAt = new Date(String(args.scheduled_at || '')).getTime();
      if (!scheduledAt || Number.isNaN(scheduledAt)) throw new Error('scheduled_at must be a valid ISO datetime');
      const schedule = appUpdater.writeSchedule({
        pendingVersion: args.version || null,
        scheduledAt,
        preApproved: !!args.pre_approved,
        skippedVersion: null,
        remindAfter: null,
      });
      return toolText({
        ok: true,
        schedule,
        message: `Update scheduled for ${new Date(scheduledAt).toISOString()}. Boss approval required unless pre_approved is true.`,
      });
    }
    case 'fb_poster_add_article': {
      const eng = fbEngine();
      return toolText(
        eng.addArticle({
          title: args.title,
          content: args.content || '',
          images: args.images || '',
          note: args.note || '',
        }),
      );
    }
    case 'fb_poster_schedule': {
      const eng = fbEngine();
      return toolText(
        eng.schedulePost({
          account_username: args.account_username,
          group_ids: args.group_ids,
          article_id: args.article_id || '',
          content: args.content || '',
          scheduled_at: args.scheduled_at,
        }),
      );
    }
    case 'fb_poster_list_schedule': {
      return toolText({ data: fbEngine().listScheduledJobs() });
    }
    case 'fb_poster_schedule_results': {
      return toolText({ data: fbEngine().listJobResults() });
    }
    case 'fb_poster_open_account': {
      const account_username = String(args.account_username || '').trim();
      return toolText(await fbEngine().openAccount(account_username));
    }
    case 'fb_poster_reload_groups': {
      const eng = fbEngine();
      const account_username = String(args.account_username || '').trim() || eng.primaryAccountKey();
      return toolText(await fbEngine().scrapeGroups(account_username));
    }
    case 'fb_poster_groups_matching': {
      const account_username = String(args.account_username || '').trim();
      const name_contains = String(args.name_contains || '').trim();
      if (!account_username) throw new Error('account_username is required');
      if (!name_contains) throw new Error('name_contains is required');
      try {
        const eng = fbEngine();
        const groups = eng.listGroups(account_username);
        if (!groups.length) {
          return toolText({
            ok: false,
            error: 'No groups cached for this account',
            hint: 'Call fb_poster_open_account, complete FB login in Chrome, then fb_poster_reload_groups.',
          });
        }
        const matched = eng.filterGroups(account_username, name_contains);
        return toolText({
          account_username,
          name_contains,
          count: matched.length,
          group_ids: matched.map((g) => g.id).join(','),
          groups: matched,
        });
      } catch (e) {
        return toolText({
          ok: false,
          error: e.message,
          hint: 'Call fb_poster_open_account, complete FB login in Chrome, then fb_poster_reload_groups.',
        });
      }
    }
    case 'coliving_list_vacant_rooms': {
      const data = await colivingJson(`/vacant-rooms?limit=${Number(args.limit) || 20}`);
      if (data.stub) {
        return toolText({ rooms: [], ...data });
      }
      return toolText(data);
    }
    case 'coliving_get_room_details': {
      const roomId = String(args.room_id || '').trim();
      if (!roomId) throw new Error('room_id is required');
      const data = await colivingJson(`/rooms/${encodeURIComponent(roomId)}`);
      if (data.stub) {
        return toolText({ room: null, room_id: roomId, ...data });
      }
      return toolText(data);
    }
    case 'antlerhub_list_fb_accounts': {
      try {
        const accounts = fbEngine().listAccountsForBoss();
        return toolText({ count: accounts.length, accounts });
      } catch (e) {
        return toolText({
          stub: true,
          accounts: [],
          message: `FB engine error: ${e.message}`,
        });
      }
    }
    case 'antlerhub_list_fb_groups': {
      const username = String(args.account_username || '').trim();
      if (!username) throw new Error('account_username is required');
      try {
        const groups = fbEngine().listGroups(username);
        return toolText({ account_username: username, groups });
      } catch (e) {
        return toolText({
          stub: true,
          groups: [],
          message: `FB engine error: ${e.message}`,
        });
      }
    }
    case 'run_vacant_room_pipeline': {
      const room = args.room || {
        roomId: args.room_id,
        title: args.title,
        price: args.price,
        location: args.location,
        mediaUrls: args.mediaUrls,
      };
      const orchestrator = require('./vacant-room-orchestrator');
      const result = await orchestrator.runVacantRoomPipeline({ room });
      return toolText({ ok: true, result });
    }
    case 'admin_list_inbox': {
      const adminVault = require('./admin-vault');
      return toolText(adminVault.listInbox());
    }
    case 'admin_list_vault_index': {
      const adminVault = require('./admin-vault');
      return toolText(adminVault.listVaultIndex());
    }
    case 'admin_archive_document': {
      const adminVault = require('./admin-vault');
      const sourcePath = String(args.source_path || args.sourcePath || '').trim();
      if (!sourcePath) throw new Error('source_path is required');
      const result = adminVault.archiveDocument(sourcePath, args.company, args.category, {
        notes: args.notes,
      });
      return toolText(result);
    }
    case 'coliving_add_expense': {
      const portal = require('./portal-partner-oauth');
      if (!portal.isConnected('coliving')) {
        return toolText({
          stub: true,
          ok: false,
          message: 'Coliving portal OAuth not connected — hire Coliving Admin VIP and sign in first.',
        });
      }
      return toolText({
        stub: true,
        ok: false,
        message:
          'Coliving expense API is not wired in AntlerOffice MCP yet. Record in Coliving portal; Accounting verifies via Bukku reconcile only.',
        payload: {
          room_id: args.room_id || null,
          amount: args.amount,
          currency: args.currency || 'MYR',
          category: args.category || 'other',
          description: args.description,
          date: args.date || new Date().toISOString().slice(0, 10),
        },
      });
    }
    case 'website_learn_start': {
      return toolText(
        await websiteLearnEngine().start({
          workflow_name: args.workflow_name,
          start_url: args.start_url || '',
          profile_mode: args.profile_mode || 'ephemeral',
          profile_label: args.profile_label || args.workflow_name || '',
        }),
      );
    }
    case 'website_learn_poll': {
      const session_id = String(args.session_id || '').trim();
      if (!session_id) throw new Error('session_id is required');
      return toolText(
        await websiteLearnEngine().poll({
          session_id,
          since_seq: Number(args.since_seq) || 0,
        }),
      );
    }
    case 'website_learn_screenshot': {
      const session_id = String(args.session_id || '').trim();
      if (!session_id) throw new Error('session_id is required');
      return toolText(
        await websiteLearnEngine().screenshot({
          session_id,
          label: args.label || 'manual',
        }),
      );
    }
    case 'website_learn_stop': {
      const session_id = String(args.session_id || '').trim();
      if (!session_id) throw new Error('session_id is required');
      return toolText(await websiteLearnEngine().stop({ session_id }));
    }
    case 'website_learn_export': {
      return toolText(
        await websiteLearnEngine().exportWorkflow({
          session_id: args.session_id || '',
          workflow_name: args.workflow_name || '',
        }),
      );
    }
    case 'website_learn_simulate_once': {
      const workflow_name = String(args.workflow_name || '').trim();
      if (!workflow_name) throw new Error('workflow_name is required');
      return toolText(
        await websiteLearnEngine().simulateOnce({
          workflow_name,
          slow_mo_ms: Number(args.slow_mo_ms) || 300,
        }),
      );
    }
    case 'website_learn_batch_run': {
      const workflow_name = String(args.workflow_name || '').trim();
      const excel_path = String(args.excel_path || '').trim();
      if (!workflow_name) throw new Error('workflow_name is required');
      if (!excel_path) throw new Error('excel_path is required');
      return toolText(await websiteLearnEngine().batchRun({ workflow_name, excel_path }));
    }
    case 'website_learn_list_workflows': {
      return toolText({ workflows: websiteLearnEngine().listWorkflows() });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(body) {
  const { id, method, params } = body || {};

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'antleroffice-tools', version: '2.0.0' },
    });
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    return null;
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    try {
      const result = await callTool(toolName, toolArgs);
      return rpcResult(id, result);
    } catch (e) {
      return rpcError(id, -32603, e instanceof Error ? e.message : 'Tool call failed');
    }
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function handleMcpRequest(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, MCP_HEADERS);
    res.end(JSON.stringify({ ok: true, name: 'antleroffice-tools', tools: TOOLS.map((t) => t.name) }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, MCP_HEADERS);
    res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
    return;
  }

  let body = {};
  try {
    body = JSON.parse(req.bodyText || '{}');
  } catch {
    res.writeHead(400, MCP_HEADERS);
    res.end(JSON.stringify(rpcError(body?.id ?? null, -32700, 'Parse error')));
    return;
  }

  const out = await handleRpc(body);
  if (!out) {
    res.writeHead(204, MCP_HEADERS);
    res.end();
    return;
  }
  res.writeHead(200, MCP_HEADERS);
  res.end(JSON.stringify(out));
}

function attachMcpRoutes(app) {
  app.use('/mcp', expressJsonRaw(), async (req, res) => {
    await handleMcpRequest(req, res);
  });
}

function expressJsonRaw() {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      req.bodyText = '';
      return next();
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      req.bodyText = Buffer.concat(chunks).toString('utf8');
      next();
    });
  };
}

function startStandaloneServer(port = 8931) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/mcp' && url.pathname !== '/') {
      res.writeHead(404, MCP_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    if (req.method === 'GET') {
      await handleMcpRequest({ method: 'GET', headers: req.headers, bodyText: '' }, res);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, MCP_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await handleMcpRequest({ method: 'POST', headers: req.headers, bodyText: Buffer.concat(chunks).toString('utf8') }, res);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[AntlerOffice MCP] Tools server listening on http://127.0.0.1:${port}/mcp`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[AntlerOffice MCP] Port ${port} already in use — skipping standalone MCP server`);
      return;
    }
    console.error('[AntlerOffice MCP]', err.message);
  });

  return server;
}

module.exports = {
  TOOLS,
  callTool,
  handleRpc,
  handleMcpRequest,
  attachMcpRoutes,
  startStandaloneServer,
  ecsBaseUrl,
  ecsAdminJson,
};
