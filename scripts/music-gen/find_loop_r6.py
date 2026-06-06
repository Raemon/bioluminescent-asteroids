"""Find the best 32s window inside a 64s ElevenLabs r6 stem.

Same approach as find_loop_r5, but the harmonic constraint is different:
r6 accepts G-rooted (V) melodic, A-rooted (vi) ambient, F-rooted (IV)
layer3 against the C bass field. Penalize only truly-clashing pitches
(F#, C#, D#, G#).

We also want the loop window to land on an even multiple of the 8th-note
grid (0.25s) so a quantization step downstream has a coherent target.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import librosa
import numpy as np

LOOP_S = 32.0
SR = 22050
SEAM_MS = 500
STEP_S = 0.25  # search at 8th-note grid

# Penalize only true clashes: F#, C#, D#, G#.
# Everything else is acceptable (we accept G/A/F-rooted content).
PENALTY_WEIGHTS = np.array([
    0.0,  # C
    0.6,  # C#
    0.0,  # D
    0.4,  # D#
    0.0,  # E
    0.0,  # F  ← accepted (IV)
    0.7,  # F#
    0.0,  # G
    0.5,  # G#
    0.0,  # A
    0.3,  # A#
    0.0,  # B
])
# Bonus for C/G/E (bass field's pitches)
FIT_WEIGHTS = np.array([
    1.0,  # C
    0.0,  # C#
    0.0,  # D
    0.0,  # D#
    0.7,  # E
    0.0,  # F
    0.0,  # F#
    1.0,  # G
    0.0,  # G#
    0.3,  # A  (relative minor, ok)
    0.0,  # A#
    0.4,  # B  (Cmaj7 colour)
])


def load(path: Path):
    return librosa.load(str(path), sr=SR, mono=True)


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
            "fit": round(fit, 4),
            "fight": round(fight, 4),
            "score": round(score, 4),
        })
        offset += STEP_S

    candidates.sort(key=lambda c: c["score"], reverse=True)
    print(json.dumps({"top5": candidates[:5], "all_n": len(candidates)}, indent=2))


if __name__ == "__main__":
    main(sys.argv[1])
