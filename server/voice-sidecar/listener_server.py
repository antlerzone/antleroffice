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
    wlog,
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
WAKE_MAX_SPEECH_MS_STT = 2600
WAKE_EMIT_MIN_INTERVAL = 3.0
WAKE_BLOCK_AFTER_SPEAKING_SEC = 3.0
# Ignore active-mode STT briefly after TTS ends — blocks speaker echo / room reverb.
ACTIVE_POST_SPEAK_GRACE_SEC = 3.0
MIN_WAKE_PEAK_RMS = 28.0
MIN_WHISPER_WAKE_UTTERANCE_RMS = 24.0
# STT wake needs a full phrase — short VAD blips often hallucinate ("you", "peace").
WAKE_MIN_SPEECH_MS_STT = 520
# Wait longer before deciding the user finished — lets "Hey ... Jarvis" with a
# small pause stay in one clip instead of being cut to just "Hey".
WAKE_END_SILENCE_MS_STT = 1100
ORPHAN_ACTIVE_GRACE_SEC = 2.5

# Common Whisper outputs on clips too short for wake STT.
_STT_NOISE_WORDS = frozenset({
    'a', 'i', 'uh', 'um', 'oh', 'ah', 'hm', 'hmm', 'mm', 'ok', 'okay',
    'you', 'the', 'he', 'she', 'we', 'so', 'no', 'yes', 'yeah', 'yea',
    'bye', 'buy', 'peace', 'and', 'it', 'is', 'to', 'of', 'in', 'on',
    'go', 'do', 'me', 'my', 'or', 'at', 'up', 'us', 'am', 'an', 'as',
})
# Tokens that may appear in real wake phrases (incl. common Whisper mis-hears).
_WAKE_CUE_WORDS = frozenset({
    'hey', 'hi', 'hay', 'hej', 'hello', 'hiya', 'heya', 'hallo',
    'jarvis', 'alice', 'service', 'travis', 'charice', 'charis', 'chargers',
    'jarvus', 'gervais', 'harvis', 'janice',
    '贾维斯', '加维斯', '杰维斯', '嘿', '你好',
})

_last_wake_emit_at = 0.0
_wake_block_until = 0.0
_last_speaking_end_at = 0.0

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
    'wakePhrases': [],
    'idleTimeoutSec': 300,
    'wakeEngine': 'openwakeword',
    'wakeRequireStt': False,
    'sensitivity': 0.5,
    'porcupineAccessKey': '',
    'clapWake': False,
    'clapWakeCount': 2,
    'inputDeviceIndex': None,
    'replyLanguage': 'auto',
    'realtimeSessionActive': False,
    'summonSessionEngaged': False,
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
        'wakeRequireStt',
        'wakePhrases',
        'sensitivity',
        'porcupineAccessKey',
        'porcupineKeywordPaths',
        'clapWake',
        'clapWakeCount',
    )
    return json.dumps({k: cfg.get(k) for k in keys}, sort_keys=True, ensure_ascii=False)


