"""Wake word engines for AntlerOffice listener sidecar."""

from __future__ import annotations

import os
import re
import time
from abc import ABC, abstractmethod
from typing import Any

import numpy as np

# Lightweight debug log written into the repo so it can be inspected directly.
WAKE_DEBUG_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wake-debug.log')


def wlog(msg: str) -> None:
    """Append a timestamped line to wake-debug.log (best effort, never raises)."""
    try:
        with open(WAKE_DEBUG_LOG, 'a', encoding='utf-8') as f:
            f.write(f'{time.strftime("%H:%M:%S")} {msg}\n')
    except Exception:
        pass


# ── 中文拼音模糊匹配：whisper 常把中文唤醒词转成同音别字（邓紫棋→彈子齊），按发音比对 ──
from difflib import SequenceMatcher  # noqa: E402

try:
    from pypinyin import lazy_pinyin as _lazy_pinyin  # type: ignore
except Exception:
    _lazy_pinyin = None


def _pinyin_syls(text: str) -> list[str]:
    if not _lazy_pinyin:
        return []
    try:
        return [s for s in _lazy_pinyin(text) if s and s.strip()]
    except Exception:
        return []


def _syl_close(a: str, b: str) -> bool:
    if a == b:
        return True
    return SequenceMatcher(None, a, b).ratio() >= 0.6


def pinyin_fuzzy_match(wake_text: str, trans_text: str) -> bool:
    """发音够近就算命中：逐音节比对，≥60% 音节相近即匹配（支持转写里有多余字）。"""
    w = _pinyin_syls(wake_text)
    t = _pinyin_syls(trans_text)
    n = len(w)
    if n == 0 or not t:
        return False
    if len(t) < n:
        m = sum(1 for a, b in zip(w, t) if _syl_close(a, b))
        return (m / n) >= 0.6
    best = 0.0
    for i in range(0, len(t) - n + 1):
        window = t[i:i + n]
        m = sum(1 for a, b in zip(w, window) if _syl_close(a, b))
        best = max(best, m / n)
    return best >= 0.6

# Built-in phrase → openWakeWord model names (English models only).
OPENWAKEWORD_PHRASE_MODELS: dict[str, str] = {
    'hey jarvis': 'hey_jarvis',
    'hi jarvis': 'hey_jarvis',
    'jarvis': 'hey_jarvis',
    'hey antler': 'hey_mycroft',
    'hi antler': 'hey_mycroft',
}

# Chinese phrases → same hey_jarvis model (Whisper text match is primary for zh).
OPENWAKEWORD_ZH_ALIASES: dict[str, str] = {
    '贾维斯': 'hey_jarvis',
    '嘿贾维斯': 'hey_jarvis',
    '你好贾维斯': 'hey_jarvis',
}

# Built-in phrase → Porcupine keyword names (see pvporcupine.KEYWORDS).
PORCUPINE_PHRASE_KEYWORDS: dict[str, str] = {
    'hey jarvis': 'jarvis',
    'hey antler': 'computer',
}

OWW_CHUNK_SAMPLES = 1280

# Whisper often mis-hears "Jarvis" — accept close greetings when phrases include Jarvis.
_JARVIS_GREETING_PREFIXES = frozenset({
    'hey', 'hi', 'hay', 'hei', 'hej', 'hello', 'hallo', 'hiya', 'heya',
})
_JARVIS_SOUNDALIKES = frozenset({
    'jarvis', 'alice', 'service', 'travis', 'chargers', 'charvis', 'jarvus',
    'gervais', 'harvis', 'janice', 'harris', 'jarvish', 'jarves', 'jarvas',
    'jarvice', 'garvis', 'carvis', 'marvis', 'charice', 'charis', 'cherise',
    'cherish', 'charice', 'chalice', 'jarvis', 'jervis', 'jarvies',
    # Common Whisper mis-hears of "Jarvis" on quiet / accented speech.
    'guys', 'jason', 'jarvais', 'jaris', 'javis', 'jayvis', 'jervais',
    'jarviss', 'darvis', 'jarvi', 'jarv',
})


def _oww_model_file(stem: str) -> str:
    """Prefer ONNX on Windows when tflite_runtime is missing."""
    try:
        import openwakeword
        from pathlib import Path

        models_dir = Path(openwakeword.__file__).resolve().parent / 'resources' / 'models'
        onnx_path = models_dir / f'{stem}.onnx'
        tflite_path = models_dir / f'{stem}.tflite'
        try:
            import tflite_runtime  # type: ignore # noqa: F401

            if tflite_path.exists():
                return str(tflite_path)
        except ImportError:
            pass
        if onnx_path.exists():
            return str(onnx_path)
        if tflite_path.exists():
            return str(tflite_path)
    except Exception as exc:
        print(f'[listener/oww] model path resolve failed: {exc}', flush=True)
    return stem


