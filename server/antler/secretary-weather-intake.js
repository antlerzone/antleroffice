/**
 * Secretary weather intake — answer locally via Open-Meteo (no exec / no CEO).
 */

const WEATHER_PATTERNS = [
  /天气/,
  /\bweather\b/i,
  /会下雨/,
  /下不下雨/,
  /几度/,
  /温度/,
  /气温/,
  /下雨吗/,
  /热不热/,
  /冷不冷/,
];

const PLACES = [
  { re: /新山|柔佛|johor\s*bahru|\bjb\b/i, label: '新山 Johor Bahru', lat: 1.4525, lon: 103.7618 },
  { re: /吉隆坡|kl\b|kuala\s*lumpur/i, label: '吉隆坡 Kuala Lumpur', lat: 3.139, lon: 101.6869 },
  { re: /新加坡|singapore/i, label: '新加坡 Singapore', lat: 1.3521, lon: 103.8198 },
  { re: /槟城|penang|george\s*town/i, label: '槟城 Penang', lat: 5.4141, lon: 100.3288 },
  { re: /马六甲|melaka|malacca/i, label: '马六甲 Melaka', lat: 2.1896, lon: 102.2501 },
];

function normalize(text) {
  return String(text || '').trim();
}

function resolvePlace(text) {
  const raw = normalize(text);
  for (const p of PLACES) {
    if (p.re.test(raw)) return p;
  }
  return { label: '新山 Johor Bahru', lat: 1.4525, lon: 103.7618 };
}

function hasKnownPlace(text) {
  const raw = normalize(text);
  return PLACES.some((p) => p.re.test(raw));
}

function priorWeatherFromConversation(recentConversation = []) {
  return (recentConversation || []).some((m) => {
    const role = String(m?.role || '').toLowerCase();
    const text = String(m?.text || m?.content || '');
    if (role === 'user' && WEATHER_PATTERNS.some((re) => re.test(text))) return true;
    if (role === 'assistant' && /Open-Meteo|今天天气|°C|降雨概率/.test(text)) return true;
    return false;
  });
}

/** Weather intent, including follow-ups like 「吉隆坡呢」 after a prior weather question. */
function classifyWeatherMessage(text, { recentUserTexts = [], recentConversation = [] } = {}) {
  const raw = normalize(text);
  if (!raw) return false;

  if (WEATHER_PATTERNS.some((re) => re.test(raw))) return true;

  if (hasKnownPlace(raw)) {
    if (/呢[？?]?$/.test(raw)) return true;
    if (/怎么样[？?]?$/.test(raw)) return true;
    if (/如何[？?]?$/.test(raw)) return true;
    if (/^那/.test(raw) && raw.length <= 28) return true;
    if (raw.length <= 14 && !/(公司|办公室|客户|去|到|在|租|房|post|facebook)/i.test(raw)) return true;
  }

  const recent = (recentUserTexts || []).slice(-4);
  const priorWeather =
    priorWeatherFromConversation(recentConversation) ||
    recent.some((t) => classifyWeatherMessage(String(t || ''), { recentUserTexts: [], recentConversation: [] }));
  if (priorWeather && (/^那/.test(raw) || /呢[？?]?$/.test(raw) || /^这边|^那边/.test(raw))) {
    return hasKnownPlace(raw) || raw.length <= 10;
  }

  return false;
}

function weatherCodeLabel(code) {
  const map = {
    0: '晴朗',
    1: '大部晴朗',
    2: '局部多云',
    3: '多云',
    45: '有雾',
    48: '雾凇',
    51: '小毛毛雨',
    53: '毛毛雨',
    55: '大毛毛雨',
    61: '小雨',
    63: '中雨',
    65: '大雨',
    80: '阵雨',
    81: '中阵雨',
    82: '大阵雨',
    95: '雷暴',
  };
  return map[code] || `代码 ${code}`;
}

async function fetchOpenMeteo({ lat, lon }) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
    '&forecast_days=1&timezone=auto';
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.current) throw new Error('Open-Meteo returned no current data');
  return data;
}

function formatWeatherReply(place, data) {
  const cur = data.current;
  const daily = data.daily || {};
  const max = daily.temperature_2m_max?.[0];
  const min = daily.temperature_2m_min?.[0];
  const rainPct = daily.precipitation_probability_max?.[0];
  const desc = weatherCodeLabel(cur.weather_code);
  const lines = [
    `**${place.label} 今天天气**`,
    '',
    `- 现在：${cur.temperature_2m}°C（体感 ${cur.apparent_temperature}°C）`,
    `- 状况：${desc}`,
    `- 湿度：${cur.relative_humidity_2m}%`,
    `- 风速：${cur.wind_speed_10m} km/h`,
  ];
  if (typeof max === 'number' && typeof min === 'number') {
    lines.push(`- 今日：${min}°C ~ ${max}°C`);
  }
  if (typeof rainPct === 'number') {
    lines.push(`- 降雨概率：${rainPct}%`);
  }
  if (typeof cur.precipitation === 'number' && cur.precipitation > 0) {
    lines.push(`- 当前降水量：${cur.precipitation} mm`);
  }
  lines.push('', '（数据来源：Open-Meteo）');
  return lines.join('\n');
}

async function buildWeatherReply(text) {
  const place = resolvePlace(text);
  const data = await fetchOpenMeteo(place);
  return formatWeatherReply(place, data);
}

module.exports = {
  classifyWeatherMessage,
  resolvePlace,
  buildWeatherReply,
  WEATHER_PATTERNS,
};
