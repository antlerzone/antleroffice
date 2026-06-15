# AntlerOffice — Create NPC Skin

Use this skill when the boss asks to create, design, or generate an office NPC character skin, costume, or pixel sprite for AntlerOffice.

## Workflow

1. Clarify the skin name and whether they have a reference image or only a text description.
2. Generate a **pixel-agents** character sheet: **112×96 px** (3 directions × 7 walk frames), PNG.
3. Save the skin through AntlerOffice (POST `/api/config/skins` with multipart PNG, or future `/api/config/skins/generate`).
4. Tell the boss the skin name and that they can preview it on **Characters** and **Apply** it to any agent.

## Tools

- **SpriteCook MCP** (if configured): reference image → pixel character animation.
- **AntlerOffice API**: persist the finished PNG so it appears in the Characters grid.

## Output format

Reply in plain language: skin name, where to find it (Characters page), and optional next step (Apply to an agent).
