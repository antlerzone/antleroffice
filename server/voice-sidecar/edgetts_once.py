#!/usr/bin/env python3
"""One-shot EdgeTTS synthesis (stdin JSON → stdout audio/mp3)."""

from __future__ import annotations

import asyncio
import json
import sys


async def _synth(text: str, voice: str, rate: float) -> bytes:
    import edge_tts

    rate_pct = int((rate - 1.0) * 100)
    rate_str = f'+{rate_pct}%' if rate_pct >= 0 else f'{rate_pct}%'
    comm = edge_tts.Communicate(text, voice, rate=rate_str)
    buf = bytearray()
    async for chunk in comm.stream():
        if chunk['type'] == 'audio':
            buf.extend(chunk['data'])
    if not buf:
        raise RuntimeError('EdgeTTS produced no audio')
    return bytes(buf)


def main() -> None:
    try:
        req = json.loads(sys.stdin.read() or '{}')
    except json.JSONDecodeError as e:
        print(f'Invalid JSON: {e}', file=sys.stderr)
        sys.exit(1)
    text = str(req.get('text') or '').strip()
    if not text:
        print('text is required', file=sys.stderr)
        sys.exit(1)
    voice = str(req.get('voice') or 'en-GB-RyanNeural')
    rate = float(req.get('rate') or 1.0)
    try:
        data = asyncio.run(_synth(text, voice, rate))
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
    sys.stdout.buffer.write(data)


if __name__ == '__main__':
    main()
