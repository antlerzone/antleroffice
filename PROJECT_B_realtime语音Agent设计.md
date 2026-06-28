# Project B — Realtime 语音 Agent 设计（封板）

> 定稿日期：2026-06-24
> 一句话：把"在 boss chat 打字给 COO"变成"语音对话",体验做到"秒回"。COO 的执行逻辑一行不改,语音只是新的输入/输出皮肤。

---

## 1. 目标与核心理念

用户想要"像打电话给秘书一样,说完马上有回应"。但真正的推理/查数据/执行系统要几秒钟。

**解决办法不是让大模型 0 秒思考,而是把「听见用户」和「完成任务」拆开:**

> 用户说完 → **0.2 秒先 ACK("好的,我去办")** → 后台慢慢推理/执行 → 报结果 / 继续追问

就像真人秘书:"好的(立刻)→ 是 A 公司还是 B 公司?(随后)"。秘书也不是听完瞬间什么都知道,而是先确认收到,再逐步完成。

---

## 2. 三层架构（快脑 / 工具 / 慢脑）

| 角色 | 谁 | 职责 | 速度 |
|---|---|---|---|
| **嘴 / 快脑（Fast Brain）** | OpenAI Realtime | 语音收发；**快意图**(闲聊 vs 办公室)；**立刻 ACK**；闲聊/笑话/通用问答**自己答** | 100–300ms |
| **桥（一个工具）** | `转给COO` (forward_to_coo) | 把办公室指令**原话**灌进现有 boss→COO 通道 | — |
| **手 / 慢脑（Smart Brain）** | COO / OpenClaw | **深意图**(开什么单、给谁、缺什么料、有无权限)；执行 Bukku/ERP/CRM；缺料时反向追问 | 1–5s+ |

**关键简化:** 不给 OpenAI 定义一堆工具(开单工具、入账工具…),**只要一个工具「转给 COO」**。因为 COO 本来就什么都能处理(就像打字给它)。OpenAI 只做粗判:`办公室→转 COO` / `通用→自己答`。

**意图分两层:**
- 快意图(路由级,"这是办公室还是闲聊")→ **Realtime 做**(必须在这层,才能立刻 ACK,不能等 COO)
- 深意图(任务级,"具体做什么、缺什么")→ **COO 做**(转过去之后)
- 现有的 `routeVoiceIntent` 可挪到 COO 侧,或当确定性兜底。

---

## 3. 响应模式（两段式，秒回的秘诀）

```
用户：帮我给 ABC Sdn Bhd 开张报价单
  ↓ 0.2s
Agent：好的,我帮您准备报价单。      ← ACK(立刻,撑住低延迟)
  ↓ 后台 COO 分析/执行
Agent：请问是哪个产品？             ← 缺料就语音追问
  ↓ 用户回答 → COO 继续
Agent：报价单已开好。               ← 报结果
```

用户感知:说完 → 立刻有回应。虽然真正推理还在后台进行。

---

## 4. 已封板的产品决策

- **声音**:默认 **OpenAI 嗓音(最快)**;用户可**可选**切换 **ElevenLabs / Fish 克隆音**(会慢一点,需联各自的云)。
- **多轮追问**:✅ COO 缺料时,语音一问一答,像跟秘书连续对话。
- **会话保持**:✅ 唤醒一次后保持对话,可连续下多个指令,**5 分钟空闲自动回 sleep**(复用 summon 的 idleTimeout)。
- **网络**:OpenAI 已确认能连;克隆音那条依赖 fish.audio / elevenlabs 的云。

---

## 5. 端到端数据流

```
🎤 你说话
  ↓
OpenAI Realtime（听 + 快意图 + ACK）
  ├── 闲聊/笑话/天气 ── OpenAI 直接答 ──→ 🔊
  └── 办公室指令
        ↓ 先 ACK 🔊"好的,我去办"
        ↓ 调用工具 forward_to_coo(原话)
      现有 boss→COO 通道（OpenClaw gateway）
        ↓ COO 深意图 + 执行（Bukku/CRM…）
        ↓ 结果 / 追问  ──（异步塞回 realtime 会话）──→ 🔊
```

---

## 6. 与现有代码的衔接（不是从零）

- **boss→COO 通道**:已有(OpenClaw gateway chat / `ocGatewayChat`);realtime 编排器里的 `action 意图` 路径本来就是"把语音指令转给 OpenClaw 执行"。
- **realtime 基础**:`useVoiceRealtime.ts`(前端)+ `voice-realtime-service.js` / `voice-realtime-orchestrator.js`(后端)已搭好 SSE/turn 框架。
- **wake→realtime 衔接**:`useVoiceWake.ts` 已写好(`realtime.enabled` 打开就在唤醒后自动启动)。
- **STT/TTS 零件**:STT 有 OpenAI Whisper + 本地 TypeWhisper;TTS 有 EdgeTTS/Fish/ElevenLabs/OpenAI/浏览器。

---

## 7. 待办的工程活（我来做，不需要你操心）

1. **OpenAI Realtime 会话** + 定义 `forward_to_coo` 工具(function calling)。
2. **`forward_to_coo` 接到现有 boss→COO 通道**,把原话灌进去。
3. **异步协调**:COO 慢/追问时,把结果或追问**塞回 realtime 会话**让它开口(这是最核心的工程难点)。
4. **声音切换**:默认 OpenAI 嗓音;可选 Fish/ElevenLabs(走文字→克隆 TTS)。
5. **会话保持 + idle sleep**:复用 summon 的 5 分钟超时。

---

## 8. 分期落地

- **Phase 1（先跑通问答的最小闭环）**:语音下**一个**办公室指令 → ACK → 转 COO → COO 执行 → 语音报结果。先不追求多轮/克隆音。
- **Phase 2**:多轮追问、会话保持、缺料反问。
- **Phase 3**:声音可选(克隆音)、闲聊优化、打断处理。
