"""Find the best long-loop window for a Demucs-split source.

We score windows on the `other` stem (the harmonic bed): it's the layer
that must loop seamlessly and stay C-centric. All three game stems then
inherit the SAME offset so they stay phase-locked when the runtime starts
them together at sample 0.

Differences from find_loop_haunting-el.py:
  - LOOP_S defaults to 64.0 (32 bass measures) instead of 32.0; --loop-s
    overrides (use 128 for 64 measures). Both are whole multiples of the
    2.0 s bass measure, so the seam lands on a downbeat.
  - The downbeat bonus (offset on a 2.0 s multiple) and the 500 ms seam
    window are loop-length-independent and carry over unchanged.
  - Chroma weights corrected for the ACTUAL bass-field content: the drone
    holds C-E-G-A plus B and D color, so A and D are drone-safe (reward /
    neutral), not penalized. F stays the one diatonic pitch that fights the
    drone's E, so it's only mild colour. Non-diatonic (C#/D#/F#/G#/A#) clash.

Usage:
  venv/bin/python find_loop_demucs.py raw/demucs/htdemucs/tidewatch-el-source/other.wav
  venv/bin/python find_loop_demucs.py <other.wav> --loop-s 128
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import librosa
import numpy as np

HERE = Path(__file__).resolve().parent
SR = 22050
SEAM_MS = 500
STEP_S = 0.5  # search at beat grid; downbeat bonus rewards 2.0 s multiples

# F is the only diatonic-in-C pitch that fights the drone's E (F over E is a
# minor-9th rub); keep it a mild penalty. Everything chromatic clashes.
PENALTY_WEIGHTS = np.array([
    0.0,  # C
    0.7,  # C#
    0.0,  # D   (drone has D5 — safe)
    0.4,  # D#  (Eb blue color tolerated; D# chroma kept mild)
    0.0,  # E
    0.3,  # F   (IV — brief passing only)
    0.7,  # F#
    0.0,  # G
    0.6,  # G#
    0.0,  # A   (drone has A3/E5 — safe)
    0.4,  # A#
    0.0,  # B   (drone has B4 — safe)
])
# Reward the drone's own pitches (C-E-G-A, plus B/D color).
FIT_WEIGHTS = np.array([
    1.0,  # C
    0.0,  # C#
    0.4,  # D
    0.0,  # D#
    0.8,  # E
    0.2,  # F   (IV colour)
    0.0,  # F#
    1.0,  # G
    0.0,  # G#
    0.6,  # A   (relative-minor root; drone-safe)
    0.0,  # A#
    0.5,  # B   (Cmaj7)
])


def seam_similarity(y: np.ndarray, sr: int) -> float:
    n = int(sr * SEAM_MS / 1000)
    if y.size < 2 * n:
        return 0.0
    head = y[:n]
    tail = y[-n:]
    mh = librosa.feature.melspectrogram(y=head, sr=sr, n_mels=32).mean(axis=1)
    mt = librosa.feature.melspectrogram(y=tail, sr=sr, n_mels=32).mean(axis=1)
    mh = mh / (np.linalg.norm(mh) + 1e-9)
    mt = mt / (np.linalg.norm(mt) + 1e-9)
    return float(np.dot(mh, mt))


def chroma_score(y: np.ndarray, sr: int) -> tuple[float, float]:
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    chroma = chroma / (chroma.sum() + 1e-9)
    fit = float(np.dot(chroma, FIT_WEIGHTS))
    fight = float(np.dot(chroma, PENALTY_WEIGHTS))
    return fit, fight


def find_best(path: Path, loop_s: float):
    y, sr = librosa.load(str(path), sr=SR, mono=True)
    total_s = len(y) / sr
    if total_s < loop_s + 0.5:
        return {"error": f"source {total_s:.1f}s shorter than loop {loop_s}s"}
    candidates = []
    offset = 0.0
    while offset + loop_s <= total_s:
        i0 = int(offset * sr)
        i1 = int((offset + loop_s) * sr)
        win = y[i0:i1]
        seam = seam_similarity(win, sr)
        fit, fight = chroma_score(win, sr)
        downbeat = 0.1 if abs(offset % 2.0) < 0.05 else 0.0
        score = 1.0 * seam + 1.0 * fit - 1.5 * fight + downbeat
        candidates.append({
            "offset_s": round(offset, 3),
            "seam": round(seam, 4),
            "fit": round(fit, 4),
            "fight": round(fight, 4),
            "score": round(score, 4),
        })
        offset += STEP_S
    candidates.sort(key=lambda c: c["score"], reverse=True)
    return candidates[:5]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("other_stem", help="path to the Demucs `other` stem wav")
    p.add_argument("--loop-s", type=float, default=64.0)
    args = p.parse_args()
    path = Path(args.other_stem)
    if not path.is_absolute():
        path = HERE / path
    if not path.exists():
        raise SystemExit(f"stem not found: {path}")
    result = find_best(path, args.loop_s)
    print(json.dumps({"stem": str(path), "loop_s": args.loop_s,
                      "candidates": result}, indent=2))


if __name__ == "__main__":
    main()
