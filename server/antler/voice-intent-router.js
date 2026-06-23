const { matchStandupIntent, parseStandupPeriod } = require('./standup-intent-utils');

const SUMMARY_BROAD_RE =
  /(昨天做了什么|干了什么|做了什么|工作情况|进展如何|工作汇报|总结一下|汇报一下|各部门|所有部门|overview|recap|status update|what.*(did|happened)|work.*done)/i;

const QUERY_RE =
  /(查一下|查询|查找|搜索|找一下|who is|what is|how many|多少|哪个|where is|list |show me|tell me about)/i;

const ACTION_RE =
  /(创建|发送|安排|部署|执行|打开|关闭|导出|create|send|schedule|deploy|run |start |update |delete |export )/i;

/**
 * Fast intent router for realtime voice (rules only — no LLM).
 * @returns {{ intent: 'summary'|'query'|'action', period?: string, scope?: string, query?: string, instruction?: string }}
 */
function routeVoiceIntent(text) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'unknown' };

  const standup = matchStandupIntent(raw);
  if (standup) {
    return {
      intent: 'summary',
      period: standup.period || 'yesterday',
      scope: standup.allDepartments ? 'all' : 'all',
      source: 'standup',
    };
  }

  const period = parseStandupPeriod(raw);
  if (SUMMARY_BROAD_RE.test(raw) || period) {
    return {
      intent: 'summary',
      period: period || 'yesterday',
      scope: 'all',
      source: 'broad',
    };
  }

  if (QUERY_RE.test(raw) && !ACTION_RE.test(raw)) {
    return { intent: 'query', query: raw };
  }

  if (ACTION_RE.test(raw)) {
    return { intent: 'action', instruction: raw };
  }

  return { intent: 'query', query: raw };
}

module.exports = { routeVoiceIntent };
