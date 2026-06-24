"""Standalone openWakeWord test — continuous 16 kHz stream straight into the model.

Run with the listener venv python:
  & "C:\\Users\\User\\.antleroffice2\\voice-runtime\\venv\\Scripts\\python.exe" oww_stream_test.py

Then say "Hey Jarvis" a few times. If scores jump up (e.g. 0.3 - 0.9), the app's
choppy per-frame capture is the culprit and we fix that. If scores stay ~0.000
even here, the problem is the model/audio itself.
"""

import time

import numpy as np
import sounddevice as sd

SR = 16000
CHUNK = 1280  # 80 ms — openWakeWord's expected frame size


def load_model():
    from openwakeword.model import Model

    # Try the friendly name first; fall back to the explicit bundled path.
    try:
        return Model(wakeword_models=["hey_jarvis"])
    except Exception as exc:
        print(f"[test] name load failed ({exc}); trying explicit path", flush=True)
        import os
        import openwakeword

        models_dir = os.path.join(
            os.path.dirname(openwakeword.__file__), "resources", "models"
        )
        onnx = os.path.join(models_dir, "hey_jarvis_v0.1.onnx")
        return Model(wakeword_models=[onnx])


def main() -> None:
    print("[test] default input device:", sd.query_devices(kind="input").get("name"))
    model = load_model()
    print("[test] model loaded. Listening on a CONTINUOUS 16 kHz stream.")
    print("[test] Say 'Hey Jarvis' a few times. Ctrl+C to stop.\n", flush=True)

    session_max = 0.0
    last_report = time.time()
    recent_max = 0.0

    with sd.InputStream(samplerate=SR, channels=1, dtype="int16", blocksize=CHUNK) as stream:
        while True:
            data, _overflowed = stream.read(CHUNK)
            samples = np.asarray(data, dtype=np.int16).reshape(-1)
            scores = model.predict(samples)

            hj = 0.0
            for key, val in (scores or {}).items():
                if "jarvis" in str(key):
                    hj = max(hj, float(val or 0.0))

            recent_max = max(recent_max, hj)
            session_max = max(session_max, hj)

            if hj >= 0.5:
                print(f"  *** WAKE! hey_jarvis = {hj:.3f} ***", flush=True)
            elif hj >= 0.1:
                print(f"  >>> hey_jarvis = {hj:.3f}", flush=True)

            now = time.time()
            if now - last_report >= 1.0:
                print(
                    f"[test] listening...  recent_max={recent_max:.3f}  session_max={session_max:.3f}",
                    flush=True,
                )
                recent_max = 0.0
                last_report = now


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[test] stopped.")
