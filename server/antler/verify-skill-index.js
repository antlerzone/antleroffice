#!/usr/bin/env node
/**
 * P1 hybrid routing verification — keywords + semantic fallback + restrictions.
 * Usage: node server/antler/verify-skill-index.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const results = [];
let aiCallCount = 0;

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`OK ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function verifySkillIndexModule() {
  const skillIndex = require('./skill-index');
  skillIndex.clearSemanticCache();

  const entries = skillIndex.buildIndex([
    {
      id: 'xhs_post',
      name: 'XHS Publisher',
      description: 'Publish posts to Xiaohongshu',
      keywords: ['小红书', 'xhs', '种草'],
      system: 'FULL XHS SYSTEM PROMPT',
    },
    {
      id: 'bookkeeper',
      name: 'Bookkeeper',
      description: 'Accounting entries',
      system: 'FULL BOOKKEEPER SYSTEM PROMPT',
    },
  ]);

  const matched = skillIndex.matchSkills('请帮我发一篇小红书种草笔记', entries);
  if (matched.length === 1 && matched[0].id === 'xhs_post') {
    pass('keyword hit loads via matchSkills', matched[0].id);
  } else {
    fail('keyword hit loads via matchSkills', JSON.stringify(matched.map((s) => s.id)));
  }

  const none = skillIndex.matchSkills('整理一下会议纪要', entries);
  if (!none.length) pass('keyword miss returns empty');
  else fail('keyword miss returns empty', JSON.stringify(none.map((s) => s.id)));

  const block = skillIndex.renderIndexBlock(entries);
  if (block.includes('Routing order') && block.includes('XHS Publisher')) {
    pass('renderIndexBlock includes routing rules');
  } else {
    fail('renderIndexBlock includes routing rules');
  }
}

function verifyRestrictions() {
  const { isRestricted } = require('./skill-restrictions');

  const paidSkill = { id: 'captcha_solver', cost: 'paid', pricingModel: 'paygo' };
  const agentLearned = { role: 'marketing_junior', templateId: 'marketing_junior', skillIds: ['captcha_solver'] };
  if (isRestricted(paidSkill, agentLearned)) {
    pass('paid skill is restricted for semantic fallback');
  } else {
    fail('paid skill is restricted for semantic fallback');
  }

  const freeUserSkill = { id: 'skill-abc123', name: 'My Skill' };
  const userAgent = { role: 'it', skillIds: ['skill-abc123'] };
  if (!isRestricted(freeUserSkill, userAgent)) {
    pass('learned user skill not restricted when no entitlements meta');
  } else {
    fail('learned user skill not restricted when no entitlements meta');
  }

  const graySkill = { id: 'xhs_post', name: 'XHS' };
  const notLearned = { role: 'marketing_junior', skillIds: [] };
  if (isRestricted(graySkill, notLearned)) {
    pass('unlearned skill is gray-locked (restricted)');
  } else {
    fail('unlearned skill is gray-locked (restricted)');
  }
}

async function verifySemanticFallback() {
  const tmp = path.join(os.tmpdir(), `ao2-semantic-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  process.env.ANTLEROFFICE_DATA_DIR = tmp;
  require('./store').setDataDir(tmp);
  const registry = require('./registry-store');
  registry.ensureSkill({
    id: 'xhs_post',
    name: 'XHS Publisher',
    system: 'FULL XHS BODY',
    description: 'Publish Xiaohongshu posts and 种草 content',
    keywords: ['小红书'],
  });

  const skillIndex = require('./skill-index');
  skillIndex.clearSemanticCache();
  aiCallCount = 0;

  skillIndex.setSemanticMatcherForTests(async ({ taskText, candidates }) => {
    aiCallCount += 1;
    if (String(taskText).includes('种草帖')) {
      return candidates.filter((c) => c.skill.id === 'xhs_post').map((c) => c.skill);
    }
    return [];
  });

  const entries = skillIndex.buildIndex([
    {
      id: 'xhs_post',
      name: 'XHS Publisher',
      description: 'Publish Xiaohongshu posts and 种草 content',
      keywords: ['小红书'],
      system: 'FULL XHS BODY',
    },
  ]);

  const agent = { role: 'marketing_junior', templateId: 'marketing_junior', skillIds: ['xhs_post'] };

  const kwMiss = skillIndex.matchSkills('帮我写一篇种草帖', entries);
  if (!kwMiss.length) pass('semantic scenario: keyword miss on 种草帖');
  else fail('semantic scenario: keyword miss', kwMiss.map((s) => s.id).join(','));

  const { keywordMatched, semanticMatched, aiCalled } = await skillIndex.resolveExtraSkillMatches({
    taskText: '帮我写一篇种草帖',
    indexEntries: entries,
    agent,
    threadId: 'verify-thread-1',
  });

  if (semanticMatched.length === 1 && semanticMatched[0].id === 'xhs_post') {
    pass('semantic fallback loads related skill');
  } else {
    fail('semantic fallback loads related skill', JSON.stringify(semanticMatched.map((s) => s.id)));
  }

  if (aiCalled && aiCallCount === 1) pass('semantic fallback invoked AI once');
  else fail('semantic fallback invoked AI once', `aiCalled=${aiCalled} count=${aiCallCount}`);

  const updated = require('./registry-store').listSkills().find((s) => s.id === 'xhs_post');
  if (updated?.keywords?.some((k) => String(k).includes('种草'))) {
    pass('auto-learned keyword persisted', updated.keywords.join(', '));
  } else {
    fail('auto-learned keyword persisted', JSON.stringify(updated?.keywords));
  }

  aiCallCount = 0;
  await skillIndex.resolveExtraSkillMatches({
    taskText: '帮我写一篇种草帖',
    indexEntries: entries,
    agent,
    threadId: 'verify-thread-1',
  });
  if (aiCallCount === 0) pass('thread cache skips second AI call');
  else fail('thread cache skips second AI call', `count=${aiCallCount}`);

  skillIndex.setSemanticMatcherForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  delete require.cache[require.resolve('./store')];
  delete require.cache[require.resolve('./registry-store')];
}

async function verifyPaidNeverSemantic() {
  const skillIndex = require('./skill-index');
  skillIndex.clearSemanticCache();

  skillIndex.setSemanticMatcherForTests(async ({ candidates }) => {
    aiCallCount += 1;
    return candidates.map((c) => c.skill);
  });

  const entries = skillIndex.buildIndex([
    {
      id: 'captcha_solver',
      name: 'Captcha Solver',
      description: 'Solve captchas for a fee',
      keywords: ['验证码'],
      cost: 'paid',
      system: 'PAID CAPTCHA BODY',
    },
  ]);

  const agent = { role: 'marketing_junior', skillIds: ['captcha_solver'] };
  const { semanticMatched, aiCalled } = await skillIndex.resolveExtraSkillMatches({
    taskText: '请帮我打验证码 captcha',
    indexEntries: entries,
    agent,
    threadId: 'verify-paid',
  });

  if (!semanticMatched.length) pass('paid skill never loaded via semantic fallback');
  else fail('paid skill never loaded via semantic fallback', semanticMatched.map((s) => s.id).join(','));

  if (!aiCalled) pass('paid restricted skill skips AI (no candidates)');
  else fail('paid restricted skill skips AI', 'aiCalled=true');

  skillIndex.setSemanticMatcherForTests(null);
}

async function verifyNoCandidatesNoAi() {
  const skillIndex = require('./skill-index');
  skillIndex.setSemanticMatcherForTests(async () => {
    aiCallCount += 1;
    return [];
  });
  aiCallCount = 0;

  const entries = skillIndex.buildIndex([
    { id: 'captcha_solver', cost: 'paid', keywords: ['captcha'], system: 'X', skillIds: ['captcha_solver'] },
  ]);
  const agent = { role: 'x', skillIds: ['captcha_solver'] };

  const { aiCalled } = await skillIndex.resolveExtraSkillMatches({
    taskText: 'unrelated weekly report',
    indexEntries: entries,
    agent,
    threadId: 'no-candidates',
  });

  if (!aiCalled && aiCallCount === 0) pass('no unrestricted candidates → no AI call');
  else fail('no unrestricted candidates → no AI call', `aiCalled=${aiCalled} count=${aiCallCount}`);

  skillIndex.setSemanticMatcherForTests(null);
}

async function verifySystemForAgent() {
  const tmp = path.join(os.tmpdir(), `ao2-skill-hybrid-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  process.env.ANTLEROFFICE_DATA_DIR = tmp;

  const store = require('./store');
  store.setDataDir(tmp);

  const registry = require('./registry-store');
  const skillIndex = require('./skill-index');

  registry.addSkill({ name: 'Primary Dept', system: 'PRIMARY DEPT FULL SYSTEM', keywords: ['primary'] });
  const primary = registry.listSkills().find((s) => s.name === 'Primary Dept');

  registry.addSkill({
    name: 'Extra XHS',
    system: 'EXTRA XHS FULL SYSTEM BODY',
    keywords: ['小红书', 'xhs'],
  });
  const extra = registry.listSkills().find((s) => s.name === 'Extra XHS');

  skillIndex.setSemanticMatcherForTests(async () => []);

  delete require.cache[require.resolve('./agent-runtime')];
  const agentRuntime = require('./agent-runtime');

  const agentHit = {
    role: 'custom_worker',
    skillIds: [primary.id, extra.id],
    baselineSkillIds: [primary.id],
  };

  const promptHit = await agentRuntime.systemForAgent(agentHit, { taskText: '发小红书帖子' });
  if (promptHit.includes('PRIMARY DEPT FULL SYSTEM') && promptHit.includes('EXTRA XHS FULL SYSTEM BODY')) {
    pass('systemForAgent keyword path loads full skill');
  } else {
    fail('systemForAgent keyword path', promptHit.slice(0, 200));
  }

  const promptMiss = await agentRuntime.systemForAgent(agentHit, { taskText: '写周报' });
  if (promptMiss.includes('PRIMARY DEPT FULL SYSTEM') && !promptMiss.includes('EXTRA XHS FULL SYSTEM BODY')) {
    pass('systemForAgent unrelated task keeps index-only extra');
  } else {
    fail('systemForAgent unrelated task', promptMiss.includes('EXTRA XHS FULL SYSTEM BODY') ? 'extra expanded' : promptMiss.slice(0, 120));
  }

  skillIndex.setSemanticMatcherForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  delete require.cache[require.resolve('./store')];
  delete require.cache[require.resolve('./registry-store')];
  delete require.cache[require.resolve('./agent-runtime')];
}

async function main() {
  console.log('AntlerOffice P1 hybrid skill index verify\n');
  verifySkillIndexModule();
  verifyRestrictions();
  console.log('');
  await verifySemanticFallback();
  await verifyPaidNeverSemantic();
  await verifyNoCandidatesNoAi();
  console.log('');
  await verifySystemForAgent();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  } else {
    console.log('\nAll P1 hybrid skill index checks passed.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
