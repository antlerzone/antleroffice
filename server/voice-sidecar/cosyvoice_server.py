#!/usr/bin/env python3
"""Local CosyVoice HTTP sidecar for AntlerOffice voice clone."""

from __future__ import annotations

import io
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get('VOICE_TTS_HOST', os.environ.get('VOICE_QWEN_HOST', '127.0.0.1'))
PORT = int(os.environ.get('VOICE_TTS_PORT', os.environ.get('VOICE_QWEN_PORT', '8765')))
COSYVOICE_ROOT = os.environ.get('COSYVOICE_ROOT', '')
MODEL_ID = os.environ.get('COSYVOICE_MODEL', 'FunAudioLLM/Fun-CosyVoice3-0.5B-2512')
MODEL_DIR = os.environ.get('COSYVOICE_MODEL_DIR', '').strip()
MODEL_CACHE = os.environ.get(
    'COSYVOICE_MODEL_CACHE',
    os.path.join(os.path.expanduser('~'), '.antleroffice2', 'voice-models', 'cosyvoice'),
)

_model = None
_model_error: str | None = None
_model_load_ms: int | None = None
_model_device: str | None = None
_last_synth_ms: int | None = None
_synth_count = 0
_speaker_cache: dict[str, str] = {}


def _setup_import_path() -> None:
    if not COSYVOICE_ROOT or not os.path.isdir(COSYVOICE_ROOT):
        raise RuntimeError(f'COSYVOICE_ROOT not found: {COSYVOICE_ROOT}')
    matcha = os.path.join(COSYVOICE_ROOT, 'third_party', 'Matcha-TTS')
    for p in (COSYVOICE_ROOT, matcha):
        if p not in sys.path:
            sys.path.insert(0, p)


def _model_files_complete(model_dir: str) -> bool:
    required = ('llm.pt', 'flow.pt', 'hift.pt', 'campplus.onnx', 'cosyvoice3.yaml')
    return all(os.path.isfile(os.path.join(model_dir, name)) for name in required)


def _resolve_model_dir() -> str:
    if MODEL_DIR and os.path.isdir(MODEL_DIR):
        return MODEL_DIR
    os.makedirs(MODEL_CACHE, exist_ok=True)
    local = os.path.join(MODEL_CACHE, 'Fun-CosyVoice3-0.5B')
    if os.path.isdir(local) and _model_files_complete(local):
        return local
    from modelscope import snapshot_download

    print(f'[cosyvoice] downloading/resuming model {MODEL_ID} ...', flush=True)
    return snapshot_download(MODEL_ID, local_dir=local)


def load_model(*, force: bool = False) -> bool:
    global _model, _model_error, _model_load_ms, _model_device
    if _model is not None:
        return True
    if _model_error is not None and not force:
        return False
    _model_error = None
    import time

    t0 = time.perf_counter()
    try:
        _setup_import_path()
        from cosyvoice.cli.cosyvoice import AutoModel

        model_dir = _resolve_model_dir()
        print(f'[cosyvoice] loading model from {model_dir}', flush=True)
        _model = AutoModel(model_dir=model_dir)
        try:
            import torch

            _model_device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
        except Exception:
            _model_device = 'unknown'
        _model_load_ms = int((time.perf_counter() - t0) * 1000)
        print(f'[cosyvoice] model ready in {_model_load_ms}ms device={_model_device}', flush=True)
        return True
    except Exception as exc:
        _model_error = str(exc)
        _model_load_ms = int((time.perf_counter() - t0) * 1000)
        print(f'[cosyvoice] model load failed: {_model_error}', flush=True)
        traceback.print_exc()
        return False


def _build_prompt_text(ref_text: str | None) -> str:
    text = str(ref_text or '').strip()
    if not text:
        text = '你好，这是我的声音样本，请用我的声音说话。'
    return f'You are a helpful assistant.<|endofprompt|>{text}'


def _ensure_speaker(profile_id: str | None, ref_audio: str, ref_text: str | None) -> str | None:
    if not profile_id or _model is None:
        return None
    if profile_id in _speaker_cache:
        return _speaker_cache[profile_id]
    prompt = _build_prompt_text(ref_text)
    spk_id = f'antler_{profile_id}'
    try:
        if hasattr(_model, 'add_zero_shot_spk'):
            ok = _model.add_zero_shot_spk(prompt, ref_audio, spk_id)
            if ok:
                _speaker_cache[profile_id] = spk_id
                print(f'[cosyvoice] cached speaker {spk_id}', flush=True)
                return spk_id
    except Exception as exc:
        print(f'[cosyvoice] speaker cache skipped: {exc}', flush=True)
    return None