class ClapDetector:
    """Detects a repeated-clap pattern (default: double-clap) as a wake gesture.

    A clap appears as a brief high-RMS spike.  When N spikes are detected within
    *window_sec* seconds the detector fires and resets.

    Args:
        threshold: RMS amplitude level that counts as a clap (default 2500).
                   Typical quiet room speech ≈ 200-600; a sharp clap ≈ 2000-8000.
        count:     Number of claps required (default 2 = double-clap).
        window_sec: Time window in which all claps must occur (default 2.0 s).
        min_gap_ms: Minimum milliseconds between two clap onsets (default 150 ms)
                    to avoid counting a single long clap as multiple events.
    """

    def __init__(
        self,
        threshold: float = 800.0,
        count: int = 2,
        window_sec: float = 2.0,
        min_gap_ms: float = 150.0,
    ) -> None:
        self._threshold = threshold
        self._count = max(1, int(count))
        self._window = window_sec
        self._min_gap = min_gap_ms / 1000.0
        self._clap_times: list[float] = []
        self._in_spike = False
        self._quiet_frames = 0

    def process_frame(self, rms: float) -> bool:
        """Feed RMS of one audio frame.  Returns True when the clap pattern fires."""
        now = time.time()
        # Remove timestamps outside the rolling window.
        self._clap_times = [t for t in self._clap_times if now - t < self._window]

        # DEBUG: log every loud frame so we can calibrate the threshold
        if rms >= self._threshold * 0.3:
            print(f'[clap/debug] rms={rms:.0f} threshold={self._threshold:.0f} in_spike={self._in_spike} claps_so_far={len(self._clap_times)}', flush=True)

        if rms >= self._threshold:
            if not self._in_spike:
                self._in_spike = True
                self._quiet_frames = 0
                # Only register if enough time has passed since the last clap.
                last = self._clap_times[-1] if self._clap_times else 0.0
                if now - last >= self._min_gap:
                    self._clap_times.append(now)
                    print(f'[clap/debug] CLAP #{len(self._clap_times)} registered (need {self._count})', flush=True)
                    if len(self._clap_times) >= self._count:
                        self._clap_times.clear()
                        self._in_spike = False
                        print('[clap/debug] *** WAKE TRIGGERED ***', flush=True)
                        return True
        else:
            if self._in_spike:
                self._quiet_frames += 1
                if self._quiet_frames >= 2:   # ~60 ms of quiet ends the spike
                    self._in_spike = False
                    self._quiet_frames = 0

        return False

    def reset(self) -> None:
        self._clap_times.clear()
        self._in_spike = False
        self._quiet_frames = 0


