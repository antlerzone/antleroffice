/**
 * Secretary Facebook intake — used by Boss Chat (OpenClaw gateway) and /api/chat.
 * Executes real actions (open Chrome) instead of generic LLM refusals.
 */

const office = require('./office-state');
const orgRoles = require('./org-roles');
const intake = require('./secretary-fb-intake');
const itIntake = require('./secretary-it-intake');
const weatherIntake = require('./secretary-weather-intake');
const officeIntake = require('./secretary-office-intake');
const websiteLearnIntake = require('./secretary-website-learn-intake');
const websiteLearnEngine = require('./website-learn-engine');
const fbEngine = require('./fb-playwright-engine');

function extractOpenClawAgentId(sessionKey) {
  const key = String(sessionKey || '');
  const m = key.match(/^agent:([^:]+):/);
  return m?.[1] || '';
}

function isSecretaryGatewaySession(sessionKey) {
  const id = extractOpenClawAgentId(sessionKey);
  return !id || id === 'main' || id === 'default';
}

async function handleSecretaryFbIntake(text, opts = {}) {
  return handleSecretaryFbIntakeCore(text, opts);
}

async function handleSecretaryFbIntakeCore(text, { sessionKey = '', threadId = null, ownerKey = null, recentUserTexts = [], recentConversation = [] } = {}) {
  const taskText = String(text || '').trim();
  if (!taskText) return { handled: false };

  if (weatherIntake.classifyWeatherMessage(taskText, { recentUserTexts, recentConversation })) {
    const sec = orgRoles.findSecretary() || { id: 'secretary', role: 'secretary', label: 'Secretary' };
    office.work(sec.id, 'Checking weather…', { label: 'Weather', step: 'Lookup', progress: 1, total: 1 });
    try {
      const reply = await weatherIntake.buildWeatherReply(taskText);
      office.rest(sec.id, '');
      return {
        handled: true,
        reply,
        needsBossInput: false,
        provider: 'antleroffice-secretary',
      };
    } catch (e) {
      office.rest(sec.id, '');
      return {
        handled: true,
        reply:
          `暂时查不到 **${weatherIntake.resolvePlace(taskText).label}** 的实时天气（${e.message}）。\n\n` +
          '你可以稍后再问，或指定城市，例如「吉隆坡天气」。',
        needsBossInput: false,
        provider: 'antleroffice-secretary',
      };
    }
  }

  if (officeIntake.classifyOfficeStatusMessage(taskText)) {
    const sec = orgRoles.findSecretary() || { id: 'secretary', role: 'secretary', label: 'Secretary' };
    office.work(sec.id, 'Office status…', { label: 'Office', step: 'Status', progress: 1, total: 1 });
    const reply = officeIntake.buildOfficeStatusReply();
    office.rest(sec.id, '');
    return {
      handled: true,
      reply,
      needsBossInput: false,
      provider: 'antleroffice-secretary',
    };
  }

  const itIntent = itIntake.classifyItMessage(taskText);
  if (itIntent) {
    const sec = orgRoles.findSecretary() || { id: 'secretary', role: 'secretary', label: 'Secretary' };
    const readiness = await itIntake.getItDevReadiness();

    if (itIntent === 'it_setup' || itIntent === 'it_status' || itIntent === 'it_setup_done') {
      office.work(sec.id, 'IT dev tools…', { label: 'IT', step: 'Check', progress: 1, total: 1 });
      office.setAgent(sec.id, { awaitingBossInput: !readiness.ready });
      office.rest(sec.id, '');
      return {
        handled: true,
        reply: itIntake.buildSetupGuide(readiness),
        needsBossInput: !readiness.ready,
        provider: 'antleroffice-secretary',
      };
    }

    if (itIntent === 'it_dev_request') {
      if (!readiness.ready) {
        office.work(sec.id, 'IT setup needed', { label: 'IT', step: 'Prompt', progress: 1, total: 2 });
        office.setAgent(sec.id, { awaitingBossInput: true });
        return {
          handled: true,
          reply: itIntake.buildSetupRequiredReply(taskText, readiness),
          needsBossInput: true,
          provider: 'antleroffice-secretary',
        };
      }

      const coo = orgRoles.findHiredCoo();
      if (!coo) {
        return {
          handled: true,
          reply:
            'IT Guys 已就绪。若要开发功能，请先在 Hire 页面聘请 **COO**，然后告诉我需求，我会交给 COO 安排 IT 执行。',
          needsBossInput: true,
          provider: 'antleroffice-secretary',
        };
      }

      const sessionSync = require('./secretary-intake-session-sync');
      setImmediate(() => {
        sessionSync
          .runDelegatedCeoTask({
            taskText,
            threadId,
            ownerKey: ownerKey || 'local:boss',
            sessionKey,
            label: '开发任务',
          })
          .catch(() => {});
      });

      office.rest(sec.id, '');
      return {
        handled: true,
        reply:
          '好的，IT Guys 已配置完成。我交给 COO 安排开发任务。\n\n' +
          '**COO 正在执行** — 完成后此对话会自动更新；也可打开 **办公室 (Office)** 查看进度。',
        needsBossInput: false,
        provider: 'antleroffice-secretary',
        delegated: true,
      };
    }
  }

  const websiteIntent = websiteLearnIntake.classifyWebsiteLearnMessage(taskText);
  if (websiteIntent) {
    const sec = orgRoles.findSecretary() || { id: 'secretary', role: 'secretary', label: 'Secretary' };
    const junior = orgRoles.findItJunior() || { id: 'it_junior', role: 'it_junior', label: 'IT Junior' };

    if (websiteIntent === 'list_workflows') {
      return {
        handled: true,
        reply: websiteLearnIntake.buildWorkflowListReply(),
        needsBossInput: false,
        provider: 'antleroffice-secretary',
      };
    }

    if (websiteIntent === 'profile_choice') {
      const pending = websiteLearnEngine.getPendingIntake();
      if (!pending?.waitingForProfile) return { handled: false };
      const profile_mode = websiteLearnIntake.profileModeFromChoice(taskText.trim());
      websiteLearnEngine.clearPendingIntake();
      office.work(junior.id, 'Learning…', { label: 'Learn', step: 'Chrome', progress: 1, total: 2 });
      try {
        const started = await websiteLearnEngine.start({
          workflow_name: pending.workflow_name,
          start_url: pending.start_url || '',
          profile_mode,
          profile_label: pending.workflow_name,
        });
        office.setAgent(junior.id, {
          npcState: 'working',
          bubbleText: 'Recording workflow',
          awaitingBossInput: true,
        });
        return {
          handled: true,
          reply:
            `已派 **IT Junior（学徒）** 开始记录 **${started.workflow_name}**。\n\n` +
            `${started.message}\n\n` +
            '完成后回复「**学习结束**」。可说「模拟一次」验收，或上传 CSV 批量跑。',
          needsBossInput: true,
          provider: 'antleroffice-secretary',
          websiteLearn: started,
        };
      } catch (e) {
        office.rest(junior.id, '');
        return {
          handled: true,
          reply: `无法开始学习：${e.message}`,
          needsBossInput: false,
          provider: 'antleroffice-secretary',
        };
      }
    }

    if (websiteIntent === 'learn_start') {
      const workflow_name =
        websiteLearnIntake.extractWorkflowName(taskText) ||
        websiteLearnEngine.getPendingIntake()?.workflow_name ||
        '';
      const start_url = websiteLearnIntake.extractStartUrl(taskText);
      if (!workflow_name) {
        office.setAgent(sec.id, { awaitingBossInput: true });
        return {
          handled: true,
          reply:
            '请告诉我要学习的 **workflow 名称**，例如：\n\n' +
            '「进入学习模式 workflow **invoice-download** 网站 https://example.com」',
          needsBossInput: true,
          provider: 'antleroffice-secretary',
        };
      }
      websiteLearnEngine.setPendingIntake({
        workflow_name,
        start_url,
        waitingForProfile: true,
      });
      office.setAgent(sec.id, { awaitingBossInput: true });
      return {
        handled: true,
        reply: websiteLearnIntake.buildProfilePrompt(workflow_name),
        needsBossInput: true,
        provider: 'antleroffice-secretary',
      };
    }

    if (websiteIntent === 'learn_done') {
      const active = websiteLearnEngine.activeSession();
      if (!active) {
        return {
          handled: true,
          reply: '当前没有进行中的学习 session。说「进入学习模式」开始。',
          needsBossInput: false,
          provider: 'antleroffice-secretary',
        };
      }
      office.work(junior.id, 'Exporting…', { label: 'Learn', step: 'Export', progress: 2, total: 2 });
      try {
        await websiteLearnEngine.poll({ session_id: active.session_id });
        const stopped = await websiteLearnEngine.stop({ session_id: active.session_id });
        const exported = await websiteLearnEngine.exportWorkflow({
          workflow_name: stopped.workflow_name,
        });
        office.rest(junior.id, '');
        const vars = exported.mapping?.variables || [];
        const varLines = vars
          .slice(0, 12)
          .map((v) => `- **${v.name}** (${v.type})${v.batch_source ? ` · batch: ${v.batch_source}` : ''}`)
          .join('\n');
        return {
          handled: true,
          reply:
            `**学习结束** — workflow \`${exported.workflow_name}\` 已导出。\n\n` +
            `### Input Mapping\n${varLines || '(none)'}\n\n` +
            `文件目录：\`${exported.workflow_path}\`\n\n` +
            '下一步：说「**模拟一次**」验收，或「用 xxx.csv 批量跑」。',
          needsBossInput: true,
          provider: 'antleroffice-secretary',
          websiteLearn: exported,
        };
      } catch (e) {
        office.rest(junior.id, '');
        return {
          handled: true,
          reply: `导出失败：${e.message}`,
          needsBossInput: false,
          provider: 'antleroffice-secretary',
        };
      }
    }

    if (websiteIntent === 'simulate_once') {
      const workflow_name = websiteLearnIntake.extractWorkflowName(taskText) || websiteLearnEngine.listWorkflows()[0]?.workflow_name;
      if (!workflow_name) {
        return {
          handled: true,
          reply: '请先完成一次学习，或指定 workflow 名称，例如「模拟一次 invoice-download」。',
          needsBossInput: true,
          provider: 'antleroffice-secretary',
        };
      }
      office.work(junior.id, 'Simulating…', { label: 'Simulate', step: 'Replay', progress: 1, total: 1 });
      try {
        const result = await websiteLearnEngine.simulateOnce({ workflow_name });
        office.rest(junior.id, '');
        return {
          handled: true,
          reply: result.ok
            ? `**模拟一次**完成 — \`${workflow_name}\`（${result.steps?.length || 0} 步）。请检查 Chrome 与截图目录。`
            : `模拟失败：${result.error}`,
          needsBossInput: true,
          provider: 'antleroffice-secretary',
          websiteLearn: result,
        };
      } catch (e) {
        office.rest(junior.id, '');
        return {
          handled: true,
          reply: `模拟失败：${e.message}`,
          needsBossInput: false,
          provider: 'antleroffice-secretary',
        };
      }
    }

    if (websiteIntent === 'batch_run') {
      const workflow_name = websiteLearnIntake.extractWorkflowName(taskText);
      const excel_path = websiteLearnIntake.extractBatchPath(taskText);
      if (!workflow_name || !excel_path) {
        return {
          handled: true,
          reply: '请指定 workflow 和数据文件，例如：「用 customer.csv 批量跑 invoice-download」。',
          needsBossInput: true,
          provider: 'antleroffice-secretary',
        };
      }
      office.work(junior.id, 'Batch…', { label: 'Batch', step: 'Run', progress: 1, total: 1 });
      try {
        const result = await websiteLearnEngine.batchRun({ workflow_name, excel_path });
        office.rest(junior.id, '');
        return {
          handled: true,
          reply: `批量完成 **${result.count}** 行。结果：\`${result.result_csv}\``,
          needsBossInput: false,
          provider: 'antleroffice-secretary',
          websiteLearn: result,
        };
      } catch (e) {
        office.rest(junior.id, '');
        return {
          handled: true,
          reply: `批量失败：${e.message}`,
          needsBossInput: false,
          provider: 'antleroffice-secretary',
        };
      }
    }
  }

  const fbIntent = intake.classifySecretaryMessage(taskText);
  if (!fbIntent) return { handled: false };

  const sec = orgRoles.findSecretary() || { id: 'secretary', role: 'secretary', label: 'Secretary' };
  const coo = orgRoles.findHiredCoo();

  if (fbIntent === 'fb_list_accounts') {
    return {
      handled: true,
      reply: intake.buildFbAccountsListReply(),
      needsBossInput: false,
      provider: 'antleroffice-secretary',
    };
  }

  if (fbIntent === 'fb_login_status') {
    const check = await fbEngine.detectFacebookHome();
    const reply = intake.buildLoginStatusReply(check, {
      hasOpenSession: fbEngine.hasOpenSession(),
    });
    office.setAgent(sec.id, { awaitingBossInput: true });
    return {
      handled: true,
      reply,
      needsBossInput: true,
      provider: 'antleroffice-secretary',
    };
  }

  if (fbIntent === 'fb_login') {
    office.work(sec.id, 'Opening Facebook…', {
      label: 'FB login',
      step: 'Browser',
      progress: 1,
      total: 2,
    });
    try {
      const accountKey = intake.extractAccountKey(taskText);
      const open = await fbEngine.openAccount(accountKey);
      if (open.alreadyOpen) {
        office.setAgent(sec.id, {
          npcState: 'working',
          bubbleText: 'Waiting for FB login',
          awaitingBossInput: true,
        });
        return {
          handled: true,
          reply: open.message || (open.onHome
            ? 'Chrome **已在 Facebook 首页**。请回复「**登好了**」完成群组抓取（不要加「吗」）。'
            : 'Chrome **已打开**。请完成登录、进到首页后回复「**登好了**」。'),
          needsBossInput: true,
          provider: 'antleroffice-secretary',
        };
      }
      office.setAgent(sec.id, {
        npcState: 'working',
        bubbleText: 'Waiting for FB login',
        awaitingBossInput: true,
      });
      try {
        require('./pa-bridge').refreshOfficeBroadcast();
      } catch {
        /* */
      }
      return {
        handled: true,
        reply:
          open.message ||
          ('已为您打开 **Facebook**（Chrome 会保持打开，直到您回复「登好了」）。\n\n' +
            '请在 Chrome 窗口**自行输入账号和密码**（含 2FA）。\n\n' +
            '**进入 https://www.facebook.com/ 首页（Home）后**，请回复「登好了」。系统会抓取群组并回复成功或失败。'),
        needsBossInput: true,
        provider: 'antleroffice-secretary',
      };
    } catch (e) {
      office.rest(sec.id, '');
      return {
        handled: true,
        reply: `无法打开 Facebook：${e.message}\n\n请确认已运行 \`npx playwright install chrome\`（在 AntlerOffice2 目录）。`,
        needsBossInput: false,
        provider: 'antleroffice-secretary',
      };
    }
  }

  if (fbIntent === 'fb_login_done') {
    office.work(sec.id, 'Confirming login…', { label: 'FB', step: 'Groups', progress: 2, total: 3 });
    const result = await fbEngine.completeLoginFlow();
    office.setAgent(sec.id, { awaitingBossInput: true });
    if (!result.ok) {
      return {
        handled: true,
        reply: result.message,
        needsBossInput: true,
        provider: 'antleroffice-secretary',
        fbLogin: { ok: false, groupCount: result.groupCount || 0 },
      };
    }
    office.rest(sec.id, '');
    return {
      handled: true,
      reply: result.message,
      needsBossInput: true,
      provider: 'antleroffice-secretary',
      fbLogin: { ok: true, groupCount: result.groupCount || 0 },
    };
  }

  if (fbIntent === 'fb_post') {
    const readiness = intake.getFbPostingReadiness();
    if (!readiness.ready) {
      office.work(sec.id, 'FB login needed', { label: 'FB', step: 'Prompt', progress: 1, total: 2 });
      office.setAgent(sec.id, { awaitingBossInput: true });
      return {
        handled: true,
        reply: intake.buildLoginRequiredReply(taskText, readiness),
        needsBossInput: true,
        provider: 'antleroffice-secretary',
      };
    }

    if (!coo) {
      return {
        handled: true,
        reply:
          'Facebook 已登录。若要发到群组，请先在 Hire 页面聘请 **COO**，然后告诉我发帖内容，我会交给 COO 安排 Marketing。',
        needsBossInput: true,
        provider: 'antleroffice-secretary',
      };
    }

    const sessionSync = require('./secretary-intake-session-sync');
    setImmediate(() => {
      sessionSync
        .runDelegatedCeoTask({
          taskText,
          threadId,
          ownerKey: ownerKey || 'local:boss',
          sessionKey,
          label: 'Facebook 发帖',
        })
        .catch(() => {});
    });

    office.rest(sec.id, '');
    return {
      handled: true,
      reply:
        '好的，我交给 COO 安排 Marketing 发到群组。\n\n' +
        '**COO 正在执行** — 完成后此对话会自动更新；也可打开 **办公室 (Office)** 查看 COO / Marketing 状态。',
      needsBossInput: false,
      provider: 'antleroffice-secretary',
      delegated: true,
    };
  }

  return { handled: false };
}

module.exports = {
  handleSecretaryFbIntake,
  isSecretaryGatewaySession,
  extractOpenClawAgentId,
};
