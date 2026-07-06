# Security Worker NPC — 阶段 3 Plan（hire 才下载 worker + 真正接 job）

> 阶段 3 = 雇佣后**按需下载 worker 本体**（不打包进 AntlerOffice）→ 装依赖 → 起后台进程
> → 轮询 ECS 接 job → 跑 Appium/Playwright → 传 OSS → 状态回显到 NPC。

---

## 〇、已探明的现成机制（能复用，省很多事）

1. **雇佣才下载 = 现成的 bundle 管道**
   `server/antler/ecs-bundle.js` 的 `downloadAndInstall(template)`：雇佣时从 ECS
   `/api/catalog/agents/{id}/bundle` 拉 `{manifest, files}`，写到 `~/.antleroffice2/bundles/{id}/`。
   ⚠️ 只搬**文本文件**（源码/配置/skills），**不搬 node_modules**。
   还有 `installFromMonorepo()` 兜底：本地 `server/bundles/{id}/` 有就直接用（开发期好用）。

2. **起后台常驻进程 = 照抄 openclaw 那套**
   `electron/main.cjs` 用 `spawn(cmd,{cwd,env,stdio,shell,windowsHide})` 起 openclaw 网关，
   `taskkill /T /F` 收进程。worker 照这个模式起停即可。

3. **共用 token + worker_code**：token 是所有 worker 共用的固定钥匙（烤进 worker env），
   worker_code 由插上的手机序列号自动生成。ECS 三接口已确认。

---

## 一、整体流程（终态）

```
雇 Security Worker(输密码)
   → AntlerOffice 下载 worker bundle 到 ~/.antleroffice2/bundles/agent_security/
   → 走阶段2引导装环境 + 插手机
   → 引导完成 → 主进程在 worker 目录跑 npm install(装 playwright 等)
   → 起后台 worker 进程(node dist/index.js, env 带共用 token)
   → worker 轮询 ECS 拿 job → 跑 Appium/Playwright → 传 OSS
   → worker 把"正在跑第几个 job/成功失败"回报 → NPC 头顶气泡显示
被解雇 → 停掉 worker 进程，可选删 bundle
```

---

## 二、要建/改的模块

### A. 把 worker 打包成 bundle（新）
- 来源：`agentsecurity/worker/`（dist + config + vendor + package.json，都是文本）。
- 产出：`server/bundles/agent_security/` 下 `manifest.json` + `worker/**` 文本文件
  （先用 monorepo 兜底路径，跑通后再发布到 ECS）。
- 注意：`node_modules` 不进 bundle，靠下载后 `npm install`。

### B. 主进程：worker 生命周期管理（新，`electron/main.cjs` 或新 cjs）
- `ensureWorkerInstalled()`：bundle 存在 → 若无 node_modules 则在该目录 `npm install`（异步、有进度）。
- `startSecurityWorker()`：`spawn('node',['dist/index.js'],{cwd:bundleWorkerDir, env:{...baked token...}})`。
- `stopSecurityWorker()`：taskkill。
- 触发时机：仅当 `agent_security` 已雇 + 引导完成；解雇则停。

### C. 共用 token 注入（新）
- 把共用 `SECURITY_API_WORKER_TOKEN`（+ API_BASE_URL/OSS 配置）在起进程时写进 env，
  不落地明文文件、不进仓库。worker_code 由 worker 自动按手机序列号生成。

### D. 状态回显到 NPC（新）
- worker 通过本地小接口/IPC 把状态（当前 job、成功/失败、在跑几台手机）报给 AntlerOffice，
  NPC 头顶气泡 + 详情页显示。首版可先只显示"运行中/已停止"，细节后补。

### E. 引导衔接（小改）
- 阶段2引导最后一步完成后，触发 B 的 install+start。

---

## 三、分步推进（阶段 3 内部再分小步，别一次全做）

- **3a**：worker 打包成 monorepo bundle + 雇佣时能下载到 `~/.antleroffice2/bundles/`（先不跑）。
- **3b**：主进程 install+start/stop worker 进程（手动触发，看它能起来、能连 ECS）。
- **3c**：接上引导完成自动触发 + 解雇自动停。
- **3d**：状态回显到 NPC。
- 每步都要你在真机（装了环境+插手机）实测，我沙盒测不了。

---

## 四、一个必须你先定的岔路：worker 本体从哪下载？

见下方我单独问你的选择题。这个定了才好动 3a。

---

## 五、风险 / 注意

- **playwright 依赖重**：`npm install` 会下浏览器内核（几百 MB），首次装慢。
  可考虑只装 chromium 或按需。
- 全程原生 + 真机行为，我**沙盒里测不了**，只能保证代码结构与类型正确，运行要你实测。
- 计费/余额仍按你既定「只认 ECS/MySQL」规则，worker 不在本地放行消费。

_Plan 生成：2026-07-03_
