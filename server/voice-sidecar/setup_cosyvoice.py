#!/usr/bin/env python3
"""Install CosyVoice Python dependencies into the AntlerOffice voice venv."""

from __future__ import annotations

import os
import subprocess
import sys


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    req = os.path.join(here, 'requirements-cosyvoice.txt')
    if not os.path.isfile(req):
        print(f'Missing {req}', file=sys.stderr)
        sys.exit(1)
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--upgrade', 'pip'])
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-r', req])
    print('[setup_cosyvoice] dependencies installed', flush=True)


if __name__ == '__main__':
    main()
