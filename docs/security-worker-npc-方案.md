# Security Worker（隐藏 NPC）落地方案

目标：把救回来的 SecurityWorker 做成 AntlerOffice 的一个**隐藏 NPC**。
雇佣（需密码）→ 触发新手引导（装 Android Studio / ADB / Appium 等）→ 开始接 job。

三条已拍板的决定：
1. 隐藏方式 = 和 `human_resource` 一样（`visibility:"hidden"` + 雇佣密码）。
2. 引导 = 图文引导 + **尝试自动安装**环境。
3. 接 job = **逻辑重写进 AntlerOffice**（不是启动旧的独立程序）。

---

## 一、现状盘点（这套系统本来能干什么）

- **隐藏 NPC**：catalog 里加 `visibility:"hidden"` + `hirePassword`，市场页会自动把它过滤掉
  （`src/lib/agent-browse-catalog.ts` 第 199–203 行），只有输对密码才能雇。✅ 现成能力。
- **新手引导**：每个 NPC 的引导写在 `src/lib/npc-onboarding-configs.ts`，
  支持四种步骤：`choice`（选择）、`api_credentials`（填账号）、`browser_login`（开浏览器登录）、
  `info`（图文说明，可带 `tutorialSteps` 教程）。✅ 图文引导现成能用。
- **主进程能力**：`electron/main.cjs` 已经在用 `child_process.spawn` 开 node 服务和 openclaw 网关，
  也能 `http.get` 下载、`shell.openExternal` 开链接。⚠️ **但这些没开放给引导页**——
  桥文件 `electron/preload.cjs` 只暴露了开链接/更新/语音，没有"跑安装命令"的通道。
- **NPC 运行方式**：靠 openclaw AI 网关（boss→秘书→COO→部门 worker）。
  ⚠️ **没有常驻轮询/后台跑批**的概念——接 job 需要新起一个后台服务。

---

## 二、要新建/改动的四块

### 第 1 块：Catalog 条目（数据，最简单）——★ 可立即做

在 `agents/catalog.json` 的 `templates` 里新增一条（草稿见文末附录 A）。
关键字段：`visibility:"hidden"`、`hirePassword`、指向后面要建的引导与技能。

风险：低。改完 `npm run build` 能过即可。

### 第 2 块：引导配置（数据 + 少量前端）——★ 可较快做

在 `npc-onboarding-configs.ts` 加 `agent_security` 的配置（草稿见附录 B）。
- 纯图文部分用 `info` + `tutorialSteps`：告诉用户装什么、去哪下。
- Worker Token 用 `api_credentials` 步骤收集，存进账号保险箱。
- **自动安装按钮**需要一个新的步骤类型（见第 3 块），否则引导只能"教用户自己装"。

风险：低–中。纯图文低风险；带自动安装则依赖第 3 块。

### 第 3 块：自动安装通道（原生能力，中–重）

要让引导页能"点一下就检测/安装"，需要三小步：
1. `electron/main.cjs` 加几个 IPC 处理：`env:checkAdb`、`env:checkAppium`、
   `env:installX`（内部用 spawn 跑命令 / 下载安装器）。
2. `electron/preload.cjs` 桥上加对应方法（如 `antlerDesktop.checkAdb()`）。
3. 引导加一个新步骤类型 `env_setup`（或复用 `info` + 一个按钮组件），
   调上面的桥，显示"检测中/已装好/安装失败"。

现实提醒：
- **ADB / Appium 好办**：ADB 跟着 Android Studio 或 platform-tools 走；Appium 是 `npm i -g appium`，能脚本化。
- **Android Studio 难自动装**：约 1GB 图形安装器，各系统静默安装参数不同，
  建议**"自动下载 + 打开安装器让用户点下一步"**，而不是全静默，稳很多。
- 只在桌面版（Electron）有效；纯网页版没有这个桥，要降级成纯图文。

风险：中–重。跨平台是主要坑，建议先只做 Windows。

### 第 4 块：接 job 后台服务（把旧 worker 逻辑搬进来，最重）

