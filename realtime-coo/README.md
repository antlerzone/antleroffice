# AntlerOffice · Realtime COO（语音新版）

和主项目目录分开的一套新版本。核心思路：**不再用本地 CosyVoice + 本地录音唤醒，整段「听 + 说」交给 OpenAI Realtime；COO 在本机执行。**

```
你（说话） ──麦克风──▶ OpenAI Realtime ──听+说──▶ 你（耳朵）
                              │ 它想用 COO 时“喊一声”(function tool)
                              ▼
                        你的浏览器（中转）
                              │ POST /coo（本机）
                              ▼
                        现有 OpenClaw COO（开发票/记账/查客户…）
```

**为什么没有隧道？** 因为 COO 由你的浏览器在本地调用（中转模式），不是 OpenAI 云端来调。云端只负责听和说，真正干活的 COO 100% 在你电脑里跑，什么都不用对外暴露。

## 目录

```
realtime-coo/
├── server/
│   ├── app.js       网页 + Realtime 令牌 + COO 本地中转（这就是全部）
│   ├── dev.js       npm run dev 启的就是它
│   ├── lib.js       读 .env、读 AntlerOffice 的 key、接到现有 COO
│   └── coo-mcp.js   （可选）“远程 MCP”模式才用，本地中转用不到，保留备用
├── web/
│   └── index.html   网页：麦克风进 / 扬声器出 / 也能打字测试
├── .env.example
└── run-dev.bat
```

## 跑起来（2 步）

**1) 先启动主项目**（它提供 OpenClaw 网关 = COO 的大脑，也提供 OpenAI key）：
```
cd "C:\Users\User\Desktop\ECS 2026\Antlermarket\AntlerOffice2"
npm run dev
```

**2) 起新版本**，浏览器开 http://127.0.0.1:8940 ：
```
cd realtime-coo
npm run dev
```
点「开始」→ 允许麦克风 → 说「Hello Jarvis」→ 说指令。

> OpenAI key：自动读 AntlerOffice（model 设置页）里设好的那个，不用在这里填。
> 不想用麦克风测试？页面上有个**打字输入框**，打字一样能走完「Realtime → 本地 COO」整条链路。
> 零依赖：纯 Node 写的，**不需要 `npm install`**。

## 老版本语音已默认关闭

主项目启动时不再自启老的本地语音（CosyVoice + 唤醒录音 listener），避免和新版抢麦克风。
要恢复：启动主项目前设环境变量 `ENABLE_OLD_VOICE=1`。（改的是 `server/index.js`，没删任何功能。）

## 已自测 ✅ / 待你测 🎤

- ✅ 网页服务启动、页面可打开
- ✅ COO 本地中转端点 /coo 已能接上现有 COO 模块
- ✅ 缺 key 时正确报错
- 🎤 对着麦克风「Hello Jarvis + 指令 → 语音回你」：需要你的真机 + 麦克风，这一步在你电脑上完成
