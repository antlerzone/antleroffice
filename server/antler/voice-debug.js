const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const voiceGpu = require('./voice-gpu-check');
const voiceProfiles = require('./voice-profiles-store');
const voiceSidecarManager = require('./voice-sidecar-manager');
const voiceAudioUtils = require('./voice-audio-utils');

const execFileAsync = promisify(execFile);
const TTS_URL = (process.env.VOICE_TTS_URL || process.env.VOICE_QWEN_URL || 'http://127.0.0.1:8765').replace(
  /\/+$/,
  '',
);

function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSizeBytes(p);
      else if (entry.isFile()) total += fs.statSync(p).size;
    }
  } catch {
    /* ignore */
  }
  return total;
}

function fileInfo(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { exists: true, bytes: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { exists: false };
  }
}

async function fetchJson(url, init = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const ms = Date.now() - started;
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ms, data };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeVenvTorch() {
  const py = voiceSidecarManager.venvPython();
  if (!fs.existsSync(py)) {
    return { ok: false, error: 'venv python not found', path: py };
  }
  const script = `
import json, torch
out = {
  "cuda": torch.cuda.is_available(),
  "version": torch.__version__,
}
if torch.cuda.is_available():
  out["device"] = torch.cuda.get_device_name(0)
  out["vramAllocatedMb"] = round(torch.cuda.memory_allocated(0) / 1024 / 1024, 1)
print(json.dumps(out))
`;
  try {
    const { stdout } = await execFileAsync(py, ['-c', script], { timeout: 15000, windowsHide: true });
    return { ok: true, ...(JSON.parse(String(stdout || '{}')) || {}) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function buildHints(report) {
  const hints = [];
  const sidecar = report.sidecar || {};
  const torch = report.torch || {};
  const profile = report.profile || {};

  if (!report.gpu?.meetsRequirements) {
    hints.push({ level: 'error', text: 'GPU 未达标，克隆 TTS 不会启动或会极慢。' });
  }
  if (!sidecar.processRunning && sidecar.setup?.phase === 'running' && !sidecar.health?.ready) {
    hints.push({ level: 'error', text: 'CosyVoice 进程已退出但状态仍为 running — 请点「重试安装」或查看下方日志。' });
  }
  if (sidecar.health?.up && !sidecar.health?.ready) {
    hints.push({
      level: 'warn',
      text: '模型仍在加载或下载（首次约 2–4 GB），/health 显示 ready=false 时请等待。',
    });
  }
  if (sidecar.debug?.cudaAvailable === false && report.gpu?.meetsRequirements) {
    hints.push({
      level: 'error',
      text: '有 NVIDIA 显卡但 PyTorch 未启用 CUDA — 当前为 CPU 推理，每次合成可能 30–120 秒。',
    });
  }
  if (sidecar.debug?.ready && sidecar.debug?.lastSynthMs && sidecar.debug.lastSynthMs > 30000) {
    hints.push({
      level: 'warn',
      text: `上次合成耗时 ${Math.round(sidecar.debug.lastSynthMs / 1000)}s — 首次预热时正常；若每次都很慢请点「重试安装」重启 CosyVoice。`,
    });
  }
  if (profile.active && !profile.refText) {
    hints.push({ level: 'warn', text: '当前档案缺少 refText 台词，克隆质量差或失败。请重新录制。' });
  }
  if (profile.active && profile.refAudio && !profile.refAudio.exists) {
    hints.push({ level: 'error', text: '参考音频文件缺失，请重新上传/录制。' });
  }
  if (torch.ok && torch.cuda === false) {
    hints.push({ level: 'error', text: `venv 内 torch ${torch.version || '?'} 无 CUDA。` });
  }
  if (!hints.length) {
    hints.push({ level: 'success', text: '未发现明显配置问题。若仍慢，点「运行探测」查看各阶段耗时。' });
  }
  return hints;
}

async function collectVoiceDebugReport(opts = {}) {
  const collectedAt = new Date().toISOString();
  const timings = {};

  const gpuStart = Date.now();
  const gpu = await voiceGpu.checkGpuForVoiceClone();
  timings.gpuCheckMs = Date.now() - gpuStart;

  const healthStart = Date.now();
  const health = await voiceSidecarManager.probeHealth(5000);
  timings.healthProbeMs = Date.now() - healthStart;

  const debugStart = Date.now();
  const sidecarDebug = await fetchJson(`${TTS_URL}/debug`, {}, 8000);
  timings.sidecarDebugMs = Date.now() - debugStart;

  const torchStart = Date.now();
  const torch = await probeVenvTorch();
  timings.torchProbeMs = Date.now() - torchStart;

  const setup = voiceSidecarManager.getSetupStatus();
  const logs = voiceSidecarManager.getRecentLogs(60);

  const active = voiceProfiles.getActiveProfile();
  let profile = null;
  if (active) {
    const refPath = voiceProfiles.getRefAudioPath(active.id);
    let wavPath = refPath;
    try {
      if (refPath) wavPath = await voiceAudioUtils.ensureWavRef(refPath);
    } catch {
      /* keep original */
    }
    profile = {
      active: true,
      id: active.id,
      name: active.name,
      refText: active.refText || null,
      refTextLen: (active.refText || '').length,
      durationSec: active.durationSec,
      refAudio: fileInfo(refPath),
      refWav: wavPath !== refPath ? fileInfo(wavPath) : null,
    };
  } else {
    profile = { active: false };
  }

  const cacheDir = voiceSidecarManager.modelCacheDir();
  const paths = {
    ttsUrl: TTS_URL,
    runtimeRoot: voiceSidecarManager.runtimeRoot(),
    venvPython: voiceSidecarManager.venvPython(),
    sidecarScript: voiceSidecarManager.sidecarScript(),
    modelCacheDir: cacheDir,
    modelCacheBytes: dirSizeBytes(cacheDir),
    venvExists: fs.existsSync(voiceSidecarManager.venvDir()),
    depsInstalled: fs.existsSync(path.join(voiceSidecarManager.runtimeRoot(), '.cosyvoice-deps-installed')),
  };

  const report = {
    ok: true,
    collectedAt,
    timings,
    gpu,
    torch,
    sidecar: {
      health,
      debug: sidecarDebug.ok
        ? sidecarDebug.data
        : health.data && typeof health.data === 'object' && health.data.device
          ? { ...health.data, fromHealthFallback: true }
          : {
              fetchError: sidecarDebug.error || `HTTP ${sidecarDebug.status || '?'}`,
              ms: sidecarDebug.ms,
              hint: '点「重试安装」重启 CosyVoice 以启用 /debug 耗时统计。',
            },
      setup,
      processRunning: setup.processRunning,
      logs,
    },
    profile,
    paths,
  };

  report.hints = buildHints(report);

  if (opts.probeSynth) {
    report.probe = await runSynthProbe(opts.profileId, opts.probeText);
  }

  return report;
}

async function runSynthProbe(profileId, probeText) {
  const text = String(probeText || '测试').trim() || '测试';
  const timings = { startedAt: Date.now() };
  const activeId = profileId || voiceProfiles.getActiveProfile()?.id;
  if (!activeId) {
    return { ok: false, error: 'No active voice profile' };
  }

  const profile = voiceProfiles.getProfile(activeId);
  let refPath = voiceProfiles.getRefAudioPath(activeId);
  if (!refPath) return { ok: false, error: 'Reference audio missing' };

  const wavStart = Date.now();
  try {
    refPath = await voiceAudioUtils.ensureWavRef(refPath);
  } catch (e) {
    return { ok: false, error: `WAV conversion: ${e.message}` };
  }
  timings.wavConvertMs = Date.now() - wavStart;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300000);
  const synthStart = Date.now();
  try {
    const res = await fetch(`${TTS_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        ref_audio: refPath,
        profile_id: activeId,
        ref_text: profile?.refText || null,
      }),
      signal: ctrl.signal,
    });
    timings.sidecarSynthMs = Date.now() - synthStart;
    timings.totalMs = Date.now() - timings.startedAt;
    const sidecarSynthHeader = res.headers.get('x-synth-ms');
    if (sidecarSynthHeader) timings.sidecarReportedMs = Number(sidecarSynthHeader);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: errText || `HTTP ${res.status}`, timings };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      text,
      profileId: activeId,
      audioBytes: buffer.length,
      timings,
    };
  } catch (e) {
    timings.sidecarSynthMs = Date.now() - synthStart;
    timings.totalMs = Date.now() - timings.startedAt;
    return { ok: false, error: e.message || String(e), timings };
  } finally {
    clearTimeout(timer);
  }
}

function registerVoiceDebugRoutes(app) {
  app.get('/api/voice/debug', async (req, res) => {
    try {
      res.json(await collectVoiceDebugReport());
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/voice/debug/probe', async (req, res) => {
    try {
      const { profileId, text } = req.body || {};
      const probe = await runSynthProbe(profileId, text);
      const report = await collectVoiceDebugReport();
      report.probe = probe;
      if (probe.ok && probe.timings?.sidecarSynthMs && probe.timings.sidecarSynthMs > 20000) {
        report.hints = [
          ...(report.hints || []),
          {
            level: 'warn',
            text: `本次探测合成耗时 ${Math.round(probe.timings.sidecarSynthMs / 1000)}s（GPU 首次可能 20–60s）。`,
          },
        ];
      }
      res.json({ ok: probe.ok, probe, report });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = {
  collectVoiceDebugReport,
  runSynthProbe,
  registerVoiceDebugRoutes,
};
