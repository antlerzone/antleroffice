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
    ClapDetector,
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
_SERVER_PORT = os.environ.get('PORT', '3020')
TRANSCRIBE_URL = os.environ.get(
    'VOICE_TRANSCRIBE_URL',
    f'http://127.0.0.1:{_SERVER_PORT}/api/voice/transcribe',
).rstrip('/')
SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)
# Boost quiet USB conference mics (EMEET etc.) before VAD / wake / meter.
MIC_GAIN = max(1.0, min(8.0, float(os.environ.get('VOICE_MIC_GAIN', '8.0'))))
# Extra AGC cap — total gain (MIC_GAIN × AGC) for wake processing.
MAX_TOTAL_GAIN = max(MIC_GAIN, min(96.0, float(os.environ.get('VOICE_MAX_TOTAL_GAIN', '64.0'))))
WAKE_TARGET_RMS = 160.0
# Sleep-mode wake phrases should be short; cap runaway VAD (room noise) utterances.
WAKE_MAX_SPEECH_MS = 5000
WAKE_EMIT_MIN_INTERVAL = 3.0
WAKE_BLOCK_AFTER_SPEAKING_SEC = 3.0

_last_wake_emit_at = 0.0
_wake_block_until = 0.0

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
    'wakePhrases': ['Hey Jarvis', 'Hi Jarvis'],
    'idleTimeoutSec': 300,
    'wakeEngine': 'openwakeword',
    'sensitivity': 0.5,
    'porcupineAccessKey': '',
    'clapWake': False,
    'clapWakeCount': 2,
    'inputDeviceIndex': None,
    'replyLanguage': 'auto',
    'realtimeSessionActive': False,
  }

_detector_lock = threading.Lock()
_frame_detector = None
_clap_detector: ClapDetector | None = None
_whisper_detector: WhisperPhraseDetector | None = None
_use_whisper_fallback = True
_config_token = ''

_stop_event = threading.Event()
_mic_thread: threading.Thread | None = None

# Rolling peak RMS — updated every frame, decays after 3 s of quiet.
_peak_rms: float = 0.0
_peak_rms_at: float = 0.0
_current_rms: float = 0.0
_raw_rms: float = 0.0
_noise_floor: float = 12.0
_input_device: int | None = None
_last_device_scan_at: float = 0.0


def _vad_threshold(sensitivity: float) -> float:
    """Speech gate — higher sensitivity => lower threshold (easier wake on quiet mics)."""
    s = max(0.1, min(1.0, float(sensitivity or 0.5)))
    base = 95.0 - 45.0 * s  # ~72 @ 0.5, ~50 @ 1.0
    adaptive = max(base, _noise_floor * 1.35 + 8.0)
    capped = min(adaptive, 180.0)
    # Quiet USB mics: lower gate when boosted peak is still low.
    if _peak_rms < 80:
        quiet_gate = max(8.0, _noise_floor * 0.85 + 4.0, _peak_rms * 0.35 + 3.0)
        return min(capped, quiet_gate)
    return capped


def _clap_threshold(sensitivity: float) -> float:
    s = max(0.1, min(1.0, float(sensitivity or 0.5)))
    fixed = max(120.0, min(900.0, 180.0 + 320.0 * (1.1 - s)))
    # Quiet USB mics: clap spikes are lower — adapt to recent peak RMS.
    adaptive = max(100.0, min(600.0, _peak_rms * 1.6 + 80.0))
    if _peak_rms < 250:
        return min(fixed, adaptive)
    return fixed


def _config_fingerprint(cfg: dict[str, Any]) -> str:
    keys = (
        'wakeEngine',
        'wakePhrases',
        'sensitivity',
        'porcupineAccessKey',
        'porcupineKeywordPaths',
        'clapWake',
        'clapWakeCount',
    )
    return json.dumps({k: cfg.get(k) for k in keys}, sort_keys=True, ensure_ascii=False)


