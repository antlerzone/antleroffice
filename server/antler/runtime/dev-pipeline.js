// Dev pipeline: resolve repo → feature branch → writer engine → sequential reviewers → commit.

const store = require('../store');
const workflow = require('../workflow-context');
const ceoPending = require('../ceo-pipeline-pending');
const projectResolver = require('./dev-project-resolver');
const devGit = require('./dev-git');
const { getEngine } = require('./dev-engine-registry');
const devTeamResolver = require('./dev-team-resolver');
const itRepoQueue = require('./it-repo-queue');

function devSettings() {
  return store.readSettings().dev || {};
}

function buildDevPrompt({ instruction, plan, brief, revisionFeedback }) {
  const parts = [
    'You are the developer agent. Implement the task in this repository.',
    'Make minimal, focused changes. Match existing code style.',
    '',
    `## Task\n${instruction}`,
  ];
  if (brief) parts.push('', `## CEO brief\n${brief}`);
  if (plan) parts.push('', `## Implementation plan\n${plan}`);
  if (revisionFeedback) {
    parts.push('', `## Revision feedback (address all items)\n${revisionFeedback}`);
  }
  parts.push('', 'When done, summarize files changed.');
  return parts.join('\n');
}

function agentLabel(agent) {
  return agent?.label || agent?.name || agent?.devEngine || 'developer';
}

function formatSummary({ projectRoot, branchName, diffStat, reviewText, round, writer, reviewers, selfReview }) {
  const writerName = agentLabel(writer);
  const reviewerNames = (reviewers || []).map(agentLabel).join(', ') || writerName;
  const lines = [
    `## Dev pipeline complete (${selfReview ? 'self-review' : 'review'} APPROVED)`,
    '',
    `- **Writer:** ${writerName}`,
    `- **Reviewer(s):** ${reviewerNames}`,
    `- **Project:** \`${projectRoot}\``,
    `- **Branch:** \`${branchName}\``,
    `- **Review rounds:** ${round}`,
  ];
  if (diffStat) {
    lines.push('', '## Diff stat', '```', diffStat, '```');
  }
  if (reviewText) {
    lines.push('', '## Final review', reviewText.slice(0, 4000));
  }
  lines.push(
    '',
    '---',
    'CEO will ask the boss to **APPROVED** push to GitHub, or **REVISION** for more changes.',
  );
  return lines.join('\n');
}

async function ensureEngineReady(engineName, role) {
  const eng = getEngine(engineName);
  if (!eng) {
    return { ok: false, text: `Unknown dev engine: ${engineName}` };
  }
  const probed = await eng.probe();
  if (!probed.installed) {
    return {
      ok: false,
      needsBossInput: true,
      text: `${engineName} CLI not installed. Install it in **Settings → Dev tools**.`,
      missingEngine: engineName,
    };
  }
  const authed = await eng.hasAuth();
  if (!authed) {
    return {
      ok: false,
      needsBossInput: true,
      text:
        `${engineName} API key / auth required for ${role}. Add it in **Settings → Dev tools** (stored locally on this machine).`,
      missingEngineAuth: engineName,
    };
  }
  return { ok: true, eng };
}

