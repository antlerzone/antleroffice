#!/usr/bin/env python3
"""Voice listener sidecar: openWakeWord / Porcupine / Whisper wake + VAD + STT."""

from __future__ import annotations

import io
import json
import os
import re
import struct
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from urllib import request as urlrequest

from wake_engines import (
    OWW_CHUNK_SAMPLES,
    WhisperPhraseDetector,
    build_frame_detector,
    needs_whisper_fallback,
)

HOST = os.environ.get('VOICE_LISTENER_HOST', '127.0.0.1')
PORT = int(os.environ.get('VOICE_LISTENER_PORT', '8767'))
CALLBACK_URL = os.environ.get(
    'VOICE_LISTENER_CALLBACK',
    'http://127.0.0.1:3020/api/voice/listener/event',
)
TYPEWHISPER_URL = os.environ.get('VOICE_TYPEWHISPER_URL', 'http://127.0.0.1:8978').rstrip('/')
SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)

_state_lock = threading.Lock()
_state: dict[str, Any] = {
    'mode': 'sleep',
    'global_listen': True,
    'speaking': False,
    'barge_in': False,
    'last_wake_at': None,
    'last_command_at': None,
    'mic_available': False,
    'engine': 'openwakeword',
    'wake_backend': 'none',
    'wake_error': None,
}

_config: dict[str, Any] = {
    'globalListenEnabled': True,
    'wakePhrases': ['Hey Antler', 'Jarvis', '你好 Antler', '贾维斯'],
    'idleTimeoutSec': 300,
    'wakeEngine': 'openwakeword',
    'sensitivity': 0.5,
    'porcupineAccessKey': '',
}

_detector_lock = threading.Lock()
_frame_detector = None
_whisper_detector: WhisperPhraseDetector | None = None
_use_whisper_fallback = True
_config_token = ''

_stop_event = threading.Event()
_mic_thread: threading.Thread | None = None


def _config_fingerprint(cfg: dict[str, Any]) -> str:
    keys = (
        'wakeEngine',
        'wakePhrases',
        'sensitivity',
        'porcupineAccessKey',
        'porcupineKeywordPaths',
    )
    return json.dumps({k: cfg.get(k) for k in keys}, sort_keys=True, ensure_ascii=False)


def _rebuild_detectors() -> None:
    global _frame_detector, _whisper_detector, _use_whisper_fallback, _config_token

    with _detector_lock:
        if _frame_detector and hasattr(_frame_detector, 'close'):
            try:
                _frame_detector.close()
            except Exception:
                pass

        cfg = dict(_config)
        engine = str(cfg.get('wakeEngine') or 'openwakeword').lower()
        _use_whisper_fallback = needs_whisper_fallback(cfg)
        _whisper_detector = WhisperPhraseDetector(list(cfg.get('wakePhrases') or []))

        wake_error = None
        wake_backend = engine
        try:
            if engine == 'whisper':
                _frame_detector = None
                wake_backend = 'whisper'
            else:
                _frame_detector = build_frame_detector(cfg)
                if _frame_detector:
                    wake_backend = _frame_detector.engine_name
                elif _use_whisper_fallback:
                    wake_backend = 'whisper-fallback'
                    wake_error = f'{engine} unavailable; using whisper fallback'
                else:
                    wake_backend = 'none'
                    wake_error = f'{engine} init failed'
        except Exception as exc:
            _frame_detector = None
            wake_backend = 'whisper-fallback' if _use_whisper_fallback else 'none'
            wake_error = str(exc)

        _config_token = _config_fingerprint(cfg)
        with _state_lock:
            _state['engine'] = engine
            _state['wake_backend'] = wake_backend
            _state['wake_error'] = wake_error

        print(
            f'[listener] wake backend={wake_backend} whisper_fallback={_use_whisper_fallback}',
            flush=True,
        )


