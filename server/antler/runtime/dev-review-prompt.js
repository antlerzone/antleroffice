// Shared code review prompt for all dev engines (Cursor / Claude / Codex).

const REVIEW_TEMPLATE = `You are a strict code reviewer. Compare the implementation diff against the plan.

Reply on the FIRST line with exactly one of:
APPROVED
REVISION: <specific feedback>

Then provide a short review summary.

## Plan
{{PLAN}}

## Git diff
{{DIFF}}
`;

function buildReviewPrompt({ plan, diff }) {
  return REVIEW_TEMPLATE.replace('{{PLAN}}', String(plan || '(no plan)'))
    .replace('{{DIFF}}', String(diff || '(empty diff)').slice(0, 120000));
}

module.exports = { buildReviewPrompt, REVIEW_TEMPLATE };
