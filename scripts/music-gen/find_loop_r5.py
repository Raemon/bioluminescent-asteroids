"""Find the best 32s window inside a 64s ElevenLabs stem so the result
loops cleanly.

The user asked EL for "32-second phrase played twice (64 seconds total)" —
EL ignored that and gave us through-composed 64s pieces. We need to find
the 32s sub-window whose start and end are most similar (so the seam
clicks the least when looped) AND that has chroma matching the C-pedal
constraint (so it doesn't fight the bass field).

Strategy:
  - Search offsets from 0.0 to 32.0s in 0.25s steps.
  - For each candidate window [t, t+32], score:
      * seam similarity: spectral cosine between window[:0.5s] and
        window[-0.5s:]. Higher = cleaner loop seam.
      * C-centricity: chroma vector across the window, weight on
        pitch classes C, E, G, B. Higher = better fit.
      * onset-grid alignment: snap to nearest beat (0.5s at 120 BPM)
        and ensure the offset lands on a downbeat (multiple of 2.0s).
  - Pick the highest combined score.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import librosa
import numpy as np

HERE = Path(__file__).resolve().parent
LOOP_S = 32.0
SR = 22050  # downsampled OK for similarity / chroma analysis
SEAM_MS = 500
STEP_S = 0.5  # search at beat grid

C_PEDAL_WEIGHTS = np.array([
    1.0,  # C
    0.0,  # C#
    0.0,  # D
    0.0,  # D# (Eb is a valid color)
    0.8,  # E
    0.0,  # F  ← penalty
    0.0,  # F#
    1.0,  # G
    0.0,  # G#
    0.0,  # A
    0.0,  # A#
    0.6,  # B  (Cmaj7 color)
])
# Pitch classes that actively fight the C-pedal (F natural, A, D, F# etc).
PENALTY_WEIGHTS = np.array([
    0.0,  # C
    0.5,  # C#
    0.4,  # D
    0.0,  # D# Eb is ok
    0.0,  # E
    1.0,  # F  ← strong penalty
    0.5,  # F#
    0.0,  # G
    0.5,  # G#
    0.6,  # A
    0.4,  # A#
    0.0,  # B
])


def load(path: Path):
    y, sr = librosa.load(str(path), sr=SR, mono=True)
    return y, sr


def seam_similarity(y: np.ndarray, sr: int) -> float:
    n = int(sr * SEAM_MS / 1000)
    if y.size < 2 * n:
        return 0.0
    head = y[:n]
    tail = y[-n:]
    # Compare normalized spectra (mel) — robust to phase mismatch.
    mh = librosa.feature.melspectrogram(y=head, sr=sr, n_mels=32).mean(axis=1)
    mt = librosa.feature.melspectrogram(y=tail, sr=sr, n_mels=32).mean(axis=1)
    mh = mh / (np.linalg.norm(mh) + 1e-9)
    mt = mt / (np.linalg.norm(mt) + 1e-9)
    return float(np.dot(mh, mt))


def chroma_score(y: np.ndarray, sr: int) -> tuple[float, float]:
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    chroma = chroma / (chroma.sum() + 1e-9)
    fit = float(np.dot(chroma, C_PEDAL_WEIGHTS))
    fight = float(np.dot(chroma, PENALTY_WEIGHTS))
    return fit, fight


def main(path: str):
    src = Path(path)
    y, sr = load(src)
    total_s = len(y) / sr
    print(f"# loaded {path}, total {total_s:.2f}s @ {sr}", file=sys.stderr)

    if total_s < LOOP_S + 0.5:
        print(f"too short ({total_s:.2f}s) for 32s window search", file=sys.stderr)
        sys.exit(1)

    candidates = []
    offset = 0.0
    while offset + LOOP_S <= total_s:
        i0 = int(offset * sr)
        i1 = int((offset + LOOP_S) * sr)
        win = y[i0:i1]
        seam = seam_similarity(win, sr)
        fit, fight = chroma_score(win, sr)
        score = 1.0 * seam + 1.0 * fit - 1.5 * fight
        candidates.append({
            "offset_s": round(offset, 3),
            "seam": round(seam, 4),
            "c_fit": round(fit, 4),
            "fight": round(fight, 4),
            "score": round(score, 4),
        })
        offset += STEP_S

    candidates.sort(key=lambda c: c["score"], reverse=True)
    print(json.dumps({"top5": candidates[:5], "all_n": len(candidates)}, indent=2))


if __name__ == "__main__":
    main(sys.argv[1])
