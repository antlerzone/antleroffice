# AntlerOffice Human Resource — Create NPC

Use this skill when the COO delegates a request to create a new SaaS NPC worker on the ECS catalog.

## Golden Rule

**Never publish without the boss's explicit approval.**
Always draft first → present to COO → wait for boss to say "发布" / "publish" → then execute.

## Step 1 — Intake (ask the boss via COO)

Collect all of the following before drafting anything:

| Field | Question to ask |
|-------|----------------|
| NPC 名字 | 这个 NPC 叫什么？（中文显示名） |
| Tagline | 一句话描述它做什么？ |
| 类别 | 属于哪个类别？(growth / operations / finance / product / executive) |
| Role key | 内部 role 标识？（snake_case，如 `social_media`） |
| 技能 | 它能做什么？列出 2-4 个核心技能，每个给一个简短 system prompt |
| 价钱 | 月费多少 credits？ |
| Hidden? | 是否隐藏？需要密码才能聘请？如果是，密码是什么？ |
| 皮肤 | 默认皮肤颜色？(slate / forest / coral / gold / ocean / mint / sky / lavender / amber) |
| Featured? | 是否在市场首页展示？ |
| Sort order | 排序号？（数字越小越前，可以先用 999） |
| MCP | 需要哪些 MCP 工具？（如无特殊需求默认 antleroffice） |

如果老板已经在请求里提供了部分信息，直接用，只补问缺少的。

## Step 2 — Draft

整理所有资料，用中文向 COO 呈现完整 Draft：

```
📋 新 NPC Draft — [名字]

• Tagline: ...
• 类别 / Role: ... / ...
• 价钱: ... credits/月
• 可见性: public / hidden（密码: ...）
• 皮肤: ...
• Featured: 是 / 否 | Sort: ...

技能:
  1. [skill_id] — [名字]: [system prompt 摘要]
  2. ...

MCP: antleroffice（+ 其他）

OpenClaw SKILL.md 摘要:
  [简要描述每个 SKILL.md 的工作流]

请老板确认，说「发布」我就执行。
```

**等老板确认，不要自动继续。**

## Step 3 — Publish（收到"发布"后）

1. 调用 `list_saas_workers` — 确认 templateId 和 department.id 不重复
2. 调用 `create_saas_worker` 传入完整 payload（见下方格式）
3. 回报结果：templateId、catalogUuid、visibility、git 路径
4. 提醒老板：`git commit + git push server/` 到 ECS 才算正式上线

如果是 hidden worker，特别强调 **catalogUuid** — 这是用户在 AntlerOffice 搜索用的唯一入口。

## Payload 格式

```json
{
  "templateId": "snake_case_id",
  "department": {
    "id": "snake_case_id_dept",
    "category": "growth",
    "name": "NPC 显示名",
    "tagline": "一句话",
    "role": "role_key",
    "salaryCreditsPerMonth": 199,
    "salaryUsdPerMonth": 199,
    "visibility": "public",
    "bundleTemplateId": "snake_case_id",
    "active": true,
    "featured": false,
    "sortOrder": 999
  },
  "template": {
    "role": "role_key",
    "defaultSkinId": "slate",
    "description": "Plain English, ≥80