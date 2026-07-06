# Security Worker NPC — 阶段 2 完整实施 Plan（自动装环境）

> 阶段 2 = 让新手引导页能**一键检测 + 尽量自动安装**运行环境，
> 而不是只给图文让用户自己装。**Windows 优先**（用户机是 Windows）。

---

## 〇、先修一个阶段 1 的渲染缺陷

引导组件 `NpcOnboardingWizard.vue` 里 `info` 步骤**只渲染 `title` + `hint`**
（第 641-644 行），我阶段 1 写的 `question` / `tutorialSteps` 不显示。
阶段 2 会把 info 与新步骤统一渲染 question + 教程 + 按钮，顺手补上。

---

## 一、要装什么、怎么装（Windows）

| 工具 | 检测命令 | 自动安装方式 | 备注 |
|------|----------|--------------|------|
| Node.js | `node -v` | `winget install OpenJS.NodeJS.LTS`；无 winget 则给下载链接 | Appium 依赖它 |
| Appium | `appium -v` | `npm i -g appium` + `appium driver install uiautomator2` | 命令行可全自动 |
| ADB / platform-tools | `adb version` | 自动下载 Google platform-tools zip 解压 + 加 PATH（小，~15MB） | 比装整个 AS 轻 |
| Android Studio | 检测安装目录 | **自动下载安装器 + 打开让用户点**（1GB GUI，不静默） | 需要完整 SDK 时才用 |

> Playwright **不在阶段 2**：它是 worker 的依赖，按阶段 3「hire 时才下载 worker」的约束，
> 由 worker 下载后 `npm install` 时一起装，不在装环境这步。

---

## 二、要改的文件（4 处）

### ① `electron/main.cjs` — 加原生 IPC（跑检测/安装命令）

在现有 `ipcMain.handle('shell:...')` 附近加：

```js
const { spawn } = require('node:child_process'); // 文件顶部已有

function runCmd(cmd, args, onData) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(cmd, args, { shell: true, windowsHide: true });
    p.stdout.on('data', d => { out += d; onData?.(String(d)); });
    p.stderr.on('data', d => { out += d; onData?.(String(d)); });
    p.on('close', code => resolve({ code, out }));
    p.on('error', err => resolve({ code: -1, out: String(err) }));
  });
}

// 检测某工具是否装好
ipcMain.handle('env:check', async (_e, tool) => {
  const map = {
    node:    ['node', ['-v']],
    appium:  ['appium', ['-v']],
    adb:     ['adb', ['version']],
  };
  const spec = map[tool];
  if (!spec) return { ok: false, installed: false, reason: 'unknown tool' };
  const r = await runCmd(spec[0], spec[1]);
  return { ok: r.code === 0, installed: r.code === 0, version: r.out.trim().split('\n')[0] };
});

// 自动安装（把进度实时推回渲染进程）
ipcMain.handle('env:install', async (e, tool) => {
  const send = (line) => e.sender.send('env:progress', { tool, line });
  if (tool === 'appium') {
    const a = await runCmd('npm', ['i', '-g', 'appium'], send);
    if (a.code === 0) await runCmd('appium', ['driver', 'install', 'uiautomator2'], send);
    return { ok: a.code === 0 };
  }
  if (tool === 'node') {
    const r = await runCmd('winget', ['install', '-e', '--id', 'OpenJS.NodeJS.LTS'], send);
    return { ok: r.code === 0, needManual: r.code !== 0, url: 'https://nodejs.org/' };
  }
  if (tool === 'adb') {
    // 下载 platform-tools zip → 解压到 userData → 加 PATH 提示（首版可先打开下载页）
    return { ok: false, needManual: true, url: 'https://developer.android.com/tools/releases/platform-tools' };
  }
  if (tool === 'android_studio') {
    // 下载安装器到临时目录后 shell.openPath 打开；首版可先 openExternal 官网
    shell.openExternal('https://developer.android.com/studio');
    return { ok: true, openedInstaller: true };
  }
  return { ok: false, reason: 'unknown tool' };
});
```

### ② `electron/preload.cjs` — 桥上暴露给前端

```js
envCheck: (tool) => ipcRenderer.invoke('env:check', tool),
envInstall: (tool) => ipcRenderer.invoke('env:install', tool),
onEnvProgress: (cb) => {
  const h = (_e, data) => cb(data);
  ipcRenderer.on('env:progress', h);
  return () => ipcRenderer.removeListener('env:progress', h);
},
```

### ③ `src/lib/npc-onboarding-configs.ts` — 新增步骤类型 + 改配置

1. `OnboardingStepType` 加 `'env_setup'`。
2. `OnboardingStep` 加字段：`tool?: 'node'|'appium'|'adb'|'android_studio'`、`downloadUrl?: string`。
3. 把 agent_security 的引导步骤：
   - `install_android_studio` → `env_setup` tool:`android_studio`（检测 + 下载/打开）
   - `verify_adb` → `env_setup` tool:`adb`（检测 + 下载 platform-tools）
   - `install_appium` → `env_setup` tool:`appium`（检测 + 一键装）
   - 新增 `check_node` → `env_setup` tool:`node`（放 appium 前）
   - `env_intro` / `connect_phone` 保持 `info`（用修好的渲染）

### ④ `src/components/antler/NpcOnboardingWizard.vue` — 渲染 + 逻辑

1. **修 info 渲染**：title 下补 `question` + `tutorialSteps` 列表。
2. **加 env_setup 渲染块**：显示 title/question/教程 + 三个按钮：
   - `[检测]` → `antlerDesktop.envCheck(tool)`，显示「✅ 已装 vX.Y」或「❌ 未检测到」
   - `[自动安装]` → `antlerDesktop.envInstall(tool)`，下方滚动显示进度（订阅 `onEnvProgress`）
   - `[打开下载页]` → 需手动时兜底
3. **放行逻辑**：`isStepComplete` 里 env_setup = 检测通过 或 用户点了跳过（步骤设 `optional:true`）。
4. **降级**：非 Electron（网页版）`antlerDesktop` 不存在 → env_setup 退化成纯图文 + 外链。

---

## 三、验收标准

1. 桌面版走引导，到 Appium 步：点 `[检测]` 显示未装 → 点 `[自动安装]` → 进度滚动 → 完成后再检测显示版本。
2. Node 同理（winget 装）。
3. Android Studio 步：点按钮能下载/打开官方安装器。
4. ADB 步：能检测；未装给下载 platform-tools 入口。
5. 网页版打开同一引导不报错（退化成图文 + 外链）。
6. `npm run build` 通过。

---

## 四、明确不做（留阶段 3）

- ❌ 下载 worker 本体 / 装 Playwright / 真正接 job —— 阶段 3（worker 只在 hire 时下载，不打包进 AntlerOffice）。
- ❌ mac / Linux 的自动安装 —— 以后按需补（先 Windows）。
- ❌ platform-tools 全自动解压加 PATH —— 首版先给下载入口，稳了再做全自动。

---

## 五、风险提示

- 原生安装命令**我在沙盒里测不了**（无 Windows/Electron 环境），需你本地实测。
- `npm i -g` / `winget` 依赖机器已有 npm / winget；检测不到时都有「打开下载页」兜底，不会卡死。
- 全程只在用户点按钮时才执行安装，不偷偷跑命令。

_Plan 生成：2026-07-03_