def _normalize_phrase(text: str) -> str:
    """Lowercase, drop punctuation — matches Whisper transcripts like 'hi jarvis'."""
    t = str(text or '').strip().lower()
    t = re.sub(r'[^\w\s\u4e00-\u9fff]+', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def _sounds_like_jarvis(word: str) -> bool:
    w = str(word or '').strip('.,!?').lower()
    if len(w) < 4 or len(w) > 12:
        return False
    if 'jarv' in w or w.endswith('vis') or 'alic' in w:
        return True
    # Simple edit distance to "jarvis" (allow 2 edits for short names).
    target = 'jarvis'
    if abs(len(w) - len(target)) > 2:
        return False
    edits = 0
    i = j = 0
    while i < len(w) and j < len(target):
        if w[i] == target[j]:
            i += 1
            j += 1
        elif edits >= 2:
            return False
        elif len(w) - i > len(target) - j:
            edits += 1
            i += 1
        elif len(w) - i < len(target) - j:
            edits += 1
            j += 1
        else:
            edits += 1
            i += 1
            j += 1
    edits += (len(w) - i) + (len(target) - j)
    return edits <= 2


def _phrase_needs_whisper_fallback(phrases: list[str], engine: str) -> bool:
    """Chinese / unmapped phrases still need STT text matching in sleep mode."""
    for phrase in phrases or []:
        norm = _normalize_phrase(phrase)
        if not norm:
            continue
        if re.search(r'[\u4e00-\u9fff]', norm):
            return True
        if engine == 'openwakeword' and norm not in OPENWAKEWORD_PHRASE_MODELS:
            return True
        if engine == 'porcupine' and norm not in PORCUPINE_PHRASE_KEYWORDS:
            return True
    return False


class FrameWakeDetector(ABC):
    engine_name: str = 'none'

    @abstractmethod
    def reset(self) -> None:
        ...

    @abstractmethod
    def process_frame(self, pcm: bytes) -> str | None:
        """Return matched wake phrase label when detected."""
        ...


class OpenWakeWordDetector(FrameWakeDetector):
    engine_name = 'openwakeword'

    def __init__(self, phrases: list[str], sensitivity: float = 0.5) -> None:
        from openwakeword.model import Model

        try:
            import openwakeword

            openwakeword.utils.download_models()
        except Exception as exc:
            print(f'[listener/oww] model download skipped: {exc}', flush=True)

        models: list[str] = []
        self._phrase_by_model: dict[str, str] = {}
        for phrase in phrases or []:
            norm = _normalize_phrase(phrase)
            model = OPENWAKEWORD_PHRASE_MODELS.get(norm) or OPENWAKEWORD_ZH_ALIASES.get(norm)
            if model and model not in self._phrase_by_model:
                self._phrase_by_model[model] = phrase
                models.append(_oww_model_file(f'{model}_v0.1'))

        if not models:
            raise RuntimeError('No openWakeWord-compatible wake phrases selected')

        # Higher user sensitivity => lower score threshold (more eager wake).
        s = max(0.1, min(1.0, float(sensitivity or 0.5)))
        self._threshold = max(0.06, min(0.38, 0.54 - s * 0.50))
        self._model = Model(wakeword_models=models)
        self._models = models
        self._cooldown_until = 0.0
        self._debug_at = 0.0
        self._peak_rms = 0.0
        self._near_miss = 0
        print(f'[listener/oww] models={models} threshold={self._threshold}', flush=True)
        wlog(f'oww MODEL LOADED models={models} threshold={self._threshold:.3f}')

    def set_quiet_context(self, peak_rms: float) -> None:
        """Mic loop passes recent peak RMS so quiet USB mics can use a lower score gate."""
        self._peak_rms = float(peak_rms or 0)

    def _effective_threshold(self) -> float:
        base = min(self._threshold, 0.036)
        if self._peak_rms < 50:
            return min(base, 0.030)
        if self._peak_rms > 100:
            return min(base, 0.034)
        return base

    def reset(self) -> None:
        self._cooldown_until = 0.0
        self._near_miss = 0

    def process_frame(self, pcm: bytes) -> str | None:
        if time.time() < self._cooldown_until:
            return None
        if len(pcm) < OWW_CHUNK_SAMPLES * 2:
            return None

        samples = np.frombuffer(pcm[: OWW_CHUNK_SAMPLES * 2], dtype=np.int16)
        try:
            scores = self._model.predict(samples)
        except Exception as exc:
            print(f'[listener/oww] predict failed: {exc}', flush=True)
            return None

        best_phrase: str | None = None
        best_score = 0.0
        for score_key, raw in (scores or {}).items():
            score = float(raw or 0)
            for model_key, phrase in self._phrase_by_model.items():
                if model_key not in str(score_key):
                    continue
                if score > best_score:
                    best_score = score
                    best_phrase = phrase

        threshold = self._effective_threshold()
        # Ignore OWW on near-silent frames (room noise) but allow quiet USB mics.
        min_peak = 22.0
        if self._peak_rms < min_peak:
            self._near_miss = 0
            now_lp = time.time()
            if now_lp - self._debug_at >= 1.0:
                self._debug_at = now_lp
                wlog(f'oww SKIP peak_rms={self._peak_rms:.0f} < min_peak={min_peak:.0f} (frame ignored)')
            return None

        if best_phrase and best_score >= threshold:
            self._cooldown_until = time.time() + 2.0
            self._near_miss = 0
            print(
                f'[listener/oww] detected {best_phrase} score={best_score:.3f} '
                f'threshold={threshold:.3f} peak_rms={self._peak_rms:.0f}',
                flush=True,
            )
            wlog(f'oww *** DETECTED {best_phrase} score={best_score:.3f} thr={threshold:.3f} peak={self._peak_rms:.0f} ***')
            return best_phrase

        # Quiet mics: two frames above a softer floor.
        soft_floor = min(threshold, 0.032)
        if best_phrase and best_score >= soft_floor:
            self._near_miss += 1
            if self._near_miss >= 2:
                self._cooldown_until = time.time() + 2.0
                self._near_miss = 0
                print(
                    f'[listener/oww] detected {best_phrase} score={best_score:.3f} '
                    f'(soft streak) peak_rms={self._peak_rms:.0f}',
                    flush=True,
                )
                wlog(f'oww *** DETECTED {best_phrase} score={best_score:.3f} (soft streak) peak={self._peak_rms:.0f} ***')
                return best_phrase
        else:
            self._near_miss = 0

        now = time.time()
        if now - self._debug_at >= 1.0:
            self._debug_at = now
            score_str = ", ".join(f"{k}={float(v or 0):.3f}" for k, v in (scores or {}).items())
            line = (
                f'top_score={best_score:.3f} threshold={threshold:.3f} '
                f'peak_rms={self._peak_rms:.0f} scores={{{score_str}}}'
            )
            print(f'[listener/oww] {line}', flush=True)
            wlog(f'oww {line}')
        return None


class PorcupineDetector(FrameWakeDetector):
    engine_name = 'porcupine'

    def __init__(
        self,
        phrases: list[str],
        access_key: str,
        sensitivity: float = 0.5,
        keyword_paths: list[str] | None = None,
    ) -> None:
        import pvporcupine

        if not str(access_key or '').strip():
            raise RuntimeError('Porcupine access key is required')

        keywords: list[str] = []
        paths: list[str] = list(keyword_paths or [])
        self._labels: list[str] = []
        sens: list[float] = []
        s = max(0.1, min(0.9, float(sensitivity or 0.5)))

        for phrase in phrases or []:
            norm = _normalize_phrase(phrase)
            kw = PORCUPINE_PHRASE_KEYWORDS.get(norm)
            if kw and kw not in keywords:
                keywords.append(kw)
                self._labels.append(phrase)
                sens.append(s)

        create_kwargs: dict[str, Any] = {'access_key': access_key.strip()}
        if paths:
            create_kwargs['keyword_paths'] = paths
            create_kwargs['sensitivities'] = [s] * len(paths)
            self._labels = [f'custom:{i}' for i in range(len(paths))]
        elif keywords:
            create_kwargs['keywords'] = keywords
            create_kwargs['sensitivities'] = sens
        else:
            raise RuntimeError('No Porcupine-compatible wake phrases or custom .ppn paths')

        self._porcupine = pvporcupine.create(**create_kwargs)
        self._frame_length = self._porcupine.frame_length
        self._buffer = np.array([], dtype=np.int16)
        self._cooldown_until = 0.0
        print(
            f'[listener/porcupine] keywords={keywords or paths} frame={self._frame_length}',
            flush=True,
        )

    def reset(self) -> None:
        self._buffer = np.array([], dtype=np.int16)
        self._cooldown_until = 0.0

    def process_frame(self, pcm: bytes) -> str | None:
        if time.time() < self._cooldown_until:
            return None
        samples = np.frombuffer(pcm, dtype=np.int16)
        if samples.size == 0:
            return None
        self._buffer = np.concatenate([self._buffer, samples])
        detected: str | None = None
        while self._buffer.size >= self._frame_length:
            frame = self._buffer[: self._frame_length]
            self._buffer = self._buffer[self._frame_length :]
            try:
                idx = self._porcupine.process(frame)
            except Exception as exc:
                print(f'[listener/porcupine] process failed: {exc}', flush=True)
                break
            if idx >= 0:
                label = self._labels[idx] if idx < len(self._labels) else 'wake'
                self._cooldown_until = time.time() + 1.2
                print(f'[listener/porcupine] detected {label}', flush=True)
                detected = label
                break
        return detected

    def close(self) -> None:
        try:
            self._porcupine.delete()
        except Exception:
            pass


class WhisperPhraseDetector:
    engine_name = 'whisper'

    def __init__(self, phrases: list[str]) -> None:
        self._phrases = [_normalize_phrase(p) for p in (phrases or []) if _normalize_phrase(p)]

    def reset(self) -> None:
        pass

    def matches(self, text: str) -> str | None:
        norm = _normalize_phrase(text)
        if not norm:
            return None
        norm_compact = norm.replace(' ', '')
        for phrase in self._phrases:
            if norm == phrase or norm.startswith(f'{phrase} ') or phrase in norm:
                return phrase
            pc = phrase.replace(' ', '')
            if norm_compact == pc or norm_compact.startswith(pc) or pc in norm_compact:
                return phrase
        # Whisper often hears "jarvis" / "hi jarvis" with punctuation or filler.
        if 'jarvis' in norm and len(norm) <= 48:
            for phrase in self._phrases:
                if 'jarvis' in phrase.lower():
                    return phrase
        fuzzy = self._match_jarvis_fuzzy(norm)
        if fuzzy:
            return fuzzy
        # Chinese homophones / partial transcripts for 贾维斯.
        zh_aliases = ('贾维斯', '加维斯', '杰维斯', '伽维斯', '假维斯', 'jarvis', 'jar vis', 'jarvus')
        if any(alias in norm for alias in zh_aliases) or any(alias in text for alias in zh_aliases):
            for phrase in self._phrases:
                if '贾维斯' in phrase or 'jarvis' in phrase.lower():
                    return phrase
        # 中文唤醒词：按拼音模糊匹配（whisper 常转成同音别字，如 邓紫棋→彈子齊/断子齊）
        for phrase in self._phrases:
            if re.search(r'[一-鿿]', phrase) and pinyin_fuzzy_match(phrase, text):
                return phrase
        # 英文/拉丁唤醒词：转写常听成近音（Jaslyn→Jaslene/Jasline），按拼写相似度模糊匹配
        words = [w.strip('.,!?;:') for w in norm.split() if w.strip('.,!?;:')]
        for phrase in self._phrases:
            if re.search(r'[一-鿿]', phrase):
                continue
            p = phrase.replace(' ', '')
            if len(p) < 3:
                continue
            # 整句去空格后整体比；或逐词比（应对“hi/hey + 名字”）
            if SequenceMatcher(None, norm.replace(' ', ''), p).ratio() >= 0.82:
                return phrase
            for w in words:
                if len(w) >= 3 and SequenceMatcher(None, w, p).ratio() >= 0.72:
                    return phrase
        return None

    def _match_jarvis_fuzzy(self, norm: str) -> str | None:
        jarvis_phrases = [p for p in self._phrases if 'jarvis' in p]
        if not jarvis_phrases:
            return None
        words = [w.strip('.,!?') for w in norm.split() if w.strip('.,!?')]
        if len(words) < 2:
            return None
        for i in range(min(4, len(words) - 1)):
            greet = words[i].lower()
            if greet not in _JARVIS_GREETING_PREFIXES:
                continue
            name = words[i + 1].lower()
            if name not in _JARVIS_SOUNDALIKES and not _sounds_like_jarvis(name):
                continue
            for phrase in jarvis_phrases:
                if phrase.startswith(greet) or (
                    phrase.startswith('hey') and greet in ('hej', 'hello', 'hallo', 'hiya', 'heya')
                ):
                    return phrase
                if phrase.startswith('hi') and greet == 'hi':
                    return phrase
            return jarvis_phrases[0]
        return None


def build_frame_detector(config: dict[str, Any]) -> FrameWakeDetector | None:
    engine = str(config.get('wakeEngine') or 'openwakeword').lower()
    phrases = list(config.get('wakePhrases') or [])
    sensitivity = float(config.get('sensitivity') or 0.5)

    if engine == 'whisper':
        return None

    if engine == 'openwakeword':
        try:
            det = OpenWakeWordDetector(phrases, sensitivity=sensitivity)
            wlog(f'build_frame_detector OK engine=openwakeword phrases={phrases}')
            return det
        except Exception as exc:
            print(f'[listener] openWakeWord init failed: {exc}', flush=True)
            wlog(f'build_frame_detector FAILED engine=openwakeword err={exc!r} phrases={phrases}')
            return None

    if engine == 'porcupine':
        try:
            return PorcupineDetector(
                phrases,
                access_key=str(config.get('porcupineAccessKey') or ''),
                sensitivity=sensitivity,
                keyword_paths=list(config.get('porcupineKeywordPaths') or []),
            )
        except Exception as exc:
            print(f'[listener] Porcupine init failed: {exc}', flush=True)
            return None

    return None


def needs_whisper_fallback(config: dict[str, Any]) -> bool:
    if bool(config.get('wakeRequireStt', True)):
        return True
    engine = str(config.get('wakeEngine') or 'openwakeword').lower()
    phrases = list(config.get('wakePhrases') or [])
    if engine == 'whisper':
        return True
    if not phrases:
        return False
    return _phrase_needs_whisper_fallback(phrases, engine)