async function runDevPipeline({
  agent,
  instruction,
  plan = '',
  brief = '',
  rawTask = '',
  threadId = null,
  onLog = () => {},
  projectRoot: projectRootIn,
} = {}) {
  const dev = devSettings();
  const maxRounds = Math.max(1, Number(dev.maxReviewRounds) || 3);
  const prefix = String(dev.branchPrefix || 'antleroffice/task-').trim();

  const teamResolved = devTeamResolver.resolveOfficeDevTeam();
  if (!teamResolved.ok) {
    return {
      ok: false,
      needsBossInput: true,
      text:
        'Dev team not configured. Open **Settings → Dev tools** and set **Writer** and **Reviewer(s)**.\n\n' +
        teamResolved.errors.join('\n'),
      provider: 'dev-pipeline',
      missingDevTeam: true,
    };
  }

  const writer = teamResolved.writerOffice;
  const reviewers = teamResolved.reviewerOffices || [];
  const selfReview = reviewers.length === 1 && reviewers[0]?.registryId === writer?.registryId;

  const writerReady = await ensureEngineReady(writer.devEngine, 'writing code');
  if (!writerReady.ok) return { ...writerReady, provider: 'dev-pipeline' };

  for (const reviewer of reviewers) {
    const revReady = await ensureEngineReady(reviewer.devEngine, 'code review');
    if (!revReady.ok) return { ...revReady, provider: 'dev-pipeline' };
  }

  let projectRoot = projectRootIn;
  if (!projectRoot) {
    const pending = ceoPending.get(threadId);
    if (pending?.projectRoot) projectRoot = pending.projectRoot;
  }
  if (!projectRoot) {
    const resolved = projectResolver.resolveDevProjectRoot();
    if (!resolved.ok) {
      ceoPending.patch(threadId, {
        phase: 'project_path',
        candidates: resolved.candidates || [],
        instruction,
        plan,
        brief,
        rawTask,
        agentId: agent?.id,
      });
      return {
        ok: false,
        needsBossInput: true,
        text: resolved.message,
        provider: 'dev-pipeline',
      };
    }
    projectRoot = resolved.projectRoot;
    onLog(`Using project: ${projectRoot}`);
  }

  onLog(`Repo queue: acquiring lock for ${projectRoot}`);
  return itRepoQueue.runExclusive(projectRoot, () =>
    runDevPipelineForProject({
      agent,
      instruction,
      plan,
      brief,
      rawTask,
      threadId,
      onLog,
      projectRoot,
      maxRounds,
      prefix,
      writer,
      reviewers,
      selfReview,
    }),
  );
}

