const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function venvPython() {
  const store = require('./store');
  const py =
    process.platform === 'win32'
      ? path.join(store.getDataDir(), 'voice-runtime', 'venv', 'Scripts', 'python.exe')
      : path.join(store.getDataDir(), 'voice-runtime', 'venv', 'bin', 'python3');
  return fs.existsSync(py) ? py : null;
}

function convertScript() {
  const candidates = [
    path.join(process.env.VOICE_SIDECAR_ROOT || '', 'convert_audio.py'),
    path.join(__dirname, '..', 'voice-sidecar', 'convert_audio.py'),
    path.join(process.resourcesPath || '', 'voice-sidecar', 'convert_audio.py'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[1];
}

function runConvert(py, script, inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(py, [script, inputPath, outputPath], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) resolve(outputPath);
      else reject(new Error(stderr.trim() || `audio convert exited ${code}`));
    });
  });
}

async function ensureWavRef(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.wav') return inputPath;

  const wavPath = inputPath.replace(/\.[^.]+$/, '.wav');
  if (fs.existsSync(wavPath)) return wavPath;

  const py = venvPython();
  if (!py) throw new Error('Voice Python runtime not ready');

  await runConvert(py, convertScript(), inputPath, wavPath);
  return wavPath;
}

module.exports = { ensureWavRef };
