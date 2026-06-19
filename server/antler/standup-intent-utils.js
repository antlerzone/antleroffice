const STANDUP_MEETING_RE =
  /(开会|汇报会|晨会|站会|部门会|standup|all departments|every department|convene|department meeting|team meeting|叫.{0,6}部门|让.{0,6}部门|召集.{0,6}部门)/i;

const STANDUP_ALL_DEPTS_RE = /(所有部门|各部门|全部部门|every department|all departments)/i;

const STANDUP_PERIOD_RULES = [
  { period: 'last_week', re: /(上周|上星期|上个星期|上一周|last week|past week)/i },
  { period: 'last_7_days', re: /(近一周|近7日|近七天|最近7天|last 7 days|past 7 days)/i },
  { period: 'yesterday', re: /(昨天|昨日|yesterday)/i },
];

const STANDUP_PDF_RE =
  /(pdf|导出|生成.{0,8}(报告|汇报|晨会)|save.{0,12}(pdf|report)|export.{0,12}(pdf|report)|放到桌面|放桌面|save.{0,8}desktop)/i;
const STANDUP_PDF_CONTEXT_RE = /(汇报|晨会|standup|report|刚刚|刚才|最新|latest|complete job)/i;

const PLAYBACK_STOP_RE = /^(等等|等一下|停|停下|停止|停一下|stop|hold on)/i;
const PLAYBACK_CONTINUE_RE = /^(继续|下一位|下一个|next|go on|resume)/i;
const PLAYBACK_FOLLOW_RE = /(更多|详情|重复|展开|细节|说说|补充|elaborate|more detail|repeat|explain)/i;

function parseStandupPeriod(text) {
  for (const rule of STANDUP_PERIOD_RULES) {
    if (rule.re.test(text)) return rule.period;
  }
  return null;
}

function matchStandupIntent(text) {
  const raw = String(text || '').trim();
  if (!raw || !STANDUP_MEETING_RE.test(raw)) return null;
  return {
    action: 'standup_start',
    period: parseStandupPeriod(raw),
    allDepartments: STANDUP_ALL_DEPTS_RE.test(raw),
  };
}

function matchStandupPdfIntent(text) {
  const raw = String(text || '').trim();
  if (!raw || !STANDUP_PDF_RE.test(raw)) return null;
  if (!STANDUP_PDF_CONTEXT_RE.test(raw)) return null;
  return { action: 'standup_export_pdf' };
}

function classifyPlaybackIntent(text, interrupted = false) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (PLAYBACK_STOP_RE.test(raw)) return 'stop';
  if (PLAYBACK_CONTINUE_RE.test(raw)) return 'continue';
  if (PLAYBACK_FOLLOW_RE.test(raw) || interrupted) return 'follow_up';
  return 'follow_up';
}

module.exports = {
  parseStandupPeriod,
  matchStandupIntent,
  matchStandupPdfIntent,
  classifyPlaybackIntent,
};