async function runDevPipelineForProject({
  agent,
  instruction,
  plan,
  brief,
  rawTask,
  threadId,
  onLog,
  projectRoot,
  maxRounds,
  prefix,
  writer,
  reviewers,
  selfReview,
}) {
  const slug = devGit.slugifyTask(rawTask || instruction);
  const branchName = `${prefix}${slug}-${Date.now().toString(36)}`;
  const checkout = await devGit.checkoutBranch(projectRoot, branchName);
  if (!checkout.ok) {
    return {
      ok: false,
      text: `Could not create branch ${branchName}: ${checkout.stderr || checkout.stdout}`,
      provider: 'dev-pipeline',
    };
  }
  onLog(`Branch: ${branchName}`);

  const writerEng = getEngine(writer.devEngine);
  let revisionFeedback = '';
  let lastReviewText = '';
  let round = 0;

  for (round = 1; round <= maxRounds; round++) {
    onLog(`${writer.devEngine} dev (${agentLabel(writer)}) · round ${round}/${maxRounds}`);
    const devPrompt = buildDevPrompt({ instruction, plan, brief, revisionFeedback });
    const devResult = await writerEng.runDev({
      prompt: devPrompt,
      projectRoot,
      onChunk: (line) => onLog(`${writer.devEngine}: ${line}`),
    });
    if (!devResult.ok) {
      return {
        ok: false,
        text: `Dev failed (${writer.devEngine}): ${devResult.error || devResult.text || 'unknown error'}`,
        provider: devResult.provider || writer.devEngine,
        branchName,
        projectRoot,
      };
    }

    const diff = await devGit.fullDiff(projectRoot);
    if (!diff.trim()) {
      return {
        ok: false,
        text: 'Developer finished but git diff is empty — no files changed.',
        provider: writer.devEngine,
        branchName,
        projectRoot,
      };
    }

    let approved = true;
    let combinedFeedback = '';

    for (let ri = 0; ri < reviewers.length; ri++) {
      const reviewer = reviewers[ri];
      const revEng = getEngine(reviewer.devEngine);
      onLog(
        `${reviewer.devEngine} review (${agentLabel(reviewer)}) · round ${round}/${maxRounds} · reviewer ${ri + 1}/${reviewers.length}`,
      );
      const review = await revEng.runReview({
        plan: plan || instruction,
        diff,
        projectRoot,
        onChunk: (line) => onLog(`${reviewer.devEngine}: ${line}`),
      });
      lastReviewText = review.text || '';
      if (!review.ok) {
        return {
          ok: false,
          text: `Review failed (${reviewer.devEngine}): ${review.error || lastReviewText || 'unknown error'}`,
          provider: review.provider || reviewer.devEngine,
          branchName,
          projectRoot,
        };
      }

      const outcome = workflow.parseReviewOutcome(lastReviewText);
      if (!outcome.approved) {
        approved = false;
        combinedFeedback = combinedFeedback
          ? `${combinedFeedback}\n\n---\n\n${agentLabel(reviewer)}:\n${lastReviewText}`
          : `${agentLabel(reviewer)}:\n${lastReviewText}`;
        break;
      }
    }

    if (approved) break;

    if (round < maxRounds) {
      revisionFeedback = combinedFeedback || lastReviewText;
      onLog('Reviewer requested REVISION — retrying with writer…');
      continue;
    }

    return {
      ok: false,
      text: `Review did not approve after ${round} round(s).\n\n${combinedFeedback || lastReviewText}`,
      provider: 'dev-pipeline',
      branchName,
      projectRoot,
    };
  }

  const diffStat = await devGit.diffStat(projectRoot);
  const reviewerLabel = reviewers.map((r) => r.devEngine).join('+');
  const commitMsg = `antleroffice: ${slug}\n\nAutomated dev pipeline (${writer.devEngine} + ${reviewerLabel})`;
  const commit = await devGit.commitAll(projectRoot, commitMsg);
  if (!commit.ok) {
    return {
      ok: false,
      text: `Commit failed: ${commit.stderr || commit.stdout}`,
      provider: 'dev-pipeline',
      branchName,
      projectRoot,
    };
  }

  const summary = formatSummary({
    projectRoot,
    branchName,
    diffStat,
    reviewText: lastReviewText,
    round,
    writer,
    reviewers,
    selfReview,
  });
  ceoPending.patch(threadId, {
    phase: 'push_approval',
    projectRoot,
    branchName,
    devSummary: summary,
    agentId: agent?.id,
  });

  return {
    ok: true,
    text: summary,
    provider: `dev-pipeline:${writer.devEngine}`,
    needsBossInput: true,
    awaitingPushApproval: true,
    branchName,
    projectRoot,
    reviewApproved: true,
    writerEngine: writer.devEngine,
    reviewerEngines: reviewers.map((r) => r.devEngine),
  };
}

async function pushApprovedDev(threadId) {
  const pending = ceoPending.get(threadId);
  if (!pending?.projectRoot || !pending?.branchName) {
    return { ok: false, error: 'No pending dev branch to push.' };
  }
  const push = await devGit.pushBranch(pending.projectRoot, pending.branchName);
  if (!push.ok) {
    return {
      ok: false,
      error: push.stderr || push.stdout || 'git push failed',
      branchName: pending.branchName,
      projectRoot: pending.projectRoot,
    };
  }
  ceoPending.clear(threadId);
  return {
    ok: true,
    text: `Pushed \`${pending.branchName}\` to origin.`,
    branchName: pending.branchName,
    projectRoot: pending.projectRoot,
  };
}

async function tryResolveProjectFromBossMessage(text, threadId) {
  const pending = ceoPending.get(threadId);
  if (!pending || pending.phase !== 'project_path') return null;
  // Boss pasted a GitHub/git URL -> clone it, then use the local clone.
  if (projectResolver.isGitUrl(text)) {
    const res = projectResolver.cloneRepoToWorkspace(text);
    if (!res.ok) return null;
    ceoPending.patch(threadId, { projectRoot: res.projectRoot, phase: null });
    return res.projectRoot;
  }
  const choice = projectResolver.parseBossProjectChoice(text, pending.candidates || []);
  if (!choice) return null;
  ceoPending.patch(threadId, { projectRoot: choice, phase: null });
  return choice;
}

module.exports = {
  runDevPipeline,
  runDevPipelineForProject,
  pushApprovedDev,
  tryResolveProjectFromBossMessage,
  buildDevPrompt,
};
