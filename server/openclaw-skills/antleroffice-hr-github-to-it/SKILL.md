# AntlerOffice Human Resource — GitHub to IT Junior

Use this skill when the COO delegates a request to import a GitHub repository's capability into an existing IT NPC worker (typically `vip_it_junior`).

## Golden Rule

**Never write to any NPC bundle without the boss's explicit approval.**
Always read → analyze → draft → wait for boss to say "发布" / "publish" → then call `update_saas_worker`.

## Step 1 — Intake

Ask the boss (via COO) if not already provided:

| Field | Question |
|-------|----------|
| GitHub URL | GitHub 仓库的链接是什么？ |
| 目标 NPC | 要加到哪个 NPC？（默认 `vip_it_junior`） |
| 技能名字 | 这个新技能叫什么？（给个简短名字，snake_case） |
| 用途说明 | 这个工具主要用来做什么？（方便我写 SKILL.md） |

## Step 2 — 读取 GitHub 仓库

使用 web fetch / firecrawl 读取以下内容（按优先级）：

1. `README.md` — 了解工具用途、安装方式、使用方法
2. `package.json` / `pyproject.toml` — 了解依赖、命令
3. 主要入口文件（`index.js`, `main.py` 等）— 了解 API/CLI 接口

提炼出：
- **工具做什么**（一句话）
- **如何调用**（命令、API、参数）
- **输入/输出格式**
- **是否是 MCP server**（有没有 `mcp` 相关内容）

## Step 3 — Draft 给 COO 看

```
📦 GitHub 技能 Draft — [技能名字]

仓库: [GitHub URL]
目标 NPC: [templateId]

工具说明:
  [一句话描述这个工具做什么]

调用方式:
  [命令 / API 端点 / 函数调用方式]

输入: [参数说明]
输出: [返回内容说明]

是否 MCP Server: 是 / 否

新增技能 ID: [skill_id]
新增 OpenClaw 技能: [antleroffice-{npc}-{skill_name}]

SKILL.md 摘要:
  [IT Junior 拿到这个技能后，它会怎么用这个工具，简短描述工作流]

请老板确认，说「发布」我就写入 IT Junior bundle。
```

**等老板确认，不要自动继续。**

## Step 4 — 发布（收到"发布"后）

调用 `update_saas_worker`，传入：

```json
{
  "templateId": "vip_it_junior",
  "skills": [
    {
      "id": "skill_id_snake_case",
      "name": "Skill Display Name",
      "system": "完整的 system prompt，描述 IT Junior 如何使用这个 GitHub 工具完成任务"
    }
  ],
  "openclawSkills": [
    {
      "folderName": "antleroffice-it_junior-skill-name",
      "markdown": "# AntlerOffice IT Junior — Skill Name\n\n完整的 SKILL.md 内容"
    }
  ]
}
```

## Step 5 — 回报

回报格式：
```
✅ 已将 [技能名字] 加入 [NPC 名字]

新增 skillId: [skill_id]
新增 SKILL.md: [folderName]

git 路径:
  server/data/catalog.json
  server/bundles/[templateId]/

请老板 git commit + git push server/ 到 ECS 正式生效。
```

## 注意事项

- 如果 GitHub 是一个 **MCP server**，在 SKILL.md 里写清楚如何启动 + 端口
- 如果需要 `npm install` 或 `pip install`，在 SKILL.md 里加 Prerequisites 步骤
- 不要把 API keys 或 secrets 写进 SKILL.md，提醒老板通过 `save_web_account` 保存

## 工具

| 工具 | 用途 |
|------|------|
| web fetch / firecrawl | 读取 GitHub README 和关键文件 |
| `list_saas_workers` | 确认目标 NPC 存在 + 查看现有技能 |
| `update_saas_worker` | 把新技能 merge 进现有 NPC bundle |
