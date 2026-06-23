"""Wake word engines for AntlerOffice listener sidecar."""

from __future__ import annotations

import re
import time
from abc import ABC, abstractmethod
from typing import Any

import numpy as np

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
        if best_phrase and best_score >= threshold:
            self._cooldown_until = time.time() + 3.0
            self._near_miss = 0
            print(
                f'[listener/oww] detected {best_phrase} score={best_score:.3f} '
                f'threshold={threshold:.3f} peak_rms={self._peak_rms:.0f}',
                flush=True,
            )
            return best_phrase

        # Quiet mics: require 2 consecutive frames above a softer floor.
        soft_floor = min(threshold, 0.032)
        if best_phrase and best_score >= soft_floor:
            self._near_miss += 1
            if self._near_miss >= 2:
                self._cooldown_until = time.time() + 3.0
                self._near_miss = 0
                print(
                    f'[listener/oww] detected {best_phrase} score={best_score:.3f} '
                    f'(soft streak) peak_rms={self._peak_rms:.0f}',
                    flush=True,
                )
                return best_phrase
        else:
            self._near_miss = 0

        now = time.time()
        if now - self._debug_at >= 4.0 and best_score >= 0.03:
            self._debug_at = now
            print(
                f'[listener/oww] top_score={best_score:.3f} threshold={threshold:.3f} '
                f'peak_rms={self._peak_rms:.0f} '
                f'scores={{{", ".join(f"{k}={float(v or 0):.3f}" for k, v in (scores or {}).items())}}}',
                flush=True,
            )
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
        # Chinese homophones / partial transcripts for 贾维斯.
        zh_aliases = ('贾维斯', '加维斯', '杰维斯', '伽维斯', '假维斯', 'jarvis', 'jar vis', 'jarvus')
        if any(alias in norm for alias in zh_aliases) or any(alias in text for alias in zh_aliases):
            for phrase in self._phrases:
                if '贾维斯' in phrase or 'jarvis' in phrase.lower():
                    return phrase
        return None


def build_frame_detector(config: dict[str, Any]) -> FrameWakeDetector | None:
    engine = str(config.get('wakeEngine') or 'openwakeword').lower()
    phrases = list(config.get('wakePhrases') or [])
    sensitivity = float(config.get('sensitivity') or 0.5)

    if engine == 'whisper':
        return None

    if engine == 'openwakeword':
        try:
            return OpenWakeWordDetector(phrases, sensitivity=sensitivity)
        except Exception as exc:
            print(f'[listener] openWakeWord init failed: {exc}', flush=True)
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
    engine = str(config.get('wakeEngine') or 'openwakeword').lower()
    phrases = list(config.get('wakePhrases') or [])
    if engine == 'whisper':
        return True
    if not phrases:
        return False
    # Always STT-match captured utterances — OWW/Porcupine miss quiet USB mics often.
    return True