def _rebuild_detectors() -> None:
    global _frame_detector, _clap_detector, _whisper_detector, _use_whisper_fallback, _config_token

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
        phrases = list(cfg.get('wakePhrases') or [])

        try:
            if engine == 'whisper':
                _frame_detector = None
                wake_backend = 'whisper'
                # Instant wake for Hey/Hi Jarvis via openWakeWord while keeping Whisper STT fallback.
                try:
                    oww_cfg = dict(cfg)
                    oww_cfg['wakeEngine'] = 'openwakeword'
                    oww_det = build_frame_detector(oww_cfg)
                    if oww_det:
                        _frame_detector = oww_det
                        wake_backend = 'openwakeword+whisper'
                except Exception as oww_exc:
                    print(f'[listener] whisper+oww hybrid skipped: {oww_exc}', flush=True)
            elif not phrases:
                _frame_detector = None
                wake_backend = 'idle'
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

        # Build (or clear) clap detector.
        print(f'[listener/debug] clapWake={cfg.get("clapWake")!r} clapWakeCount={cfg.get("clapWakeCount")!r}', flush=True)
        if bool(cfg.get('clapWake')):
            clap_count = int(cfg.get('clapWakeCount') or 2)
            clap_thr = _clap_threshold(float(cfg.get('sensitivity') or 0.5))
            _clap_detector = ClapDetector(threshold=clap_thr, count=clap_count, window_sec=3.0)
            print(f'[listener] clap-wake ENABLED count={clap_count} threshold={clap_thr:.0f}', flush=True)
        else:
            _clap_detector = None
            print('[listener/debug] clap-wake DISABLED (clapWake not set or false)', flush=True)

        _config_token = _config_fingerprint(cfg)
        with _state_lock:
            _state['engine'] = engine
            _state['wake_backend'] = wake_backend
            _state['wake_error'] = wake_error

        phrases = list(cfg.get('wakePhrases') or [])
        print(
            f'[listener] wake backend={wake_backend} whisper_fallback={_use_whisper_fallback} '
            f'phrases={phrases} whisper_phrases={_whisper_detector._phrases}',
            flush=True,
        )