把 `agentsecurity/worker/` 里的轮询逻辑（`dist/jobs/job.poller.js` +
各 `adapters/*` + `appium`/`adb`/`uploads`）搬成 AntlerOffice 的一个后台服务：
- 位置建议：`server/antler/security-worker/`（跟着 node 服务起）。
- 由主进程在"安全 NPC 已雇 + 引导完成"后才启动，未雇则不跑。
- 复用现有 Token/OSS 配置；余额/计费走你既定的 ECS/MySQL 规则。
- NPC 在办公室里作为"脸"：显示在跑第几个 job、成功/失败，点它能看日志。

风险：重。这是真正的移植工作，建议独立一个阶段做，先跑通一个流程（如 iCares）再扩展。

---

## 三、建议的推进顺序（分阶段，别一次全做）

- **阶段 1（半天）**：加 catalog 隐藏条目 + 纯图文引导。
  → 效果：能用密码雇到这个 NPC，雇完看到图文引导，能填 Token。**可先验收看效果。**
- **阶段 2（1–2 天）**：加自动安装通道（先只做 Windows：检测 ADB/Appium + 一键装 Appium + 下载并打开 Android Studio 安装器）。
- **阶段 3（数天）**：把接 job 后台服务搬进来，先跑通一个流程，再接上 NPC 状态显示。

---

## 附录 A：Catalog 条目草稿（可粘进 agents/catalog.json）

```json
{
  "id": "agent_security",
  "name": "Security Worker",
  "tagline": "手机自动化 worker — 门禁/访客/物业系统代跑",
  "role": "security",
  "defaultSkinId": "slate",
  "sprite": 3,
  "hueShift": 0,
  "runtime": "openclaw",
  "salaryCreditsPerMonth": 200,
  "currency": "credits",
  "billingCreditsByInterval": { "daily": 10, "monthly": 200 },
  "visibility": "hidden",
  "hirePassword": "改成你要的密码",
  "skillIds": ["security_worker_run"],
  "openclawSkillNames": ["antleroffice-security-worker"],
  "mcps": [
    { "slug": "antleroffice", "name": "AntlerOffice Tools",
      "url": "http://127.0.0.1:8931/mcp", "suggestedAuthType": "none", "skipProbeOnHire": true }
  ],
  "mcpHints": ["antleroffice"],
  "highlights": [
    "自动跑 iCares/Veemios/eCommunity/GProp/Klik Asia 流程",
    "隐藏 — 需密码雇佣",
    "需本机 Android Studio + ADB + Appium 环境"
  ],
  "featured": false,
  "version": "1.0.0"
}
```

## 附录 B：引导配置草稿（可粘进 npc-onboarding-configs.ts）

```ts
agent_security: {
  templateId: 'agent_security',
  greeting: '老板好！我是安全自动化 worker，负责在手机上自动跑门禁/访客/物业系统的活。开工前需要先把运行环境装好。',
  capabilities: ['自动跑 iCares 流程', '访客/房产登记自动化', '结果上传云端', '心跳与任务轮询'],
  completionHint: '环境装好后，我会自动开始接 job。',
  steps: [
    {
      id: 'env_intro',
      type: 'info',
      title: '需要的运行环境',
      question: '我需要以下工具才能工作：',
      tutorialSteps: [
        '1. Android Studio（含模拟器/SDK）',
        '2. ADB（platform-tools，随 Android Studio 安装）',
        '3. Appium（自动化引擎）',
        '装好后点下一步，我会自动检测。'
      ],
    },
    // 阶段 2 会把下面替换成 env_setup 自动检测/安装步骤
    {
      id: 'worker_token',
      type: 'api_credentials',
      title: 'Worker 凭证',
      question: '填入你的 Worker Token（用来接任务）',
      credentialWebsite: 'AntlerZone Worker',
      fields: [{ key: 'password', label: 'Worker Token', type: 'password' }],
    },
  ],
},
```

_方案生成：2026-07-03_
