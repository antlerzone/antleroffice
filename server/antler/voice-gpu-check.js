const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const MIN_VRAM_MB = Number(process.env.VOICE_TTS_MIN_VRAM_MB || process.env.VOICE_QWEN_MIN_VRAM_MB) || 6144;

async function queryNvidiaVramMb() {
  if (process.platform !== 'win32' && process.platform !== 'linux') return null;
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true },
    );
    const first = String(stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    const mb = Number(first);
    return Number.isFinite(mb) ? mb : null;
  } catch {
    return null;
  }
}

async function checkGpuForVoiceClone() {
  const vramMb = await queryNvidiaVramMb();
  if (vramMb == null) {
    return {
      ok: true,
      meetsRequirements: false,
      vramMb: null,
      minVramMb: MIN_VRAM_MB,
      reason: 'No NVIDIA GPU detected (CosyVoice clone requires ~6GB VRAM)',
    };
  }
  const meetsRequirements = vramMb >= MIN_VRAM_MB;
  return {
    ok: true,
    meetsRequirements,
    vramMb,
    minVramMb: MIN_VRAM_MB,
    reason: meetsRequirements
      ? 'GPU meets CosyVoice requirements'
      : `GPU VRAM ${vramMb}MB is below minimum ${MIN_VRAM_MB}MB`,
  };
}

module.exports = { checkGpuForVoiceClone, MIN_VRAM_MB };