def _post_callback(payload: dict[str, Any]) -> bool:
    if payload.get('type') == 'wake':
        print(
            f"[summon] callback wake phrase={payload.get('phrase')!r} mode={payload.get('mode')}",
            flush=True,
        )
    body = json.dumps(payload).encode('utf-8')
    for attempt in range(3):
        try:
            req = urlrequest.Request(
                CALLBACK_URL,
                data=body,
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            urlrequest.urlopen(req, timeout=8)
            return True
        except Exception as exc:
            print(f'[listener] callback failed (attempt {attempt + 1}/3): {exc}', flush=True)
            time.sleep(0.25 * (attempt + 1))
    return False


def _json(handler: BaseHTTPRequestHandler, code: int, payload: dict) -> None:
    body = json.dumps(payload).encode('utf-8')
    handler.send_response(code)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _normalize_phrase(text: str) -> str:
    """Lowercase, drop punctuation — matches Whisper transcripts like 'hi jarvis'."""
    t = str(text or '').strip().lower()
    t = re.sub(r'[^\w\s\u4e00-\u9fff]+', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def _strip_wake_prefix(text: str) -> str:
    return _strip_all_wake_phrases(text)


def _strip_all_wake_phrases(text: str) -> str:
    """Remove every configured wake phrase from transcript (handles STT echo / prompt bleed)."""
    norm = _normalize_phrase(text)
    if not norm:
        return ''
    phrases = sorted(
        (_normalize_phrase(p) for p in (_config.get('wakePhrases') or [])),
        key=len,
        reverse=True,
    )
    changed = True
    while changed and norm:
        changed = False
        for p in phrases:
            if not p:
                continue
            if norm == p:
                norm = ''
                changed = True
                break
            if norm.startswith(f'{p} '):
                norm = norm[len(p) :].strip()
                changed = True
                break
            if f' {p} ' in f' {norm} ':
                norm = re.sub(rf'\b{re.escape(p)}\b', ' ', norm)
                norm = re.sub(r'\s+', ' ', norm).strip()
                changed = True
                break
    return norm


def _is_wake_only_text(text: str) -> bool:
    return not _strip_all_wake_phrases(text)


def _pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()


def _wake_stt_language() -> str | None:
    """Pick STT language for wake utterances. Mixed en+zh lists use replyLanguage."""
    phrases = list(_config.get('wakePhrases') or [])
    norms = [_normalize_phrase(p) for p in phrases if _normalize_phrase(p)]
    has_zh = any(re.search(r'[\u4e00-\u9fff]', n) for n in norms)
    has_en = any(n and not re.search(r'[\u4e00-\u9fff]', n) for n in norms)
    reply = str(_config.get('replyLanguage') or 'auto').strip().lower()
    if has_zh and not has_en:
        return 'zh'
    if has_en and not has_zh:
        return 'en'
    if has_zh and has_en:
        # Mixed wake list (Hi Jarvis + 贾维斯): auto-detect — forcing zh breaks English wake.
        return None
    if reply in ('zh', 'en'):
        return reply
    return None


def _transcribe_wav_with_language(wav_bytes: bytes, language: str | None) -> str:
    boundary = f'----antler{int(time.time() * 1000)}'
    owner_key = str(_config.get('ownerKey') or 'local:boss')
    owner_name = str(_config.get('ownerName') or 'Boss')
    parts: list[bytes] = [
        f'--{boundary}\r\n'.encode(),
        b'Content-Disposition: form-data; name="audio"; filename="utterance.wav"\r\n',
        b'Content-Type: audio/wav\r\n\r\n',
        wav_bytes,
        b'\r\n',
        f'--{boundary}\r\n'.encode(),
        f'Content-Disposition: form-data; name="ownerKey"\r\n\r\n'.encode(),
        owner_key.encode('utf-8'),
        b'\r\n',
        f'--{boundary}\r\n'.encode(),
        f'Content-Disposition: form-data; name="ownerName"\r\n\r\n'.encode(),
        owner_name.encode('utf-8'),
        b'\r\n',
    ]
    if language:
        parts.extend(
            [
                f'--{boundary}\r\n'.encode(),
                b'Content-Disposition: form-data; name="language"\r\n\r\n',
                language.encode('utf-8'),
                b'\r\n',
            ]
        )
    wake_phrases = [str(p).strip() for p in (_config.get('wakePhrases') or []) if str(p).strip()]
    if wake_phrases:
        hint = 'Hey Jarvis. Hi Jarvis.'
        parts.extend(
            [
                f'--{boundary}\r\n'.encode(),
                b'Content-Disposition: form-data; name="prompt"\r\n\r\n',
                hint.encode('utf-8'),
                b'\r\n',
            ]
        )
    parts.append(f'--{boundary}--\r\n'.encode())
    body = b''.join(parts)
    req = urlrequest.Request(
        TRANSCRIBE_URL,
        data=body,
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
        method='POST',
    )
    with urlrequest.urlopen(req, timeout=120) as res:
        data = json.loads(res.read().decode('utf-8'))
    if not data.get('ok'):
        raise RuntimeError(str(data.get('error') or 'transcribe failed'))
    return str(data.get('text') or '').strip()


def _transcribe_via_server(wav_bytes: bytes) -> str:
    return _transcribe_wav_with_language(wav_bytes, _wake_stt_language())


def _transcribe_typewhisper(wav_bytes: bytes) -> str:
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


def _transcribe_wav(wav_bytes: bytes) -> str:
    try:
        text = _transcribe_via_server(wav_bytes)
        if text:
            return text
    except Exception as exc:
        print(f'[wake/stt] server transcribe failed: {exc}', flush=True)
    try:
        return _transcribe_typewhisper(wav_bytes)
    except Exception as exc:
        print(f'[wake/stt] TypeWhisper fallback failed: {exc}', flush=True)
        raise


def _amplify_pcm(pcm: bytes, gain: float) -> bytes:
    if gain <= 1.01 or not pcm:
        return pcm
    count = len(pcm) // 2
    if count <= 0:
        return pcm
    samples = struct.unpack('<' + 'h' * count, pcm[: count * 2])
    boosted = tuple(max(-32768, min(32767, int(s * gain))) for s in samples)
    return struct.pack('<' + 'h' * count, *boosted)


def _frame_gain(raw_rms: float) -> float:
    """Normalize toward WAKE_TARGET_RMS — boost quiet USB mics, attenuate loud (prevents clip)."""
    if raw_rms < 0.5:
        return MIC_GAIN
    ideal = WAKE_TARGET_RMS / raw_rms
    return max(0.35, min(MAX_TOTAL_GAIN, ideal))


def _normalize_utterance_for_stt(pcm: bytes) -> bytes:
    """Re-level captured speech for STT — quiet USB mics need strong boost."""
    level = _rms(pcm)
    if level < 1:
        gain = min(MAX_TOTAL_GAIN, WAKE_TARGET_RMS / max(level, 0.5))
        return _amplify_pcm(pcm, gain)
    if level < WAKE_TARGET_RMS * 0.75:
        gain = min(MAX_TOTAL_GAIN, WAKE_TARGET_RMS / level)
        return _amplify_pcm(pcm, gain)
    if level > WAKE_TARGET_RMS * 1.35:
        return _amplify_pcm(pcm, WAKE_TARGET_RMS / level)
    return pcm


def _process_frame_pcm(raw_pcm: bytes) -> tuple[bytes, float, float]:
    """Return (boosted_pcm, raw_rms, boosted_rms)."""
    raw_level = _rms(raw_pcm)
    gain = _frame_gain(raw_level)
    pcm = _amplify_pcm(raw_pcm, gain)
    return pcm, raw_level, _rms(pcm)


def _device_name_matches(name: str) -> bool:
    n = str(name or '').lower()
    hints = (
        os.environ.get('VOICE_INPUT_DEVICE_NAME', ''),
        'emeet',
        'offcore',
        'usb',
        'microphone',
    )
    for hint in hints:
        h = str(hint or '').strip().lower()
        if h and h in n:
            return True
    return False


def _resolve_input_device(sd: Any) -> int | None:
    """Pick input device from config/env, else default / best EMEET-like device."""
    cfg_idx = _config.get('inputDeviceIndex')
    if cfg_idx is not None and cfg_idx != '':
        try:
            idx = int(cfg_idx)
            dev = sd.query_devices(idx)
            if int(dev.get('max_input_channels') or 0) >= 1:
                return idx
        except Exception as exc:
            print(f'[listener] configured input device invalid: {exc}', flush=True)

    env_dev = str(os.environ.get('VOICE_INPUT_DEVICE', '')).strip()
    if env_dev:
        if env_dev.isdigit():
            try:
                idx = int(env_dev)
                dev = sd.query_devices(idx)
                if int(dev.get('max_input_channels') or 0) >= 1:
                    return idx
            except Exception:
                pass
        else:
            for i, dev in enumerate(sd.query_devices()):
                if int(dev.get('max_input_channels') or 0) < 1:
                    continue
                if env_dev.lower() in str(dev.get('name') or '').lower():
                    return i

    try:
        default_in, _ = sd.default.device
        if int(default_in) >= 0:
            return int(default_in)
    except Exception:
        pass

    for i, dev in enumerate(sd.query_devices()):
        if int(dev.get('max_input_channels') or 0) >= 1 and _device_name_matches(str(dev.get('name') or '')):
            return i
    return None


def _scan_best_input_device(sd: Any, duration_sec: float = 0.3) -> tuple[int | None, float]:
    """Sample each input briefly; return (index, best boosted RMS)."""
    best_idx: int | None = None
    best_rms = 0.0
    frames = max(1, int(SAMPLE_RATE * duration_sec))
    for i, dev in enumerate(sd.query_devices()):
        if int(dev.get('max_input_channels') or 0) < 1:
            continue
        try:
            chunk = sd.rec(frames, samplerate=SAMPLE_RATE, channels=1, dtype='int16', device=i, blocking=True)
            _, _, boosted = _process_frame_pcm(chunk.tobytes())
            if boosted > best_rms:
                best_rms = boosted
                best_idx = i
        except Exception:
            continue
    return best_idx, best_rms


def _list_input_devices(sd: Any) -> list[dict[str, Any]]:
    devices: list[dict[str, Any]] = []
    current = _input_device
    for i, dev in enumerate(sd.query_devices()):
        if int(dev.get('max_input_channels') or 0) < 1:
            continue
        devices.append(
            {
                'index': i,
                'name': str(dev.get('name') or f'device-{i}'),
                'channels': int(dev.get('max_input_channels') or 1),
                'defaultSampleRate': float(dev.get('default_samplerate') or SAMPLE_RATE),
                'active': i == current,
            }
        )
    return devices


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


def _block_wake_for(seconds: float) -> None:
    global _wake_block_until
    until = time.time() + max(0.0, seconds)
    if until > _wake_block_until:
        _wake_block_until = until


def _emit_wake(detected_phrase: str | None = None) -> None:
    global _last_wake_emit_at
    now = time.time()
    if now < _wake_block_until:
        print(
            f'[summon] wake suppressed (cooldown { _wake_block_until - now:.1f}s) phrase={detected_phrase!r}',
            flush=True,
        )
        return
    with _state_lock:
        if not bool(_config.get('globalListenEnabled', True)):
            print(f'[summon] wake suppressed — global listen off phrase={detected_phrase!r}', flush=True)
            return
        if _state.get('speaking'):
            print(f'[summon] wake suppressed — TTS speaking phrase={detected_phrase!r}', flush=True)
            return
        mode = str(_state.get('mode') or 'sleep')
        if mode in ('active', 'speaking'):
            print(f'[summon] wake suppressed — already {mode} phrase={detected_phrase!r}', flush=True)
            return
    if now - _last_wake_emit_at < WAKE_EMIT_MIN_INTERVAL:
        return
    print(f'[summon] wake detected phrase={detected_phrase!r}', flush=True)
    payload: dict[str, Any] = {'type': 'wake', 'mode': 'active'}
    if detected_phrase:
        payload['phrase'] = detected_phrase
    if not _post_callback(payload):
        print('[summon] wake callback failed — staying in sleep so wake can retry', flush=True)
        with _state_lock:
            _state['mode'] = 'sleep'
            _state['last_wake_at'] = None
        with _detector_lock:
            if _frame_detector:
                _frame_detector.reset()
        return
    _last_wake_emit_at = now
    _set_mode('active')


def _emit_transcript(text: str) -> None:
    cleaned = _strip_all_wake_phrases(text)
    if not cleaned or _is_wake_only_text(text):
        print(f'[listener] transcript skipped (wake-only): "{text}"', flush=True)
        return
    with _state_lock:
        mode = _state.get('mode', 'sleep')
        _state['last_command_at'] = time.time()
    _post_callback({'type': 'transcript', 'text': cleaned, 'raw': text, 'mode': mode})


def _maybe_rebuild_detectors() -> None:
    token = _config_fingerprint(_config)
    if token != _config_token:
        _rebuild_detectors()


def _process_sleep_wake_frame(pcm: bytes) -> bool:
    """Run frame-based wake detectors. Returns True if wake fired."""
    with _detector_lock:
        detector = _frame_detector
        if detector is not None and hasattr(detector, 'set_quiet_context'):
            detector.set_quiet_context(_peak_rms)
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

    print(f'[wake/whisper] utterance received: {len(utterance)} bytes  engine={engine}  use_fallback={use_fb}  whisper_detector={whisper is not None}', flush=True)

    if not whisper or not getattr(whisper, '_phrases', None):
        print('[wake/whisper] SKIP — no whisper_detector or phrases', flush=True)
        return False

    wav = _pcm_to_wav(_normalize_utterance_for_stt(utterance))
    wav_rms = _rms(utterance)
    stt_rms = _rms(_normalize_utterance_for_stt(utterance))
    print(
        f'[wake/whisper] wav rms in={wav_rms:.0f} normalized={stt_rms:.0f} peak={_peak_rms:.0f}',
        flush=True,
    )
    norms = [_normalize_phrase(p) for p in (_config.get('wakePhrases') or []) if _normalize_phrase(p)]
    has_en = any(n and not re.search(r'[\u4e00-\u9fff]', n) for n in norms)
    has_zh = any(re.search(r'[\u4e00-\u9fff]', n) for n in norms)

    lang_order: list[str | None] = []
    if has_en:
        lang_order.extend(['en', None])
    if has_zh:
        lang_order.append('zh')
    if not lang_order:
        lang_order = [None]

    transcripts: list[tuple[str, str]] = []
    seen: set[str] = set()
    for lang in lang_order:
        try:
            text = _transcribe_wav_with_language(wav, lang)
            key = _normalize_phrase(text)
            if not key or key in seen:
                continue
            seen.add(key)
            transcripts.append((text, lang or 'auto'))
        except Exception as exc:
            print(f'[wake/whisper] transcribe ({lang or "auto"}) failed: {exc}', flush=True)

    if not transcripts:
        try:
            text = _transcribe_typewhisper(wav)
            key = _normalize_phrase(text)
            if key and key not in seen:
                transcripts.append((text, 'typewhisper'))
        except Exception as exc:
            print(f'[wake/whisper] typewhisper fallback failed: {exc}', flush=True)

    if not transcripts:
        print('[wake/whisper] empty transcript, skipping', flush=True)
        _post_callback({
            'type': 'wake_miss',
            'reason': 'empty_transcript',
            'peakRms': round(_peak_rms),
            'utteranceRms': round(wav_rms),
        })
        return False

    for text, lang_tag in transcripts:
        print(f'[wake/whisper] transcribed ({lang_tag}): "{text}"', flush=True)
        matched = whisper.matches(text)
        print(f'[wake/whisper] phrase match → "{matched}"  (phrases={whisper._phrases})', flush=True)
        if not matched:
            continue
        _emit_wake(matched)
        remainder = _strip_all_wake_phrases(text)
        if remainder:
            _emit_transcript(remainder)
        return True
    return False


def _process_active_utterance(utterance: bytes) -> None:
    try:
        text = _transcribe_wav(_pcm_to_wav(utterance))
    except Exception as exc:
        print(f'[listener] transcribe failed: {exc}', flush=True)
        return
    if not text:
        return
    with _detector_lock:
        whisper = _whisper_detector
    if whisper:
        matched = whisper.matches(text)
        if matched:
            print(f'[wake/active] wake phrase in active session ignored phrase="{matched}" raw="{text}"', flush=True)
            remainder = _strip_all_wake_phrases(text)
            if remainder:
                _emit_transcript(remainder)
            return
    _emit_transcript(text)


def _mic_loop() -> None:
    global _peak_rms, _peak_rms_at, _noise_floor, _current_rms, _raw_rms, _input_device, _last_device_scan_at
    try:
        import sounddevice as sd  # type: ignore
    except Exception as exc:
        print(f'[listener] sounddevice unavailable: {exc}', flush=True)
        with _state_lock:
            _state['mic_available'] = False
        return

    _input_device = _resolve_input_device(sd)
    if _input_device is None:
        print('[listener] no input device found', flush=True)
        with _state_lock:
            _state['mic_available'] = False
        return

    try:
        dev_info = sd.query_devices(_input_device)
        print(
            f'[listener] mic device #{_input_device}: {dev_info.get("name", "?")} '
            f'channels={dev_info.get("max_input_channels", "?")} gain={MIC_GAIN}x max={MAX_TOTAL_GAIN}x',
            flush=True,
        )
    except Exception as exc:
        print(f'[listener] mic device query failed: {exc}', flush=True)

    _rebuild_detectors()
    _last_device_scan_at = time.time()

    with _state_lock:
        _state['mic_available'] = True

    min_speech_ms = 400
    end_silence_ms = 700

    speech_frames: list[bytes] = []
    in_speech = False
    silence_ms = 0
    pre_roll: list[bytes] = []
    speech_ms = 0
    last_active = time.time()
    oww_accum = bytearray()
    _debug_clap_log_at = time.time()
    threshold = _vad_threshold(float(_config.get('sensitivity') or 0.5))
    rec_kwargs: dict[str, Any] = {
        'samplerate': SAMPLE_RATE,
        'channels': 1,
        'dtype': 'int16',
        'blocking': True,
    }

    print(f'[listener] mic loop started vad_threshold={threshold:.0f} mic_gain={MIC_GAIN}x', flush=True)

    while not _stop_event.is_set():
        _maybe_rebuild_detectors()

        with _state_lock:
            enabled = bool(_config.get('globalListenEnabled', True))
            speaking = bool(_state.get('speaking'))
            barge_in = bool(_state.get('barge_in'))
            mode = str(_state.get('mode') or 'sleep')
            idle_timeout = int(_config.get('idleTimeoutSec') or 300)

        # Periodic debug: every 10 s log clap detector status
        now_ts = time.time()
        if now_ts - _debug_clap_log_at >= 10.0:
            _debug_clap_log_at = now_ts
            with _detector_lock:
                cd_status = _clap_detector is not None
            sens = float(_config.get('sensitivity') or 0.5)
            threshold = _vad_threshold(sens)
            print(
                f'[listener/debug] heartbeat mode={mode} raw_rms={_raw_rms:.0f} peak_rms={_peak_rms:.0f} '
                f'vad_threshold={threshold:.0f} noise_floor={_noise_floor:.0f} device={_input_device} '
                f'clap_active={cd_status}',
                flush=True,
            )
            if _peak_rms < 25 and now_ts - _last_device_scan_at > 20.0:
                best_idx, best_rms = _scan_best_input_device(sd)
                _last_device_scan_at = now_ts
                if best_idx is not None and best_idx != _input_device and best_rms > _peak_rms + 25:
                    print(
                        f'[listener] switching input device {_input_device} → {best_idx} (rms {best_rms:.0f})',
                        flush=True,
                    )
                    _input_device = best_idx

        if not enabled:
            time.sleep(0.1)
            continue

        desired_device = _resolve_input_device(sd)
        if desired_device is not None and desired_device != _input_device:
            _input_device = desired_device
            print(f'[listener] input device changed → #{_input_device}', flush=True)

        try:
            frame = sd.rec(FRAME_SAMPLES, device=_input_device, **rec_kwargs)
            pcm, raw_level, level = _process_frame_pcm(frame.tobytes())
            _raw_rms = raw_level
        except Exception as exc:
            print(f'[listener] mic read failed: {exc}', flush=True)
            time.sleep(0.5)
            continue

        _current_rms = level
        sens = float(_config.get('sensitivity') or 0.5)
        threshold = _vad_threshold(sens)
        if not in_speech and level < threshold:
            _noise_floor = _noise_floor * 0.92 + level * 0.08
        is_voice = level >= threshold

        now_rms = time.time()
        if level >= _peak_rms:
            _peak_rms = level
            _peak_rms_at = now_rms
        elif now_rms - _peak_rms_at > 1.5:
            _peak_rms = max(level, _peak_rms * 0.85)
            _peak_rms_at = now_rms

        if speaking and not barge_in:
            continue

        if mode == 'active' and idle_timeout > 0:
            with _state_lock:
                lw = float(_state.get('last_wake_at') or 0)
                lc = float(_state.get('last_command_at') or 0)
            activity_at = max(lw, lc, last_active)
            if activity_at > 0 and (time.time() - activity_at) > idle_timeout:
                with _state_lock:
                    _state['mode'] = 'sleep'
                    _state['last_wake_at'] = None
                _post_callback({'type': 'idle', 'mode': 'sleep'})
                mode = 'sleep'
                with _detector_lock:
                    if _frame_detector:
                        _frame_detector.reset()

        if mode == 'sleep' and not bool(_config.get('realtimeSessionActive')):
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

        # Clap-wake only in sleep while browser realtime is not handling the session.
        if mode == 'sleep' and not bool(_config.get('realtimeSessionActive')):
            with _detector_lock:
                cd = _clap_detector
            if cd and cd.process_frame(level):
                _emit_wake('clap')
                in_speech = False
                speech_frames = []
                pre_roll = []
                oww_accum.clear()
                continue

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

        if (
            mode == 'sleep'
            and speech_ms >= WAKE_MAX_SPEECH_MS
            and not bool(_config.get('realtimeSessionActive'))
        ):
            print(f'[wake/vad] max speech {speech_ms}ms — flushing wake utterance', flush=True)
            silence_ms = end_silence_ms

        if silence_ms < end_silence_ms:
            continue

        utterance = b''.join(speech_frames)
        in_speech = False
        speech_frames = []
        pre_roll = []
        silence_ms = 0

        quiet_mic = _peak_rms < 40
        min_ms = 280 if quiet_mic else min_speech_ms
        if speech_ms < min_ms:
            print(f'[wake/vad] utterance too short ({speech_ms}ms < {min_ms}ms), ignored', flush=True)
            speech_ms = 0
            continue
        speech_ms = 0

        print(f'[wake/vad] utterance captured mode={mode} len={len(utterance)} bytes', flush=True)

        if mode == 'sleep' and not bool(_config.get('realtimeSessionActive')):
            _process_sleep_whisper_utterance(utterance)
            continue

        if mode == 'active':
            if bool(_config.get('realtimeSessionActive')):
                print('[wake/vad] active utterance skipped — browser realtime owns mic', flush=True)
                continue
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
                state_copy = dict(_state)
            with _detector_lock:
                clap_active = _clap_detector is not None
                clap_threshold = _clap_detector._threshold if _clap_detector else 2500.0
            sens = float(_config.get('sensitivity') or 0.5)
            vad_thr = _vad_threshold(sens)
            peak = 0 if _peak_rms != _peak_rms else round(_peak_rms)
            current = 0 if _current_rms != _current_rms else round(_current_rms)
            raw = 0 if _raw_rms != _raw_rms else round(_raw_rms)
            _json(self, 200, {
                'ready': True,
                'state': state_copy,
                'clapDetectorActive': clap_active,
                'clapThreshold': clap_threshold,
                'peakRms': peak,
                'currentRms': current,
                'rawRms': raw,
                'vadThreshold': round(vad_thr),
                'micGain': MIC_GAIN,
                'maxTotalGain': MAX_TOTAL_GAIN,
                'inputDevice': _input_device,
            })
            return
        if path == '/devices':
            try:
                import sounddevice as sd  # type: ignore

                _json(self, 200, {'ok': True, 'devices': _list_input_devices(sd), 'active': _input_device})
            except Exception as exc:
                _json(self, 500, {'ok': False, 'error': str(exc)})
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
            body = body or {}
            _config.update(body)
            if 'realtimeSessionActive' in body:
                _config['realtimeSessionActive'] = bool(body['realtimeSessionActive'])
            elif str(_state.get('mode') or 'sleep') == 'sleep':
                _config['realtimeSessionActive'] = False
            if _config_fingerprint(_config) != _config_token:
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
                        _state['speaking'] = False
                        _state['barge_in'] = False
                        _config['realtimeSessionActive'] = False
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
                    # TTS / greeting playback counts as summon activity.
                    if _state.get('last_wake_at'):
                        _state['last_wake_at'] = time.time()
                else:
                    if _state['mode'] == 'speaking':
                        _state['mode'] = 'active' if _state.get('last_wake_at') else 'sleep'
                _json(self, 200, {'ok': True, 'state': dict(_state)})
            if not body.get('speaking'):
                _block_wake_for(WAKE_BLOCK_AFTER_SPEAKING_SEC)
                with _detector_lock:
                    if _frame_detector:
                        _frame_detector.reset()
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