def _wake_requires_stt() -> bool:
    """When true, summon only fires after STT text matches a wake phrase."""
    engine = str(_config.get('wakeEngine') or '').lower()
    # Acoustic engines (openWakeWord / Porcupine) match by sound — never gate them
    # behind STT text matching, which mis-hears "Jarvis" as guys / Jason / Bryan.
    if engine in ('openwakeword', 'porcupine'):
        return False
    if bool(_config.get('wakeRequireStt', False)):
        return True
    return engine == 'whisper'


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
            if _wake_requires_stt():
                _frame_detector = None
                wake_backend = 'stt-match'
            elif engine == 'whisper':
                _frame_detector = None
                wake_backend = 'whisper'
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
        if bool(cfg.get('clapWake')) and not _wake_requires_stt():
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
        wlog(
            f'=== REBUILD wake_backend={wake_backend} requires_stt={_wake_requires_stt()} '
            f'engine={engine} wake_error={wake_error} phrases={phrases} ==='
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


def _wake_stt_lang_order() -> list[str | None]:
    """Wake STT languages — explicit wakeSttLanguage overrides phrase-script inference."""
    explicit = str(_config.get('wakeSttLanguage') or 'auto').strip().lower()
    if explicit in ('zh', 'en', 'ko', 'ja'):
        return [explicit]

    phrases = list(_config.get('wakePhrases') or [])
    norms = [_normalize_phrase(p) for p in phrases if _normalize_phrase(p)]
    order: list[str] = []
    seen: set[str] = set()

    def add(lang: str) -> None:
        if lang not in seen:
            seen.add(lang)
            order.append(lang)

    for norm in norms:
        if re.search(r'[\u4e00-\u9fff]', norm):
            add('zh')
        if re.search(r'[\uac00-\ud7af]', norm):
            add('ko')
        if re.search(r'[\u3040-\u30ff]', norm):
            add('ja')
        if norm and re.search(r'[a-z]', norm) and not re.search(
            r'[\u4e00-\u9fff\uac00-\ud7af\u3040-\u30ff]', norm
        ):
            add('en')

    if not order:
        order.append('en')
    return order


def _wake_stt_language() -> str | None:
    order = _wake_stt_lang_order()
    return order[0] if order else None


# ── 本地 wake 转写（faster-whisper，CPU，免费、不上云）——summon 不烧 token ──
_LOCAL_WAKE_WHISPER = os.environ.get('VOICE_WAKE_LOCAL', '1') != '0'
_LOCAL_WHISPER_MODEL = os.environ.get('VOICE_WAKE_WHISPER_MODEL', 'base')
_local_whisper = None


def _get_local_whisper():
    global _local_whisper
    if _local_whisper is None:
        from faster_whisper import WhisperModel
        print(f'[wake/stt] loading local whisper model={_LOCAL_WHISPER_MODEL} (cpu, int8)…', flush=True)
        _local_whisper = WhisperModel(_LOCAL_WHISPER_MODEL, device='cpu', compute_type='int8')
        print('[wake/stt] local whisper ready', flush=True)
    return _local_whisper


def _transcribe_local_whisper(wav_bytes: bytes, language: str | None) -> str:
    import io as _io
    model = _get_local_whisper()
    segments, _info = model.transcribe(
        _io.BytesIO(wav_bytes),
        language=language or None,
        beam_size=1,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    return ' '.join(s.text for s in segments).strip()


# ── 本地 SenseVoice（sherpa-onnx，CPU，比 Whisper 快很多、中文更准）──
_WAKE_ASR = os.environ.get('VOICE_WAKE_ASR', 'sensevoice').lower()  # sensevoice | whisper
_sensevoice = None
_sensevoice_failed = False
_SENSEVOICE_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'


def _ensure_sensevoice_model():
    """确保 SenseVoice 模型已下载，返回 (model.int8.onnx, tokens.txt)。首次约 230MB。"""
    d = os.path.join(os.path.expanduser('~'), '.antleroffice2', 'voice-runtime', 'sensevoice')
    sub = os.path.join(d, _SENSEVOICE_NAME)
    model = os.path.join(sub, 'model.int8.onnx')
    tokens = os.path.join(sub, 'tokens.txt')
    if os.path.exists(model) and os.path.exists(tokens):
        return model, tokens
    os.makedirs(d, exist_ok=True)
    url = f'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{_SENSEVOICE_NAME}.tar.bz2'
    tar_path = os.path.join(d, 'sensevoice.tar.bz2')
    print('[wake/stt] 下载 SenseVoice 模型（首次，约 230MB）…', flush=True)
    urlrequest.urlretrieve(url, tar_path)
    import tarfile
    with tarfile.open(tar_path, 'r:bz2') as tf:
        tf.extractall(d)
    try:
        os.remove(tar_path)
    except Exception:
        pass
    print('[wake/stt] SenseVoice 模型就绪', flush=True)
    return model, tokens


def _get_sensevoice():
    global _sensevoice
    if _sensevoice is None:
        import sherpa_onnx
        model, tokens = _ensure_sensevoice_model()
        print('[wake/stt] loading SenseVoice (sherpa-onnx, cpu)…', flush=True)
        _sensevoice = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model, tokens=tokens, num_threads=2, use_itn=True, debug=False,
        )
        print('[wake/stt] SenseVoice ready', flush=True)
    return _sensevoice


def _wav_to_float32(wav_bytes: bytes):
    import io as _io
    import wave as _wave
    import numpy as _np
    with _wave.open(_io.BytesIO(wav_bytes), 'rb') as wf:
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    samples = _np.frombuffer(raw, dtype=_np.int16).astype(_np.float32) / 32768.0
    return samples, sr


def _transcribe_sensevoice(wav_bytes: bytes) -> str:
    rec = _get_sensevoice()
    samples, sr = _wav_to_float32(wav_bytes)
    s = rec.create_stream()
    s.accept_waveform(sr, samples)
    rec.decode_stream(s)
    return (s.result.text or '').strip()


def _transcribe_for_wake(wav_bytes: bytes, language: str | None) -> str:
    """唤醒匹配的本地转写：优先 SenseVoice（快），失败退回 whisper，绝不上云、不烧 token。"""
    global _sensevoice_failed
    # 只在 SenseVoice 已经预热好（_sensevoice 非 None）时才用，避免在 mic 线程里触发下载/加载卡住；
    # 预热未完成时先用 whisper 顶着（whisper 模型上次已缓存）。
    if _WAKE_ASR == 'sensevoice' and not _sensevoice_failed and _sensevoice is not None:
        try:
            return _transcribe_sensevoice(wav_bytes)
        except Exception as exc:
            _sensevoice_failed = True
            print(f'[wake/stt] SenseVoice 失败，本次起退回 whisper: {exc}', flush=True)
    if _LOCAL_WAKE_WHISPER:
        try:
            return _transcribe_local_whisper(wav_bytes, language)
        except Exception as exc:
            print(f'[wake/stt] local whisper failed: {exc}', flush=True)
    return ''


def _transcribe_wav_with_language(
    wav_bytes: bytes,
    language: str | None,
    *,
    for_wake: bool = False,
    prompt: str | None = None,
    stt_model: str | None = None,
) -> str:
    # 唤醒匹配只用本地 ASR（SenseVoice 优先，失败退回 whisper），绝不走云端、不烧 token。
    if for_wake:
        return _transcribe_for_wake(wav_bytes, language)
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
    hint = str(prompt or '').strip()
    if not hint and wake_phrases:
        if for_wake:
            # Bias wake STT toward the configured wake phrases so quiet / far-field
            # clips transcribe as the phrase instead of hallucinating "you" / "hey".
            hint = ' '.join(f'{p}.' for p in wake_phrases[:3])
        else:
            hint = 'Hey Jarvis. Hi Jarvis.'
    if hint:
        parts.extend(
            [
                f'--{boundary}\r\n'.encode(),
                b'Content-Disposition: form-data; name="prompt"\r\n\r\n',
                hint.encode('utf-8'),
                b'\r\n',
            ]
        )
    model = str(stt_model or '').strip()
    if model:
        parts.extend(
            [
                f'--{boundary}\r\n'.encode(),
                b'Content-Disposition: form-data; name="openaiSttModel"\r\n\r\n',
                model.encode('utf-8'),
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


def _transcribe_via_server(wav_bytes: bytes, *, for_wake: bool = False) -> str:
    return _transcribe_wav_with_language(wav_bytes, _wake_stt_language(), for_wake=for_wake)


def _is_stt_hint_echo(text: str) -> bool:
    """Reject legacy prompt-shaped hallucinations (user did not say both phrases)."""
    norm = _normalize_phrase(text)
    if not norm:
        return True
    return norm in ('hey jarvis hi jarvis', 'hey jarvis hi jarvis hey jarvis')


def _is_stt_noise_hallucination(text: str) -> bool:
    """Reject single-syllable / filler STT on wake clips that are too short to trust."""
    norm = _normalize_phrase(text)
    if not norm:
        return True
    if _is_stt_repeat_hallucination(norm):
        return True
    if len(norm) <= 2:
        return True
    words = norm.split()
    if len(words) == 1 and norm in _STT_NOISE_WORDS:
        return True
    if len(words) == 1 and len(norm) <= 4 and not re.search(r'[\u4e00-\u9fff\uac00-\ud7af\u3040-\u30ff]', norm):
        return True
    return False


def _is_stt_repeat_hallucination(norm: str) -> bool:
    """Whisper on long/noisy clips often repeats nonsense ('changebytes...', 'hello hello')."""
    parts = [w.strip('.,!?') for w in norm.split() if w.strip('.,!?')]
    if len(parts) < 2:
        return False
    counts: dict[str, int] = {}
    for part in parts:
        counts[part] = counts.get(part, 0) + 1
        if counts[part] >= 3:
            return True
    filler = frozenset({'hello', 'hi', 'hey', 'thanks', 'bye', 'ok', 'yeah', 'yes', 'no'})
    for word, count in counts.items():
        if count >= 2 and word in filler:
            return True
    if len(parts) >= 2 and len(set(parts)) == 1 and len(parts[0]) <= 10:
        return True
    return False


def _has_wake_cue(norm: str) -> bool:
    for word in norm.split()[:4]:
        w = word.strip('.,!?')
        if not w:
            continue
        if w in _WAKE_CUE_WORDS:
            return True
        if 'jarv' in w or 'alic' in w or 'charic' in w or 'travis' in w:
            return True
        if re.search(r'[\u4e00-\u9fff]', w):
            return True
    return False


def _is_wake_stt_gibberish(text: str, whisper: Any | None = None) -> bool:
    """Long / conversational STT on a wake clip — almost always room noise or TV, not a wake phrase."""
    if whisper and whisper.matches(text):
        return False
    norm = _normalize_phrase(text)
    if not norm:
        return True
    words = norm.split()
    if len(words) > 5:
        return True
    if len(words) >= 3 and not _has_wake_cue(norm):
        return True
    return False


def _should_discard_active_transcript(text: str) -> bool:
    """Drop filler / echo STT before publishing voice commands."""
    norm = _normalize_phrase(text)
    if not norm:
        return True
    if _is_stt_hint_echo(text) or _is_stt_noise_hallucination(text):
        return True
    if _is_stt_repeat_hallucination(norm):
        return True
    if _is_wake_stt_gibberish(text):
        return True
    return False


def _wake_phrase_prompt() -> str | None:
    phrases = [str(p).strip() for p in (_config.get('wakePhrases') or []) if str(p).strip()]
    return phrases[0] if phrases else None


def _should_discard_wake_transcript(text: str, whisper: Any) -> bool:
    """Drop filler STT — but keep anything that already matches a wake phrase (incl. fuzzy)."""
    if whisper and whisper.matches(text):
        return False
    if _is_stt_hint_echo(text):
        return True
    if _is_stt_noise_hallucination(text):
        return True
    if _is_wake_stt_gibberish(text, whisper):
        return True
    return False


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


def _emit_wake(detected_phrase: str | None = None, *, transcript: str | None = None) -> None:
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
    if _peak_rms < MIN_WAKE_PEAK_RMS and detected_phrase not in (None, 'clap'):
        print(
            f'[summon] wake suppressed — mic too quiet peak_rms={_peak_rms:.0f} '
            f'(need {MIN_WAKE_PEAK_RMS:.0f}) phrase={detected_phrase!r}',
            flush=True,
        )
        return
    print(
        f'[summon] wake detected phrase={detected_phrase!r} '
        f'transcript={transcript!r} peak_rms={_peak_rms:.0f}',
        flush=True,
    )
    payload: dict[str, Any] = {'type': 'wake', 'mode': 'active', 'source': 'stt' if transcript else 'frame'}
    if detected_phrase:
        payload['phrase'] = detected_phrase
    if transcript:
        payload['transcript'] = transcript
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
    if _should_discard_active_transcript(text):
        print(f'[listener] transcript skipped (stt noise): "{text}"', flush=True)
        return
    cleaned = _strip_all_wake_phrases(text)
    if not cleaned or _is_wake_only_text(text):
        print(f'[listener] transcript skipped (wake-only): "{text}"', flush=True)
        return
    if _should_discard_active_transcript(cleaned):
        print(f'[listener] transcript skipped (stt noise after strip): "{text}"', flush=True)
        return
    with _state_lock:
        mode = _state.get('mode', 'sleep')
        _state['last_command_at'] = time.time()
    _post_callback({'type': 'transcript', 'text': cleaned, 'raw': text, 'mode': mode})


def _client_session_engaged() -> bool:
    return bool(_config.get('summonSessionEngaged'))


def _browser_realtime_owns_mic() -> bool:
    return bool(_config.get('realtimeSessionActive'))


def _reset_orphan_active(reason: str) -> None:
    print(f'[listener] orphan active reset — {reason}', flush=True)
    with _state_lock:
        _state['mode'] = 'sleep'
        _state['last_wake_at'] = None
        _state['speaking'] = False
        _state['barge_in'] = False
    with _detector_lock:
        if _frame_detector:
            _frame_detector.reset()


def _maybe_reset_orphan_active(mode: str) -> str:
    """Listener active without browser summon ack — revert to sleep for STT wake."""
    if mode not in ('active', 'speaking'):
        return mode
    if _client_session_engaged():
        return mode
    with _state_lock:
        lw = float(_state.get('last_wake_at') or 0)
    if lw <= 0 or (time.time() - lw) <= ORPHAN_ACTIVE_GRACE_SEC:
        return mode
    _reset_orphan_active('no client session after wake grace')
    return 'sleep'


def _maybe_rebuild_detectors() -> None:
    token = _config_fingerprint(_config)
    if token != _config_token:
        _rebuild_detectors()


def _process_sleep_wake_frame(pcm: bytes) -> bool:
    """Run frame-based wake detectors. Returns True if wake fired."""
    if _wake_requires_stt():
        return False
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


def _process_sleep_whisper_utterance(utterance: bytes, speech_ms: int = 0) -> bool:
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
    if speech_ms > 0 and speech_ms < WAKE_MIN_SPEECH_MS_STT:
        print(
            f'[wake/whisper] SKIP — utterance too short {speech_ms}ms '
            f'(need {WAKE_MIN_SPEECH_MS_STT}ms for STT wake)',
            flush=True,
        )
        _post_callback({
            'type': 'wake_miss',
            'reason': 'utterance_too_short',
            'speechMs': speech_ms,
            'peakRms': round(_peak_rms),
            'utteranceRms': round(wav_rms),
        })
        return False

    if wav_rms < MIN_WHISPER_WAKE_UTTERANCE_RMS:
        print(
            f'[wake/whisper] SKIP — utterance too quiet rms={wav_rms:.0f} '
            f'(need {MIN_WHISPER_WAKE_UTTERANCE_RMS:.0f})',
            flush=True,
        )
        _post_callback({
            'type': 'wake_miss',
            'reason': 'quiet_utterance',
            'speechMs': speech_ms,
            'peakRms': round(_peak_rms),
            'utteranceRms': round(wav_rms),
        })
        return False
    print(
        f'[wake/whisper] wav rms in={wav_rms:.0f} normalized={stt_rms:.0f} peak={_peak_rms:.0f}',
        flush=True,
    )
    lang_order = _wake_stt_lang_order()
    print(
        f'[wake/whisper] stt lang order={lang_order} wakeSttLanguage={_config.get("wakeSttLanguage")!r} '
        f'phrases={_config.get("wakePhrases")!r} replyLanguage={_config.get("replyLanguage")!r} (reply only)',
        flush=True,
    )

    transcripts: list[tuple[str, str]] = []
    seen: set[str] = set()
    raw_candidates: list[tuple[str, str]] = []
    last_raw = ''
    wake_prompt = _wake_phrase_prompt()

    def _ingest_wake_transcript(text: str, tag: str) -> bool:
        nonlocal last_raw
        if not text:
            return False
        last_raw = text
        key = _normalize_phrase(text)
        if key and key not in seen:
            seen.add(key)
            raw_candidates.append((text, tag))
        # 先看是否命中唤醒词——命中就别当噪音丢（whisper 在短句上常把词重复，如“邓紫棋邓紫棋”，仍含唤醒词）
        if whisper.matches(text):
            transcripts.append((text, tag))
            print(f'[wake/whisper] MATCH ({tag}): "{text}"', flush=True)
            return True
        if _should_discard_wake_transcript(text, whisper):
            print(f'[wake/whisper] SKIP discarded transcript="{text}" ({tag})', flush=True)
            return False
        transcripts.append((text, tag))
        print(f'[wake/whisper] accepted ({tag}): "{text}"', flush=True)
        return False

    for lang in lang_order:
        try:
            text = _transcribe_wav_with_language(wav, lang, for_wake=True)
        except Exception as exc:
            print(f'[wake/whisper] transcribe ({lang or "auto"}/primary) failed: {exc}', flush=True)
            continue
        if _ingest_wake_transcript(text, f'{lang or "auto"}:primary'):
            break

    # whisper-1 + prompt only when primary returned nothing useful (prompt on noise causes TV-style gibberish).
    primary_empty = not raw_candidates
    if not transcripts and primary_empty:
        for lang in lang_order:
            try:
                text = _transcribe_wav_with_language(
                    wav,
                    lang,
                    for_wake=True,
                    prompt=wake_prompt,
                    stt_model='whisper-1',
                )
            except Exception as exc:
                print(f'[wake/whisper] transcribe ({lang or "auto"}/whisper-1) failed: {exc}', flush=True)
                continue
            if _ingest_wake_transcript(text, f'{lang or "auto"}:whisper-1'):
                break

    if not transcripts:
        for text, tag in reversed(raw_candidates):
            if whisper.matches(text):
                print(f'[wake/whisper] fuzzy accept from raw: "{text}"', flush=True)
                transcripts.append((text, tag))
                break

    # Wake STT must use language-tagged OpenAI only — TypeWhisper auto-detect mis-hears (e.g. Japanese).
    if not transcripts:
        print(f'[wake/whisper] no valid transcript after language-tagged STT last_raw="{last_raw}"', flush=True)
        _post_callback({
            'type': 'wake_miss',
            'reason': 'stt_noise',
            'lastTranscript': last_raw,
            'speechMs': speech_ms,
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
        _emit_wake(matched, transcript=text)
        # Do not chain wake utterance into a voice command — user speaks again after greeting.
        return True
    if transcripts:
        heard = transcripts[0][0]
        heard_lang = transcripts[0][1]
        if _is_wake_stt_gibberish(heard, whisper):
            print(f'[wake/whisper] gibberish transcript discarded="{heard}"', flush=True)
            _post_callback({
                'type': 'wake_miss',
                'reason': 'stt_noise',
                'lastTranscript': heard,
                'speechMs': speech_ms,
                'peakRms': round(_peak_rms),
                'utteranceRms': round(wav_rms),
            })
            return False
        print(f'[wake/whisper] no phrase match for transcript="{heard}"', flush=True)
        _post_callback({
            'type': 'wake_miss',
            'reason': 'no_phrase_match',
            'transcript': heard,
            'sttLang': heard_lang,
            'speechMs': speech_ms,
            'peakRms': round(_peak_rms),
            'utteranceRms': round(wav_rms),
        })
    return False


def _process_active_utterance(utterance: bytes, speech_ms: int = 0) -> None:
    if _last_speaking_end_at > 0 and (time.time() - _last_speaking_end_at) < ACTIVE_POST_SPEAK_GRACE_SEC:
        print(
            f'[wake/active] utterance skipped — post-TTS grace '
            f'({time.time() - _last_speaking_end_at:.1f}s < {ACTIVE_POST_SPEAK_GRACE_SEC}s)',
            flush=True,
        )
        return
    wav_pcm = _normalize_utterance_for_stt(utterance)
    wav_rms = _rms(utterance)
    if wav_rms < MIN_WHISPER_WAKE_UTTERANCE_RMS:
        print(f'[wake/active] utterance skipped — too quiet rms={wav_rms:.0f}', flush=True)
        return
    wav = _pcm_to_wav(wav_pcm)
    text = ''
    for lang in _wake_stt_lang_order():
        try:
            text = _transcribe_wav_with_language(wav, lang, for_wake=False)
            if _normalize_phrase(text):
                break
        except Exception as exc:
            print(f'[wake/active] transcribe ({lang or "auto"}) failed: {exc}', flush=True)
    if not text:
        try:
            text = _transcribe_wav(wav)
        except Exception as exc:
            print(f'[listener] transcribe failed: {exc}', flush=True)
            return
    if not text or _should_discard_active_transcript(text):
        print(f'[wake/active] transcript discarded: "{text}" speech_ms={speech_ms}', flush=True)
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
    stt_wake = _wake_requires_stt()
    if stt_wake:
        min_speech_ms = WAKE_MIN_SPEECH_MS_STT
        end_silence_ms = WAKE_END_SILENCE_MS_STT

    speech_frames: list[bytes] = []
    in_speech = False
    silence_ms = 0
    pre_roll: list[bytes] = []
    speech_ms = 0
    last_active = time.time()
    oww_accum = bytearray()
    _debug_clap_log_at = time.time()
    threshold = _vad_threshold(float(_config.get('sensitivity') or 0.5))
    # Persistent continuous input stream. openWakeWord needs a SMOOTH, gapless
    # audio stream — opening/closing sd.rec() every frame drops audio between
    # reads and the acoustic model scores a flat 0. Keep one stream open.
    _mic_stream: Any = None

    def _close_mic_stream() -> None:
        nonlocal _mic_stream
        if _mic_stream is not None:
            try:
                _mic_stream.stop()
                _mic_stream.close()
            except Exception:
                pass
            _mic_stream = None

    print(f'[listener] mic loop started vad_threshold={threshold:.0f} mic_gain={MIC_GAIN}x', flush=True)
    try:
        _din = sd.query_devices(kind='input')
        wlog(
            f'>>> MIC LOOP START build=stream-v4 oww_input=RAW capture=CONTINUOUS '
            f'input_name={_din.get("name")!r} device_default_samplerate={_din.get("default_samplerate")} '
            f'capture_samplerate={SAMPLE_RATE} mic_gain={MIC_GAIN}'
        )
    except Exception as _e:
        wlog(f'>>> MIC LOOP START build=raw-audio-v3 oww_input=RAW (device query failed: {_e!r}) capture_samplerate={SAMPLE_RATE}')

    while not _stop_event.is_set():
        _maybe_rebuild_detectors()

        with _state_lock:
            enabled = bool(_config.get('globalListenEnabled', True))
            speaking = bool(_state.get('speaking'))
            barge_in = bool(_state.get('barge_in'))
            mode = str(_state.get('mode') or 'sleep')
            idle_timeout = int(_config.get('idleTimeoutSec') or 300)

        mode = _maybe_reset_orphan_active(mode)

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
                    _close_mic_stream()

        if not enabled:
            time.sleep(0.1)
            continue

        desired_device = _resolve_input_device(sd)
        if desired_device is not None and desired_device != _input_device:
            _input_device = desired_device
            _close_mic_stream()  # reopen the continuous stream on the new device
            print(f'[listener] input device changed → #{_input_device}', flush=True)
            try:
                _di = sd.query_devices(_input_device)
                wlog(
                    f'INPUT DEVICE #{_input_device} name={_di.get("name")!r} '
                    f'default_samplerate={_di.get("default_samplerate")} '
                    f'(we capture at {SAMPLE_RATE})'
                )
            except Exception as _exc:
                wlog(f'INPUT DEVICE #{_input_device} query failed: {_exc!r}')

        try:
            if _mic_stream is None:
                _mic_stream = sd.InputStream(
                    samplerate=SAMPLE_RATE,
                    channels=1,
                    dtype='int16',
                    blocksize=FRAME_SAMPLES,
                    device=_input_device,
                )
                _mic_stream.start()
                wlog(
                    f'CONTINUOUS STREAM opened device={_input_device} '
                    f'rate={SAMPLE_RATE} block={FRAME_SAMPLES}'
                )
            data, _overflowed = _mic_stream.read(FRAME_SAMPLES)
            raw_frame = data.tobytes()
            pcm, raw_level, level = _process_frame_pcm(raw_frame)
            _raw_rms = raw_level
        except Exception as exc:
            print(f'[listener] mic read failed: {exc}', flush=True)
            _close_mic_stream()
            time.sleep(0.3)
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

        if (
            mode == 'sleep'
            and not bool(_config.get('realtimeSessionActive'))
            and not _wake_requires_stt()
        ):
            # openWakeWord expects natural, un-normalized 16 kHz PCM. Feed the RAW
            # frame (not the gain-boosted one) — boosting/normalizing makes the
            # acoustic model score a constant 0.000.
            oww_accum.extend(raw_frame)
            while len(oww_accum) >= OWW_CHUNK_SAMPLES * 2:
                chunk = bytes(oww_accum[: OWW_CHUNK_SAMPLES * 2])
                del oww_accum[: OWW_CHUNK_SAMPLES * 2]
                if _process_sleep_wake_frame(chunk):
                    in_speech = False
                    speech_frames = []
                    pre_roll = []
                    oww_accum.clear()
                    break
            if len(oww_accum) > OWW_CHUNK_SAMPLES * 16:
                oww_accum = oww_accum[-OWW_CHUNK_SAMPLES * 8 :]

        # Clap-wake only in sleep while browser realtime is not handling the session.
        if (
            mode == 'sleep'
            and not bool(_config.get('realtimeSessionActive'))
            and not _wake_requires_stt()
        ):
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
            and speech_ms >= (WAKE_MAX_SPEECH_MS_STT if _wake_requires_stt() else WAKE_MAX_SPEECH_MS)
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
        stt_wake = _wake_requires_stt()
        if stt_wake:
            min_ms = WAKE_MIN_SPEECH_MS_STT
        elif quiet_mic:
            min_ms = 280
        else:
            min_ms = min_speech_ms
        captured_speech_ms = speech_ms
        if speech_ms < min_ms:
            print(f'[wake/vad] utterance too short ({speech_ms}ms < {min_ms}ms), ignored', flush=True)
            speech_ms = 0
            continue
        speech_ms = 0

        print(
            f'[wake/vad] utterance captured mode={mode} len={len(utterance)} bytes '
            f'speech_ms={captured_speech_ms}',
            flush=True,
        )

        if mode == 'sleep' and not bool(_config.get('realtimeSessionActive')):
            # 用本地 whisper 处理唤醒句：engine==whisper，或有中文/自定义词触发了 whisper 回退。
            if _wake_requires_stt() or _use_whisper_fallback:
                _process_sleep_whisper_utterance(utterance, captured_speech_ms)
            continue

        if mode == 'active':
            if not _client_session_engaged():
                print('[wake/vad] active utterance skipped — no client summon session', flush=True)
                continue
            if _browser_realtime_owns_mic():
                print('[wake/vad] active utterance skipped — browser realtime owns mic', flush=True)
                continue
            last_active = time.time()
            _process_active_utterance(utterance, captured_speech_ms)


_sensevoice_warmed = False


def _warmup_sensevoice() -> None:
    """后台预热 SenseVoice（首次下载 230MB + 加载），这样第一次喊唤醒词不会被卡住。"""
    global _sensevoice_warmed
    if _sensevoice_warmed or _WAKE_ASR != 'sensevoice':
        return
    _sensevoice_warmed = True

    def _run():
        try:
            _get_sensevoice()
        except Exception as exc:
            print(f'[wake/stt] SenseVoice 预热失败（将退回 whisper）: {exc}', flush=True)

    threading.Thread(target=_run, name='sensevoice-warmup', daemon=True).start()


def _ensure_mic_thread() -> None:
    global _mic_thread
    if _mic_thread and _mic_thread.is_alive():
        return
    _stop_event.clear()
    _mic_thread = threading.Thread(target=_mic_loop, name='voice-listener-mic', daemon=True)
    _mic_thread.start()
    _warmup_sensevoice()  # 后台把 SenseVoice 下好/加载好，喊词时就绪


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f'[listener] {self.address_string()} {fmt % args}', flush=True)

    def do_GET(self) -> None:
        path = self.path.split('?')[0]
        if path == '/health':
            with _state_lock:
                state_copy = dict(_state)
            with _detector_lock:
        