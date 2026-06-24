"""Split one finished instrumental track into 4 Demucs stems.

Input: a single mp3/wav in raw/ (e.g. an ElevenLabs / Udio / Suno source).
Output: raw/demucs/<trackname>/{drums,bass,other,vocals}.wav

The 4 htdemucs stems are remapped to the game's 3 combo tiers by
assemble_demucs_stems.py — drums/other/vocals are used, bass is dropped
(the game owns 60-660 Hz with its own C-major bassteroid drone, so a
separated bass line would both lose the ingame_mix audit and imply non-C
roots that fight the fixed drone).

htdemucs is not phase-linear, so the separated stems can warble at quiet
moments; the 50 ms edge fades in assemble_demucs_stems.py cover the seam.

Usage:
  venv/bin/python separate_stems.py raw/tidewatch-el-source.mp3
  venv/bin/python separate_stems.py raw/tidewatch-el-source.mp3 --device mps

Default device is cpu for reproducibility; mps is faster on Apple Silicon
but has historically had correctness quirks on some torch builds. The first
run downloads the htdemucs weights (~80 MB) to ~/.cache/torch/hub.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
OUT = RAW / "demucs"


def separate(source: Path, device: str) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    # htdemucs writes wav (lossless) so downstream loop-find / normalize
    # operates before any mp3 round-trip. --filename flattens the per-model
    # subdir so stems land at raw/demucs/<trackname>/<stem>.wav.
    cmd = [
        sys.executable, "-m", "demucs",
        "-n", "htdemucs",
        "-d", device,
        "--out", str(OUT),
        "--filename", "{stem}.{ext}",
        str(source),
    ]
    print("running:", " ".join(cmd))
    subprocess.run(cmd, check=True)
    stem_dir = OUT / "htdemucs" / source.stem
    produced = sorted(p.name for p in stem_dir.glob("*.wav"))
    print(f"stems → {stem_dir}")
    for name in produced:
        print(f"  {name}")
    return stem_dir


def main():
    p = argparse.ArgumentParser()
    p.add_argument("source", help="path to the source mp3/wav (in raw/)")
    p.add_argument("--device", default="cpu", choices=["cpu", "mps"])
    args = p.parse_args()
    src = Path(args.source)
    if not src.is_absolute():
        src = HERE / src
    if not src.exists():
        raise SystemExit(f"source not found: {src}")
    separate(src, args.device)


if __name__ == "__main__":
    main()
