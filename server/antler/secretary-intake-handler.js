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

      const ceo = orgRoles.findHiredCeo();
      if (!ceo) {
        return {
          handled: true,
          reply:
            'IT Guys 已就绪。若要开发功能，请先在 Hire 页面聘请 **CEO**，然后告诉我需求，我会交给 CEO 安排 IT 执行。',
          needsBossInput: true,
          provider: 'antleroffice-secretary',
        };
      }

      const { handleInstruction } = require('./agent-runtime');
      setImmediate(() => {
        handleInstruction(taskText, {
          threadId,
          ownerKey: ownerKey || 'local:boss',
          mode: 'agent',
        }).catch(() => {});
      });

      office.rest(sec.id, '');
      return {
        handled: true,
        reply: '好的，IT Guys 已配置完成。我交给 CEO 安排开发任务。',
        needsBossInput: false,
        provider: 'antleroffice-secretary',
        delegated: true,
      };
    }
  }

  const fbIntent = intake.classifySecretaryMessage(taskText);
  if (!fbIntent) return { handled: false };

  const sec = orgRoles.findSecretary() || { id: 'secretary', role: 'secretary', label: 'Secretary' };
  const ceo = orgRoles.findHiredCeo();

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

    if (!ceo) {
      return {
        handled: true,
        reply:
          'Facebook 已登录。若要发到群组，请先在 Hire 页面聘请 **CEO**，然后告诉我发帖内容，我会交给 CEO 安排 Marketing。',
        needsBossInput: true,
        provider: 'antleroffice-secretary',
      };
    }

    const { handleInstruction } = require('./agent-runtime');
    setImmediate(() => {
      handleInstruction(taskText, {
        threadId,
        ownerKey: ownerKey || 'local:boss',
        mode: 'agent',
      }).catch(() => {});
    });

    office.rest(sec.id, '');
    return {
      handled: true,
      reply: '好的，我交给 CEO 安排 Marketing 发到群组。',
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