def _post_callback(payload: dict[str, Any]) -> None:
    try:
        body = json.dumps(payload).encode('utf-8')
        req = urlrequest.Request(
            CALLBACK_URL,
            data=body,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        urlrequest.urlopen(req, timeout=8)
    except Exception as exc:
        print(f'[listener] callback failed: {exc}', flush=True)


def _json(handler: BaseHTTPRequestHandler, code: int, payload: dict) -> None:
    body = json.dumps(payload).encode('utf-8')
    handler.send_response(code)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _normalize_phrase(text: str) -> str:
    return re.sub(r'\s+', ' ', str(text or '').strip().lower())


def _strip_wake_prefix(text: str) -> str:
    norm = _normalize_phrase(text)
    for phrase in _config.get('wakePhrases') or []:
        p = _normalize_phrase(phrase)
        if not p:
            continue
        if norm == p:
            return ''
        if norm.startswith(f'{p} '):
            return text.strip()[len(phrase) :].strip()
    return text.strip()


def _pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()


def _transcribe_wav(wav_bytes: bytes) -> str:
    boundary = f'----antler{int(time.time() * 1000)}'
    body = b''.join(
        [
            f'--{boundary}\r\n'.encode(),
            b'Content-Disposition: form-data; name="file"; filename="utterance.wav"\r\n',
            b'Content-Type: audio/wav\r\n\r\n',
            wav_bytes,
            b'\r\n',
            f'--{boundary}--\r\n'.encode(),
        ]
    )
    req = urlrequest.Request(
        f'{TYPEWHISPER_URL}/v1/audio/transcriptions',
        data=body,
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
        method='POST',
    )
    with urlrequest.urlopen(req, timeout=90) as res:
        data = json.loads(res.read().decode('utf-8'))
    return str(data.get('text') or data.get('transcript') or '').strip()


def _rms(frame: bytes) -> float:
    if not frame:
        return 0.0
    count = len(frame) // 2
    if count <= 0:
        return 0.0
    samples = struct.unpack('<' + 'h' * count, frame[: count * 2])
    acc = sum(s * s for s in samples)
    return (acc / count) ** 0.5


def _set_mode(mode: str) -> None:
    with _state_lock:
        _state['mode'] = mode
        if mode == 'active':
            _state['last_wake_at'] = time.time()


def _emit_wake(detected_phrase: str | None = None) -> None:
    _set_mode('active')
    payload: dict[str, Any] = {'type': 'wake', 'mode': 'active'}
    if detected_phrase:
        payload['phrase'] = detected_phrase
    _post_callback(payload)


def _emit_transcript(text: str) -> None:
    with _state_lock:
        mode = _state.get('mode', 'sleep')
        _state['last_command_at'] = time.time()
    cleaned = _strip_wake_prefix(text) if mode == 'active' else text.strip()
    if not cleaned:
        return
    _post_callback({'type': 'transcript', 'text': cleaned, 'raw': text, 'mode': mode})


def _maybe_rebuild_detectors() -> None:
    token = _config_fingerprint(_config)
    if token != _config_token:
        _rebuild_detectors()


def _process_sleep_wake_frame(pcm: bytes) -> bool:
    """Run frame-based wake detectors. Returns True if wake fired."""
    with _detector_lock:
        detector = _frame_detector
    if detector:
        try:
            phrase = detector.process_frame(pcm)
        except Exception as exc:
            print(f'[listener] frame wake error: {exc}', flush=True)
            phrase = None
        if phrase:
            _emit_wake(phrase)
            return True
    return False


def _process_sleep_whisper_utterance(utterance: bytes) -> bool:
    with _detector_lock:
        whisper = _whisper_detector
        use_fb = _use_whisper_fallback
        engine = str(_config.get('wakeEngine') or '').lower()

    if not whisper:
        return False
    if engine != 'whisper' and not use_fb:
        return False

    try:
        text = _transcribe_wav(_pcm_to_wav(utterance))
    except Exception as exc:
        print(f'[listener] whisper wake transcribe failed: {exc}', flush=True)
        return False

    if not text:
        return False

    matched = whisper.matches(text)
    if not matched:
        return False

    _emit_wake(matched)
    remainder = _strip_wake_prefix(text)
    if remainder:
        _emit_transcript(remainder)
    return True


def _process_active_utterance(utterance: bytes) -> None:
    try:
        text = _transcribe_wav(_pcm_to_wav(utterance))
    except Exception as exc:
        print(f'[listener] transcribe failed: {exc}', flush=True)
        return
    if text:
        _emit_transcript(text)


def _mic_loop() -> None:
    try:
        import sounddevice as sd  # type: ignore
    except Exception as exc:
        print(f'[listener] sounddevice unavailable: {exc}', flush=True)
        with _state_lock:
            _state['mic_available'] = False
        return

    _rebuild_detectors()

    with _state_lock:
        _state['mic_available'] = True

    threshold = 350.0 * (0.5 + float(_config.get('sensitivity') or 0.5))
    min_speech_ms = 400
    end_silence_ms = 700

    speech_frames: list[bytes] = []
    in_speech = False
    silence_ms = 0
    pre_roll: list[bytes] = []
    speech_ms = 0
    last_active = time.time()
    oww_accum = bytearray()

    print('[listener] mic loop started', flush=True)

    while not _stop_event.is_set():
        _maybe_rebuild_detectors()

        with _state_lock:
            enabled = bool(_config.get('globalListenEnabled', True))
            speaking = bool(_state.get('speaking'))
            barge_in = bool(_state.get('barge_in'))
            mode = str(_state.get('mode') or 'sleep')
            idle_timeout = int(_config.get('idleTimeoutSec') or 300)

        if not enabled:
            time.sleep(0.1)
            continue

        if speaking and not barge_in:
            time.sleep(0.1)
            continue

        if mode == 'active' and idle_timeout > 0 and (time.time() - last_active) > idle_timeout:
            with _state_lock:
                _state['mode'] = 'sleep'
                _state['last_wake_at'] = None
            _post_callback({'type': 'idle', 'mode': 'sleep'})
            mode = 'sleep'
            with _detector_lock:
                if _frame_detector:
                    _frame_detector.reset()

        try:
            frame = sd.rec(
                FRAME_SAMPLES,
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype='int16',
                blocking=True,
            )
            pcm = frame.tobytes()
        except Exception as exc:
            print(f'[listener] mic read failed: {exc}', flush=True)
            time.sleep(0.5)
            continue

        if mode == 'sleep':
            oww_accum.extend(pcm)
            while len(oww_accum) >= OWW_CHUNK_SAMPLES * 2:
                chunk = bytes(oww_accum[: OWW_CHUNK_SAMPLES * 2])
                del oww_accum[: OWW_CHUNK_SAMPLES * 2]
                if _process_sleep_wake_frame(chunk):
                    in_speech = False
                    speech_frames = []
                    pre_roll = []
                    oww_accum.clear()
                    break

        level = _rms(pcm)
        is_voice = level >= threshold

        if not in_speech:
            pre_roll.append(pcm)
            if len(pre_roll) > 8:
                pre_roll.pop(0)
            if is_voice:
                in_speech = True
                speech_frames = list(pre_roll)
                speech_ms = 0
                silence_ms = 0
            continue

        speech_frames.append(pcm)
        speech_ms += FRAME_MS
        if is_voice:
            silence_ms = 0
        else:
            silence_ms += FRAME_MS

        if silence_ms < end_silence_ms:
            continue

        utterance = b''.join(speech_frames)
        in_speech = False
        speech_frames = []
        pre_roll = []
        silence_ms = 0

        if speech_ms < min_speech_ms:
            speech_ms = 0
            continue
        speech_ms = 0

        if mode == 'sleep':
            _process_sleep_whisper_utterance(utterance)
            continue

        if mode == 'active':
            last_active = time.time()
            _process_active_utterance(utterance)


def _ensure_mic_thread() -> None:
    global _mic_thread
    if _mic_thread and _mic_thread.is_alive():
        return
    _stop_event.clear()
    _mic_thread = threading.Thread(target=_mic_loop, name='voice-listener-mic', daemon=True)
    _mic_thread.start()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f'[listener] {self.address_string()} {fmt % args}', flush=True)

    def do_GET(self) -> None:
        path = self.path.split('?')[0]
        if path == '/health':
            with _state_lock:
                _json(self, 200, {'ready': True, 'state': dict(_state)})
            return
        if path == '/status':
            with _state_lock:
                _json(self, 200, {'ok': True, **dict(_state), 'config': dict(_config)})
            return
        self.send_error(404)

    def do_POST(self) -> None:
        path = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length) if length else b'{}'
        try:
            body = json.loads(raw.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            _json(self, 400, {'ok': False, 'error': 'Invalid JSON'})
            return

        if path == '/config':
            _config.update(body or {})
            _rebuild_detectors()
            with _state_lock:
                _state['global_listen'] = bool(_config.get('globalListenEnabled', True))
            if _config.get('globalListenEnabled', True):
                _ensure_mic_thread()
            with _state_lock:
                _json(self, 200, {'ok': True, 'config': dict(_config), 'state': dict(_state)})
            return

        if path == '/mode':
            mode = str(body.get('mode') or 'sleep').lower()
            if mode in ('sleep', 'active', 'speaking'):
                with _state_lock:
                    _state['mode'] = mode
                    if mode == 'active':
                        _state['last_wake_at'] = time.time()
                    if mode == 'sleep':
                        _state['last_wake_at'] = None
                if mode == 'sleep':
                    with _detector_lock:
                        if _frame_detector:
                            _frame_detector.reset()
            with _state_lock:
                _json(self, 200, {'ok': True, 'state': dict(_state)})
            return

        if path == '/speaking':
            with _state_lock:
                _state['speaking'] = bool(body.get('speaking'))
                _state['barge_in'] = bool(body.get('bargeIn')) if _state['speaking'] else False
                if _state['speaking']:
                    if _state['barge_in']:
                        _state['mode'] = 'active'
                        _state['last_wake_at'] = time.time()
                    else:
                        _state['mode'] = 'speaking'
                elif _state['mode'] == 'speaking':
                    _state['mode'] = 'active' if _state.get('last_wake_at') else 'sleep'
                _json(self, 200, {'ok': True, 'state': dict(_state)})
            return

        if path == '/wake':
            _emit_wake()
            with _state_lock:
                _json(self, 200, {'ok': True, 'state': dict(_state)})
            return

        self.send_error(404)


def main() -> None:
    print(f'[listener] on http://{HOST}:{PORT} callback={CALLBACK_URL}', flush=True)
    _ensure_mic_thread()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()


if __name__ == '__main__':
    main()
