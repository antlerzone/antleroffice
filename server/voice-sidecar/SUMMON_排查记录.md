# Summon / openWakeWord 唤不醒 —— 排查记录与防复发

> 记录日期：2026-06-24
> 结论一句话：**监听程序用"每帧开关麦克风"的方式采集音频，把声音切碎了；openWakeWord 这种流式声学模型需要连续平滑的音频流，碎音频导致它打分恒为 0.000，所以永远唤不醒。**

---

## 1. 现象

- 唤醒引擎是 `openwakeword`，状态显示 `Sidecar is ready`、`sleep`。
- 麦克风有声音（音量条满格、`rms` 高到几千），VAD 也认到在说话。
- 但说 "Hey Jarvis" 完全没反应。
- 关键证据：`wake-debug.log` 里 `top_score` **恒定 0.000**（偶尔 0.001），哪怕 `peak_rms` 高到 4000+。

## 2. 真正的根本原因

`listener_server.py` 的 `_mic_loop()` 原来用 `sd.rec(FRAME_SAMPLES, ...)` **每 30ms 开一次、关一次**麦克风流。每次开关之间会丢掉一小段音频，喂给模型的声音是"碎"的、有间隙的。

- **Whisper（转文字）对碎音频不敏感**——它拿的是整段录音缓冲，所以那条路能"听到"（曾把 Hey Jarvis 转成 "Hey guys / Jason / Bryan"）。这一点最容易误导，让人以为是别的问题。
- **openWakeWord 是流式声学模型**，需要连续、平滑的音频帧来累积特征。音频一碎，特征就乱，分数恒为 0。

## 3. 解决方案（已实施）

在 `_mic_loop()` 中改用**一条常开的连续输入流**，不再每帧开关：

- 新增常驻 `_mic_stream = sd.InputStream(..., blocksize=FRAME_SAMPLES)`，循环里用 `_mic_stream.read(FRAME_SAMPLES)` 持续读取。
- 设备切换 / 自动重扫时调 `_close_mic_stream()` 关掉旧流，下一轮自动用新设备重开。
- 启动日志标记：`build=stream-v4 ... capture=CONTINUOUS`，并打印 `CONTINUOUS STREAM opened`。

改完后 `top_score` 说 "Hey Jarvis" 时冲到 0.3~0.97，正常触发。

## 4. 怎么快速定位（下次照这个顺序）

1. **先排除"输入端"**：麦克风没被静音、Windows 输入音量 ≥80%、设备选对（EMEET）。
2. **确认引擎设置**：`wakeEngine=openwakeword`、`wakeRequireStt=false`（否则会退回 Whisper 转文字猜，把 Jarvis 听成别的名字）。
3. **看 `server/voice-sidecar/wake-debug.log` 的 `top_score`**：
   - 如果 `top_score` 一直 0.000，但 Whisper 那条能转出真实单词 → 喂给模型的音频有问题（多半是"碎采集"），**不是音量/采样率/发音问题**。
4. **用独立脚本一锤定音**：`oww_stream_test.py`（用连续流直接喂模型）。
   ```
   & "C:\Users\User\.antleroffice2\voice-runtime\venv\Scripts\python.exe" "<...>\server\voice-sidecar\oww_stream_test.py"
   ```
   说 "Hey Jarvis"，若分数立刻 0.3~0.9 → **模型正常，问题在主程序的采集方式**。

## 5. 重启的正确姿势（很重要，之前反复踩坑）

- Python 监听是**独立常驻进程**。点 `Refresh`、甚至重启 `dev:server`，往往**只重建检测器、不重载 Python 代码**，改了代码看不到效果。
- 旧进程常占着端口不放（`3020`、`8767`），新进程起不来。一键清端口：
  ```
  node scripts/kill-antleroffice-dev-ports.cjs
  ```
  然后 `npm run dev:server:clean`。
- 重启成功的铁证：日志里出现 `>>> MIC LOOP START build=stream-v4 ... capture=CONTINUOUS`。

## 6. 防止再次发生

- **不要**把 `_mic_loop()` 的采集改回 `sd.rec()` 每帧开关——必须保持一条常开 `InputStream`。
- **不要**在设置模型里删掉 `wakeEngine` / `wakeRequireStt` 字段或界面控件（之前在 Cursor 里误删过，导致退回 Whisper、又听错）。
- 动过任何语音采集 / 唤醒相关代码后，**先用 `oww_stream_test.py` 验证**模型还能正常打分，再测整个 App。
- 保留 `wake-debug.log` 这套日志（`wlog`）作为常备诊断工具。

---

### 涉及的关键文件
- `server/voice-sidecar/listener_server.py` —— `_mic_loop()` 连续流采集、`wlog` 日志
- `server/voice-sidecar/wake_engines.py` —— `OpenWakeWordDetector` 打分逻辑、`wlog`
- `server/voice-sidecar/oww_stream_test.py` —— 独立验证脚本
- `server/voice-sidecar/wake-debug.log` —— 运行时诊断日志
