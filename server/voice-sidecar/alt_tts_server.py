#!/usr/bin/env python3
"""Lightweight TTS sidecar: EdgeTTS and optional Kokoro for AntlerOffice."""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get('VOICE_ALT_TTS_HOST', '127.0.0.1')
PORT = int(os.environ.get('VOICE_ALT_TTS_PORT', '8766'))

FISH_REFERENCE_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


def _normalize_fish_reference_id(raw: str) -> str:
    s = str(raw or '').strip().strip('"').strip("'")
    if not s:
        return ''
    m = re.search(r'fish\.audio/(?:voice/|m/|model/)?([A-Za-z0-9_-]{1,128})', s, re.IGNORECASE)
    if m:
        return m.group(1)
    if '/' in s:
        seg = s.rstrip('/').split('/')[-1]
        if FISH_REFERENCE_ID_RE.fullmatch(seg):
            return seg
    return s

_kokoro_pipeline = None
_kokoro_error: str | None = None


def _json_response(handler: BaseHTTPRequestHandler, code: int, payload: dict) -> None:
    body = json.dumps(payload).encode('utf-8')
    handler.send_response(code)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _audio_response(handler: BaseHTTPRequestHandler, data: bytes, content_type: str, engine: str) -> None:
    handler.send_response(200)
    handler.send_header('Content-Type', content_type)
    handler.send_header('Content-Length', str(len(data)))
    handler.send_header('X-Voice-Engine', engine)
    handler.end_headers()
    handler.wfile.write(data)


async def _synth_edgetts(text: str, voice: str, rate: float) -> bytes:
    import edge_tts

    rate_pct = int((rate - 1.0) * 100)
    rate_str = f'+{rate_pct}%' if rate_pct >= 0 else f'{rate_pct}%'
    comm = edge_tts.Communicate(text, voice, rate=rate_str)
    buf = bytearray()
    async for chunk in comm.stream():
        if chunk['type'] == 'audio':
            buf.extend(chunk['data'])
    return bytes(buf)


def _get_kokoro():
    global _kokoro_pipeline, _kokoro_error
    if _kokoro_pipeline is not None:
        return _kokoro_pipeline
    if _kokoro_error is not None:
        raise RuntimeError(_kokoro_error)
    try:
        from kokoro import KPipeline
        import torch

        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        try:
            _kokoro_pipeline = KPipeline(lang_code='b', device=device)
        except TypeError:
            _kokoro_pipeline = KPipeline(lang_code='b')
        return _kokoro_pipeline
    except Exception as e:
        _kokoro_error = str(e)
        raise


def _synth_fishaudio(text: str, api_key: str, reference_id: str, latency: str = 'balanced') -> bytes:
    """Synthesise speech via Fish Audio Python SDK (bypasses browser CORS)."""
    from fishaudio import FishAudio
    from fishaudio.types import TTSConfig

    client = FishAudio(api_key=api_key)
    config = TTSConfig(
        reference_id=reference_id or None,
        format='mp3',
        latency=latency,   # 'low' | 'balanced' | 'normal'
    )
    audio = client.tts.convert(text=text, config=config)
    return audio


def _synth_kokoro(text: str, voice: str, rate: float) -> bytes:
    import numpy as np
    import soundfile as sf

    pipeline = _get_kokoro()
    chunks: list[np.ndarray] = []
    for _, _, audio in pipeline(text, voice=voice, speed=rate):
        if audio is None:
            continue
        arr = np.asarray(audio, dtype=np.float32)
        if arr.size:
            chunks.append(arr)
    if not chunks:
        raise RuntimeError('Kokoro produced no audio')
    merged = np.concatenate(chunks)
    buf = io.BytesIO()
    sf.write(buf, merged, 24000, format='WAV')
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f'[alt-tts] {self.address_string()} {fmt % args}', flush=True)

    def do_GET(self) -> None:
        if self.path.split('?')[0] == '/health':
            kokoro_ok = _kokoro_pipeline is not None
            _json_response(
                self,
                200,
                {
                    'ready': True,
                    'edgetts': True,
                    'kokoro': kokoro_ok,
                    'kokoro_error': _kokoro_error,
                },
            )
            return
        self.send_error(404)

    def do_POST(self) -> None:
        path = self.path.split('?')[0]

        # ── Fish Audio TTS proxy (bypasses browser CORS) ─────────────────────
        if path == '/tts/fishaudio':
            length = int(self.headers.get('Content-Length', '0'))
            raw = self.rfile.read(length) if length else b'{}'
            try:
                body = json.loads(raw.decode('utf-8'))
            except json.JSONDecodeError:
                _json_response(self, 400, {'ok': False, 'error': 'Invalid JSON'})
                return
            text = str(body.get('text') or '').strip()
            api_key = str(body.get('apiKey') or '').strip()
            reference_id = _normalize_fish_reference_id(body.get('referenceId') or '')
            latency = str(body.get('latency') or 'balanced')
            if not text:
                _json_response(self, 400, {'ok': False, 'error': 'text is required'})
                return
            if not api_key:
                _json_response(self, 400, {'ok': False, 'error': 'apiKey is required'})
                return
            if not FISH_REFERENCE_ID_RE.fullmatch(reference_id):
                _json_response(
                    self,
                    400,
                    {
                        'ok': False,
                        'error': 'reference_id must be 1..=128 chars of [A-Za-z0-9_-] (copy from fish.audio → My Voices)',
                    },
                )
                return
            try:
                data = _synth_fishaudio(text, api_key, reference_id, latency)
                _audio_response(self, data, 'audio/mpeg', 'fishaudio')
            except Exception as e:
                traceback.print_exc()
                _json_response(self, 500, {'ok': False, 'error': str(e)})
            return

        # ── EdgeTTS / Kokoro ──────────────────────────────────────────────────
        if path != '/synthesize':
            self.send_error(404)
            return
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length) if length else b'{}'
        try:
            body = json.loads(raw.decode('utf-8'))
        except json.JSONDecodeError:
            _json_response(self, 400, {'ok': False, 'error': 'Invalid JSON'})
            return

        text = str(body.get('text') or '').strip()
        engine = str(body.get('engine') or 'edgetts').lower()
        voice = str(body.get('voice') or 'en-GB-RyanNeural')
        rate = float(body.get('rate') or 1.0)
        if not text:
            _json_response(self, 400, {'ok': False, 'error': 'text is required'})
            return

        try:
            if engine == 'kokoro':
                data = _synth_kokoro(text, voice, rate)
                _audio_response(self, data, 'audio/wav', 'kokoro')
                return
            if engine == 'edgetts':
                data = asyncio.run(_synth_edgetts(text, voice, rate))
                _audio_response(self, data, 'audio/mpeg', 'edgetts')
                return
            _json_response(self, 400, {'ok': False, 'error': f'Unsupported engine: {engine}'})
        except Exception as e:
            traceback.print_exc()
            _json_response(self, 500, {'ok': False, 'error': str(e)})


def main() -> None:
    print(f'[alt-tts] listening on http://{HOST}:{PORT}', flush=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()


if __name__ == '__main__':
    main()
