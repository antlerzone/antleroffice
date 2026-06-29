# IT dev pipeline (AntlerOffice desktop)

AntlerOffice spawns local CLIs — not OpenClaw MCP — for code tasks delegated from CEO.

## Flow

1. Feature branch `antleroffice/task-*`
2. **Cursor CLI** implements the plan step
3. **Codex CLI** reviews `git diff` → `APPROVED` or `REVISION`
4. Commit on APPROVED
5. Boss **APPROVED** → `git push`

## Prerequisites

- `cursor-agent` + `CURSOR_API_KEY`
- `codex` CLI (install via IT Guys / Settings → Dev tools)

## Frontend taste

If the task builds or changes any **frontend / UI / web page**, load
`antleroffice-frontend-taste` BEFORE writing and follow its anti-slop rules
(layout, typography, spacing, motion). The reviewer checks the diff against it.
Skip it for non-UI work (scripts, crawlers, backend, infra).

## Token saver

OpenClaw = CEO planning only. Cursor = code. Codex = review. Do not overlap.
