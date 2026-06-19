"""Wake word engines for AntlerOffice listener sidecar."""

from __future__ import annotations

import re
import time
from abc import ABC, abstractmethod
from typing import Any

import numpy as np

# Built-in phrase → openWakeWord model names (English models only).
OPENWAKEWORD_PHRASE_MODELS: dict[str, str] = {
    'jarvis': 'hey_jarvis',
    'hey jarvis': 'hey_jarvis',
    'hey antler': 'hey_mycroft',
}

# Built-in phrase → Porcupine keyword names (see pvporcupine.KEYWORDS).
PORCUPINE_PHRASE_KEYWORDS: dict[str, str] = {
    'jarvis': 'jarvis',
    'hey jarvis': 'jarvis',
    'hey antler': 'computer',
}

OWW_CHUNK_SAMPLES = 1280


def _normalize_phrase(text: str) -> str:
    return re.sub(r'\s+', ' ', str(text or '').strip().lower())


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
            model = OPENWAKEWORD_PHRASE_MODELS.get(norm)
            if model and model not in self._phrase_by_model:
                self._phrase_by_model[model] = phrase
                models.append(model)

        if not models:
            raise RuntimeError('No openWakeWord-compatible wake phrases selected')

        self._threshold = max(0.2, min(0.9, float(sensitivity or 0.5)))
        self._model = Model(wakeword_models=models)
        self._models = models
        self._cooldown_until = 0.0
        print(f'[listener/oww] models={models} threshold={self._threshold}', flush=True)

    def reset(self) -> None:
        self._cooldown_until = 0.0

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

        for model_name, phrase in self._phrase_by_model.items():
            score = float(scores.get(model_name, 0) or 0)
            if score >= self._threshold:
                self._cooldown_until = time.time() + 1.2
                print(f'[listener/oww] detected {phrase} score={score:.3f}', flush=True)
                return phrase
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
        for phrase in self._phrases:
            if norm == phrase or norm.startswith(f'{phrase} ') or phrase in norm:
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
    if engine == 'whisper':
        return True
    phrases = list(config.get('wakePhrases') or [])
    return _phrase_needs_whisper_fallback(phrases, engine)
