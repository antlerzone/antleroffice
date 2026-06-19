"""Convert voice reference audio to WAV for CosyVoice."""

from __future__ import annotations

import subprocess
import sys


def convert_to_wav(src: str, dst: str) -> None:
    try:
        import imageio_ffmpeg
    except ImportError as exc:
        raise RuntimeError('imageio-ffmpeg is not installed in voice venv') from exc

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    proc = subprocess.run(
        [ffmpeg, '-y', '-i', src, '-ac', '1', '-ar', '24000', dst],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f'ffmpeg failed ({proc.returncode})')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('usage: convert_audio.py <input> <output.wav>', file=sys.stderr)
        sys.exit(2)
    convert_to_wav(sys.argv[1], sys.argv[2])
    print(dst := sys.argv[2])
