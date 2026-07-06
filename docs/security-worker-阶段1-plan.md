# Security Worker NPC — 阶段 1 完整实施 Plan

> 阶段 1 = **能用密码雇到一个隐藏的 Security Worker NPC，雇完弹出图文新手引导，
> 引导用户装环境（Android Studio / ADB / Appium）+ 连手机，完成后 NPC 进办公室。**
> 本阶段只做「看得见、点得动」的壳，不含自动安装（阶段 2）和真正接 job 的后台服务（阶段 3）。

---

## 一、已锁定的设计前提

- **隐藏方式**：和 `human_resource` 一样 —— `visibility:"hidden"` + `hirePassword`，市场页自动过滤，只有输对密码才能雇。
- **雇佣密码**：`Antlerzone2026*`（与 HR 复用）。
- **一个 NPC = 一台手机**：有几台手机就雇几个，办公室里一个小人对应一台机。
- **Token 模型**：所有 worker **共用同一个 token**（ECS 环境变量里那把固定钥匙），
  **不需要用户填 token**；区分手机靠 `worker_code`（插上手机按序列号自动生成 `WORKER_xxxx`）。
  → 所以引导里**没有填 token 这一步**，token 留到阶段 3 的后台服务里烤进去。
- **理想终态**：雇 → 装环境 + 连手机（自动分 code）→ 认证通过 → 服务器派活就自动接。

---

## 二、阶段 1 验收标准（做完长这样）

1. 市场页默认**看不到** Security Worker。
2. 通过隐藏入口 + 输入密码 `Antlerzone2026*` → 能成功雇。
3. 雇完自动弹出新手引导，依次显示：环境说明 → 装 Android Studio → 装 ADB → 装 Appium → 连手机 → 完成。
4. 引导每步有图文说明 + 下载按钮（点了用系统浏览器打开官网）。**全程不需要填 token。**
5. 完成后 NPC 出现在办公室，`npm run build` 通过、无类型错误。

---

## 三、要新增/修改的文件清单（6 处）

| # | 文件 | 动作 | 风险 |
|---|------|------|------|
| 1 | `agents/catalog.json` | 加一条 `agent_security` 隐藏模板 | 低 |
| 2 | `src/lib/npc-onboarding-configs.ts` | 加 `agent_security` 引导配置 | 低 |
| 3 | `skills/security-worker.json` | 新建技能元数据 | 低 |
| 4 | `server/openclaw-skills/antleroffice-security-worker/SKILL.md` | 新建 openclaw 技能实体 | 低 |
| 5 | `src/lib/agent-browse-catalog.ts` | role→section 映射加 `security` | 低 |
| 6 | `src/lib/agent-resume-fallback.ts` | 加 `security` 角色的简历兜底文案 | 低 |

> 说明：4、5、6 是「让新角色不报错、能正常渲染」的配套；漏了会导致雇佣页/简历弹窗空白或构建告警。

---

## 四、每个文件的最终内容

### ① `agents/catalog.json` — 新增模板

在 `templates` 数组里加：

```json
{
  "id": "agent_security",
  "name": "Security Worker",
  "tagline": "手机自动化 worker — 门禁/访客/物业系统代跑",
  "role": "security",
  "category": "operations",
  "defaultSkinId": "slate",
  "sprite": 3,
  "hueShift": 0,
  "runtime": "openclaw",
  "salaryCreditsPerMonth": 200,
  "currency": "credits",
  "billingCreditsByInterval": { "daily": 10, "monthly": 200 },
  "visibility": "hidden",
  "hirePassword": "Antlerzone2026*",
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
    "一台手机一个 worker，手机越多抢单越多"
  ],
  "trustedBy": "内部",
  "rating": 5.0,
  "reviewCount": 1,
  "featured": false,
  "version": "1.0.0"
}
```

### ② `src/lib/npc-onboarding-configs.ts` — 新增引导配置

在 config 对象里加（注意：**无 token 步骤**，全部 `info` 图文步骤）：

