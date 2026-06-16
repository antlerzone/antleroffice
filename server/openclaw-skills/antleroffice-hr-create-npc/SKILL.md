# AntlerOffice — Create SaaS Worker (Human Resource)

Use this skill when the platform operator wants to **create a new SaaS NPC worker** on the ECS catalog — not hire someone into a local pixel office.

## Prerequisites

- Local ECS server running (`server/` on `:3030`)
- AntlerOffice Tools MCP reachable at `http://127.0.0.1:8931/mcp`

## Workflow

1. Call **`list_saas_workers`** — existing departments + template ids + installable flag.
2. Gather requirements: name, tagline, category, role, skills, MCPs.
3. **Required (English):** `description` (plain English, ≥80 chars) + `examples` (≥2 real scenarios for beginners).
4. Draft ECS skills (`skills[].system`) and OpenClaw `SKILL.md` per `openclawSkillNames[]`.
5. Confirm with the boss.
6. **Before publish:** confirm `salaryCreditsPerMonth`. Ask if the worker should be **hidden** from public browse. If yes: `visibility: hidden` + `hirePassword` (min 4 chars). Hidden agents are found in AntlerOffice 2.0 **only by catalogUuid search**.
7. Call **`create_saas_worker`** with full payload.
8. Reply with `templateId`, `departmentId`, `catalogUuid`, `visibility`, git paths, and **git push server/** reminder.

## Payload shape

```json
{
  "templateId": "marketing_posts",
  "department": {
    "id": "marketing_posts_dept",
    "category": "growth",
    "name": "Marketing Posts",
    "tagline": "Short one-liner for cards",
    "role": "marketing",
    "salaryCreditsPerMonth": 199,
    "salaryUsdPerMonth": 199,
    "visibility": "public",
    "bundleTemplateId": "marketing_posts",
    "active": true,
    "featured": false,
    "sortOrder": 110
  },
  "template": {
    "role": "marketing",
    "description": "Plain English paragraph explaining what this agent does for non-technical users (at least 80 characters).",
    "examples": [
      "Example: Ask this agent to draft a week of LinkedIn posts from your product notes.",
      "Example: Turn a launch brief into email + social copy without writing prompts yourself."
    ],
    "skillIds": ["marketing_posts"],
    "openclawSkillNames": ["marketing-posts"],
    "mcps": [],
    "version": "1.0.0",
    "highlights": ["..."]
  },
  "skills": [{ "id": "marketing_posts", "name": "...", "system": "..." }],
  "openclawSkills": [{ "folderName": "marketing-posts", "markdown": "# ..." }]
}
```

For **hidden** workers, add to `department`:

```json
{
  "visibility": "hidden",
  "hirePassword": "boss-chosen-secret"
}
```

## Tools

| Tool | Purpose |
|------|---------|
| `list_saas_workers` | Browse SaaS catalog |
| `get_saas_worker` | Inspect one worker |
| `create_saas_worker` | Write catalog + bundle + department |

## Output

Plain language. End with git deploy step: commit `server/data` and `server/bundles`, push to ECS. For hidden workers, give the **catalogUuid** so the boss can search in AntlerOffice 2.0.
