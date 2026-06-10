"""Find best 32s loop window for the flagship-sb reroll + spectral-toll stems.

Same scoring as find_loop_haunting-el.py: reward C/G/E home pitches, tolerate
A/B/F colour, punish true clashes (C#/D#/F#/G#). Downbeat-aligned offsets
(multiples of 2.0s) get a small bonus. Prints top-5 windows per stem so we can
read fit/fight before committing — a window can sit fine over the C-pedal even
when the global key label is off (e.g. A-minor melodic = vi colour).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import librosa
import numpy as np

HERE = Path(__file__).resolve().parent
LOOP_S = 32.0
SR = 22050
SEAM_MS = 500
STEP_S = 0.5

PENALTY_WEIGHTS = np.array([
    0.0, 0.6, 0.0, 0.4, 0.0, 0.0, 0.7, 0.0, 0.5, 0.0, 0.3, 0.0,
])
FIT_WEIGHTS = np.array([
    1.0, 0.0, 0.0, 0.0, 0.7, 0.4, 0.0, 1.0, 0.0, 0.3, 0.0, 0.4,
])

STEMS = sys.argv[1:] or [
    "flagship-sb-melodic-el",
    "flagship-sb-layer3-el",
    "spectral-toll-sb-ambient",
    "spectral-toll-sb-melodic",
]


def seam_similarity(y, sr):
    n = int(sr * SEAM_MS / 1000)
    if y.size < 2 * n:
        return 0.0
    head, tail = y[:n], y[-n:]
    mh = librosa.feature.melspectrogram(y=head, sr=sr, n_mels=32).mean(axis=1)
    mt = librosa.feature.melspectrogram(y=tail, sr=sr, n_mels=32).mean(axis=1)
    mh /= (np.linalg.norm(mh) + 1e-9)
    mt /= (np.linalg.norm(mt) + 1e-9)
    return float(np.dot(mh, mt))


def chroma_score(y, sr):
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    chroma /= (chroma.sum() + 1e-9)
    return float(np.dot(chroma, FIT_WEIGHTS)), float(np.dot(chroma, PENALTY_WEIGHTS))


def find_best(path):
    y, sr = librosa.load(str(path), sr=SR, mono=True)
    total_s = len(y) / sr
    if total_s < LOOP_S + 0.5:
        return None
    out = []
    offset = 0.0
    while offset + LOOP_S <= total_s:
        win = y[int(offset * sr):int((offset + LOOP_S) * sr)]
        seam = seam_similarity(win, sr)
        fit, fight = chroma_score(win, sr)
        downbeat = 0.1 if abs(offset % 2.0) < 0.05 else 0.0
        score = seam + fit - 1.5 * fight + downbeat
        out.append({"offset_s": round(offset, 3), "seam": round(seam, 4),
                    "fit": round(fit, 4), "fight": round(fight, 4),
                    "score": round(score, 4)})
        offset += STEP_S
    out.sort(key=lambda c: c["score"], reverse=True)
    return out[:5]


def main():
    raw = HERE / "raw"
    res = {}
    for stem in STEMS:
        p = raw / f"{stem}.mp3"
        res[stem] = find_best(p) if p.exists() else {"error": "missing"}
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