def synthesize_clone(
    text: str,
    ref_audio: str,
    ref_text: str | None = None,
    profile_id: str | None = None,
) -> tuple[bytes, str]:
    import torchaudio

    if _model is None:
        raise RuntimeError(_model_error or 'Model not loaded')

    out_text = str(text or '').strip()
    if not out_text:
        raise ValueError('text is required')
    if not ref_audio or not os.path.isfile(ref_audio):
        raise ValueError('ref_audio file not found')

    spk_id = _ensure_speaker(profile_id, ref_audio, ref_text)
    result = None

    if spk_id:
        print(f'[cosyvoice] zero_shot cached spk={spk_id} text={out_text[:60]}', flush=True)
        for chunk in _model.inference_zero_shot(out_text, '', '', zero_shot_spk_id=spk_id, stream=False):
            result = chunk
    else:
        prompt = _build_prompt_text(ref_text)
        print(f'[cosyvoice] zero_shot text={out_text[:60]}', flush=True)
        for chunk in _model.inference_zero_shot(out_text, prompt, ref_audio, stream=False):
            result = chunk

    if not result or 'tts_speech' not in result:
        raise RuntimeError('CosyVoice returned no audio')

    buf = io.BytesIO()
    torchaudio.save(buf, result['tts_speech'], _model.sample_rate, format='wav')
    return buf.getvalue(), 'audio/wav'


def debug_info() -> dict:
    info = {
        'engine': 'cosyvoice',
        'model': MODEL_ID,
        'ready': _model is not None,
        'error': _model_error,
        'device': _model_device,
        'loadMs': _model_load_ms,
        'lastSynthMs': _last_synth_ms,
        'synthCount': _synth_count,
        'speakerCacheSize': len(_speaker_cache),
        'cosyvoiceRoot': COSYVOICE_ROOT,
        'modelDir': MODEL_DIR or MODEL_CACHE,
    }
    try:
        import torch

        info['cudaAvailable'] = torch.cuda.is_available()
        if torch.cuda.is_available():
            info['cudaDevice'] = torch.cuda.get_device_name(0)
            info['vramAllocatedMb'] = round(torch.cuda.memory_allocated(0) / 1024 / 1024, 1)
    except Exception as exc:
        info['torchError'] = str(exc)
    return info


class Handler(BaseHTTPRequestHandler):
    server_version = 'AntlerOfficeCosyVoice/1.0'

    def log_message(self, fmt, *args):
        print(f'[cosyvoice] {self.address_string()} - {fmt % args}', flush=True)

    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/debug':
            self._send_json(200, {'ok': True, **debug_info()})
            return
        if self.path != '/health':
            self._send_json(404, {'ok': False, 'error': 'not found'})
            return
        if _model is not None:
            self._send_json(200, {'ok': True, 'ready': True, **debug_info()})
        elif _model_error:
            self._send_json(503, {'ok': False, 'ready': False, 'error': _model_error, **debug_info()})
        else:
            self._send_json(503, {'ok': False, 'ready': False, 'phase': 'loading', **debug_info()})

    def do_POST(self):
        if self.path != '/synthesize':
            self._send_json(404, {'ok': False, 'error': 'not found'})
            return
        if _model is None:
            self._send_json(503, {'ok': False, 'error': _model_error or 'Model loading'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            raw = self.rfile.read(length) if length else b'{}'
            data = json.loads(raw.decode('utf-8') or '{}')
            text = str(data.get('text') or '').strip()
            ref_audio = str(data.get('ref_audio') or '').strip()
            ref_text = str(data.get('ref_text') or '').strip() or None
            profile_id = str(data.get('profile_id') or '').strip() or None
            if not text:
                self._send_json(400, {'ok': False, 'error': 'text is required'})
                return
            import time

            t0 = time.perf_counter()
            audio, content_type = synthesize_clone(text, ref_audio, ref_text, profile_id)
            global _last_synth_ms, _synth_count
            synth_ms = int((time.perf_counter() - t0) * 1000)
            _last_synth_ms = synth_ms
            _synth_count += 1
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(audio)))
            self.send_header('X-Synth-Ms', str(synth_ms))
            self.send_header('X-Voice-Engine', 'cosyvoice')
            self.end_headers()
            self.wfile.write(audio)
        except Exception as exc:
            traceback.print_exc()
            self._send_json(500, {'ok': False, 'error': str(exc)})


def main():
    import time

    print(f'[cosyvoice] Starting sidecar on {HOST}:{PORT}', flush=True)
    for attempt in range(1, 121):
        if load_model(force=attempt > 1):
            break
        wait_s = min(30, 5 + attempt // 2)
        print(f'[cosyvoice] retry model load in {wait_s}s (attempt {attempt})', flush=True)
        time.sleep(wait_s)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f'[cosyvoice] Listening (model_ready={_model is not None})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
