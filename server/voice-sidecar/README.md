# Voice sidecar (CosyVoice)

Local HTTP service for AntlerOffice voice clone. Managed by `server/antler/voice-sidecar-manager.js`.

## Ports

| Service | URL | Role |
|---------|-----|------|
| CosyVoice | `http://127.0.0.1:8765` | Text → cloned audio |

## First-run setup (automatic)

1. Checks NVIDIA GPU ≥ 6 GB VRAM
2. Finds Python 3.10–3.12
3. Creates venv at `~/.antleroffice2/voice-runtime/venv`
4. Clones [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) to `~/.antleroffice2/voice-runtime/CosyVoice`
5. Installs PyTorch + CosyVoice deps via `setup_cosyvoice.py`
6. Spawns `cosyvoice_server.py`
7. Downloads `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` to `~/.antleroffice2/voice-models/cosyvoice`

**Requirements:** Git for Windows, Python 3.10+, NVIDIA GPU with ≥6 GB VRAM.

## Environment

```env
VOICE_TTS_URL=http://127.0.0.1:8765
VOICE_TTS_PORT=8765
VOICE_TTS_MIN_VRAM_MB=6144
COSYVOICE_MODEL=FunAudioLLM/Fun-CosyVoice3-0.5B-2512
```

Legacy aliases `VOICE_QWEN_URL` / `VOICE_QWEN_PORT` still work.

## Manual dev run

```bat
cd server\voice-sidecar
set COSYVOICE_ROOT=%USERPROFILE%\.antleroffice2\voice-runtime\CosyVoice
set VOICE_TTS_PORT=8765
%USERPROFILE%\.antleroffice2\voice-runtime\venv\Scripts\python cosyvoice_server.py
```

## API

- `GET /health` — `{ ready: true }` when model loaded
- `GET /debug` — engine stats
- `POST /synthesize` — JSON `{ text, ref_audio, ref_text?, profile_id? }` → WAV
