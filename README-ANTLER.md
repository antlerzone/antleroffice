# AntlerOffice 2.0

**Mission:** Let anyone — especially non-technical bosses — use **OpenClaw** and **Hermes** without the command line.

AntlerOffice 2.0 is a friendly local web product built on a fork of [OpenClaw-Admin](https://github.com/itq5/OpenClaw-Admin) (MIT). The upstream project provides the engine; this repo adds the **boss-first** experience from AntlerOffice v1.

Original **AntlerOffice/** (v1) in the parent folder is kept as a **read-only backup**.

## Quick start

```powershell
cd AntlerOffice2
npm install
cp .env.example .env   # if needed
npm run dev:all
```

- **Frontend:** http://localhost:3001 (Vite)
- **Backend API:** http://localhost:3020 (Express + Antler modules)

Open **Office** in the sidebar — that's the pixel-agents virtual office (replaces Admin MyWorld).

## Boss menu (default)

| Page | Path | What it does |
|------|------|----------------|
| Office | `/office` | Pixel office + boss chat |
| Home | `/home` | Credits, plan, agent count |
| Hire | `/hire` | Browse & hire template agents |
| Skins | `/skins` | Costume / palette for NPCs |
| Integrations | `/integrations` | API keys & default model (no CLI) |

First launch shows **Setup wizard**: one-click install OpenClaw/Hermes + save API key + **Default MCP pack** (Playwright → IT; Perplexity + Firecrawl → COO/Admin).

Toggle **Advanced** in the sidebar footer to expose OpenClaw-Admin tools (terminal, sessions, channels, Hermes, etc.).

## Data

- Antler registry & settings: `~/.antleroffice2/`
- OpenClaw config (when installed): `~/.openclaw/openclaw.json`

## Upstream

Based on OpenClaw-Admin **v1.0.2**. MIT License — see upstream [LICENSE](https://github.com/itq5/OpenClaw-Admin/blob/main/LICENSE).

Antler-specific code lives in:

- `server/antler/` — backend (office bridge, onboarding, hire, billing)
- `src/views/antler/` — boss UI pages
- `public/office-pa/` — pixel-agents webview

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev:all` | Frontend + backend (development) |
| `npm run build` | Production Vue build → `dist/` |
| `npm run start` | Serve built app + API (after `npm run build`) |