```ts
agent_security: {
  templateId: 'agent_security',
  greeting: '老板好！我是安全自动化 worker，负责在手机上自动跑门禁/访客/物业系统的活。开工前需要先把运行环境装好、把手机连上。',
  capabilities: ['自动跑 iCares/Veemios/eCommunity/GProp/Klik Asia', '访客/房产登记自动化', '结果上传云端', '心跳与任务轮询'],
  completionHint: '环境装好、手机连上后，我会自动领到一个 worker 编号并开始接 job。',
  steps: [
    {
      id: 'env_intro',
      type: 'info',
      title: '第一步：了解需要装什么',
      question: '我需要以下三样工具才能工作：',
      tutorialSteps: [
        'Android Studio —— 含安卓 SDK 与模拟器',
        'ADB —— 电脑和手机对话的桥（随 Android Studio 一起装）',
        'Appium —— 帮我自动点手机的引擎',
      ],
    },
    {
      id: 'install_android_studio',
      type: 'info',
      title: '第二步：装 Android Studio',
      question: '点下方按钮下载 Android Studio，一路下一步装好即可。',
      credentialWebsiteUrl: 'https://developer.android.com/studio',
      tutorialSteps: [
        '下载后运行安装器，勾选 Android SDK / Platform-Tools',
        '装完打开一次，让它补齐 SDK 组件',
      ],
    },
    {
      id: 'verify_adb',
      type: 'info',
      title: '第三步：确认 ADB 能用',
      question: '打开命令行输入 adb version，能显示版本号就说明 ADB 装好了。',
      tutorialSteps: [
        'Platform-Tools 一般在 Android SDK 目录下',
        '若提示找不到 adb，把 platform-tools 目录加进系统 PATH',
      ],
    },
    {
      id: 'install_appium',
      type: 'info',
      title: '第四步：装 Appium',
      question: '在命令行运行：npm i -g appium，然后 appium 启动它。',
      tutorialSteps: [
        '需要先装 Node.js',
        '装完运行 appium，看到 server 启动在 4723/4725 端口即可',
      ],
    },
    {
      id: 'connect_phone',
      type: 'info',
      title: '第五步：连上手机',
      question: '用数据线把安卓手机插到电脑，开启「USB 调试」。',
      tutorialSteps: [
        '手机：设置 → 关于手机 → 连点版本号 7 次打开开发者选项',
        '开发者选项里打开「USB 调试」，插线后手机上点「允许」',
        '插好后我会自动认到这台机、分配一个 worker 编号',
      ],
    },
  ],
},
```

> 注：`info` 步骤目前用 `credentialWebsiteUrl` 承载下载链接。若引导组件对 `info` 不渲染按钮，
> 阶段 1 可先把链接写进 `tutorialSteps` 文字里；阶段 2 会引入专门的 `env_setup` 步骤类型带「检测/安装」按钮。

### ③ `skills/security-worker.json` — 技能元数据

```json
{
  "id": "security_worker_run",
  "name": "Security Worker",
  "system": "You are a Security automation worker inside AntlerOffice. You drive an Android phone via ADB + Appium to complete gate/visitor/property jobs (iCares, Veemios, eCommunity, GProp, Klik Asia). You poll jobs from ECS and report status. Keep the boss informed of which job is running and success/failure."
}
```

### ④ `server/openclaw-skills/antleroffice-security-worker/SKILL.md`

```markdown
# AntlerOffice Security Worker

Drive an Android phone (ADB + Appium) to auto-run gate/visitor/property flows:
iCares, Veemios, eCommunity, GProp Web, Klik Asia (CSS).
Poll jobs from ECS, run the matching flow, upload results, report status.
```

### ⑤ `src/lib/agent-browse-catalog.ts` — role→section 映射

第 74 行附近有 `human_resource: 'operations',`，照样加一行：

```ts
security: 'operations',
```

### ⑥ `src/lib/agent-resume-fallback.ts` — 简历兜底

第 85 行附近 `human_resource: {...}` 旁边加一条 `security` 的兜底文案
（照现有格式填名字/一句话职责即可，防止雇佣简历弹窗空白）。

---

## 五、构建与测试步骤

1. 六处改完后：`cd AntlerOffice2 && npm run build` —— 必须通过、无类型错误。
2. `npm run dev` 起开发服。
3. 走隐藏入口 → 输 `Antlerzone2026*` → 确认能雇到 Security Worker。
4. 雇完确认引导按 env_intro → 装 AS → ADB → Appium → 连手机 → 完成 顺序出现，链接能打开。
5. 确认市场页默认列表里**看不到**它。
6. 确认办公室里出现这个 NPC 小人。

---

## 六、阶段 1 明确「不做」什么（交给后面）

- ❌ 自动检测/自动安装环境 → **阶段 2**（要加 electron 主进程 IPC + preload 桥 + `env_setup` 步骤类型）。
- ❌ 真正轮询 ECS 接 job / 跑 Appium / 传 OSS → **阶段 3**（把 `agentsecurity/worker` 逻辑搬成后台服务，token 在这里烤进去）。
- ❌ NPC 办公室里显示「正在跑第几个 job」的实时状态 → 阶段 3 末尾。

---

## 七、给阶段 2/3 留的钩子

- 引导里的 `info` 步骤，阶段 2 会逐个升级成带按钮的 `env_setup`（检测→装→放行）。
- 共用 token：阶段 3 后台服务启动时从安全位置读一个烤进去的 `SECURITY_API_WORKER_TOKEN`，
  用户全程不碰；worker_code 由插上的手机序列号自动生成。

_Plan 生成：2026-07-03_
