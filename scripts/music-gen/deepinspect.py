"""Deeper structural analysis — chroma evolution over time (chord changes),
stereo width, sub-band energy split, onset density (any transients hiding?),
and a rough loop-seam check (does the end fade out, or does it just stop?)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import librosa
import numpy as np

KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def main(path: str):
    y, sr = librosa.load(path, sr=None, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    L, R = y[0], y[1]
    mono = librosa.to_mono(y)
    dur = len(mono) / sr

    # Stereo width: correlation of L and R. 1.0 = identical (mono), 0 = unrelated,
    # < 0 = phase inverted. Pads with stereo chorus / spread sit around 0.6–0.9.
    if len(L) == len(R):
        corr = float(np.corrcoef(L, R)[0, 1])
    else:
        corr = None

    # Sub-band RMS split
    def rms(x):
        return float(np.sqrt(np.mean(x**2)))
    def bandpass_rms(x, lo, hi):
        from scipy.signal import butter, sosfilt
        sos = butter(4, [lo, hi], btype="bandpass", fs=sr, output="sos")
        return rms(sosfilt(sos, x))
    bands = {
        "sub_20-60":    bandpass_rms(mono, 20, 60),
        "bass_60-200":  bandpass_rms(mono, 60, 200),
        "lo_mid_200-500":  bandpass_rms(mono, 200, 500),
        "mid_500-2k":   bandpass_rms(mono, 500, 2000),
        "hi_mid_2k-6k": bandpass_rms(mono, 2000, 6000),
        "air_6k-16k":   bandpass_rms(mono, 6000, 16000),
    }
    total = sum(bands.values())
    band_pct = {k: round(100 * v / total, 1) for k, v in bands.items()}

    # Chroma over time — chord changes show up as the dominant chroma class
    # shifting at clear time boundaries.
    hop = 2048
    chroma = librosa.feature.chroma_cqt(y=mono, sr=sr, hop_length=hop)
    times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=hop)
    # Take chroma snapshots every ~1s
    snap_idxs = np.linspace(0, chroma.shape[1] - 1, 12).astype(int)
    chroma_track = []
    for i in snap_idxs:
        col = chroma[:, i]
        # top 3 pitch classes
        top = np.argsort(col)[::-1][:3]
        chroma_track.append({
            "time_s": round(float(times[i]), 2),
            "top3": [{"pc": KEYS[int(p)], "weight": round(float(col[p]), 2)} for p in top],
        })

    # Detect chroma stability: low-variance chroma == sustained drone; high-variance
    # == changing chords. We report standard deviation per pitch class.
    chroma_std = np.std(chroma, axis=1)
    most_stable_pc = KEYS[int(np.argmin(chroma_std))]
    most_changing_pc = KEYS[int(np.argmax(chroma_std))]

    # Onset envelope — any transients hiding in this "ambient" pad?
    onset_env = librosa.onset.onset_strength(y=mono, sr=sr)
    onsets_n = int(np.sum(onset_env > onset_env.mean() + 2 * onset_env.std()))

    # Loudness envelope — does the file fade out at the end?
    rms_env = librosa.feature.rms(y=mono, frame_length=4096, hop_length=2048)[0]
    rms_first_500ms = float(rms_env[: int(0.5 * sr / 2048)].mean())
    rms_last_500ms = float(rms_env[-int(0.5 * sr / 2048):].mean())
    rms_middle = float(rms_env[len(rms_env) // 4: 3 * len(rms_env) // 4].mean())
    fade_ratio_start = rms_first_500ms / (rms_middle + 1e-9)
    fade_ratio_end = rms_last_500ms / (rms_middle + 1e-9)

    # Spectral centroid evolution — does brightness change across the file?
    centroid_env = librosa.feature.spectral_centroid(y=mono, sr=sr, hop_length=hop)[0]
    centroid_quartiles = [
        round(float(centroid_env[i * len(centroid_env) // 4 : (i + 1) * len(centroid_env) // 4].mean()), 1)
        for i in range(4)
    ]

    # Try to estimate loop-ability: compare first 500ms to last 500ms — high similarity
    # = it could loop seamlessly; low = it has a defined start and end.
    head = mono[: int(0.5 * sr)]
    tail = mono[-int(0.5 * sr):]
    seam_corr = float(np.corrcoef(head, tail)[0, 1]) if len(head) == len(tail) else None

    out = {
        "path": path,
        "duration_s": round(dur, 2),
        "stereo_correlation": corr,
        "band_energy_pct": band_pct,
        "chroma_track": chroma_track,
        "chroma_most_stable_pitch_class": most_stable_pc,
        "chroma_most_varying_pitch_class": most_changing_pc,
        "transient_onsets_above_2std": onsets_n,
        "rms_envelope": {
            "first_500ms": round(rms_first_500ms, 5),
            "middle": round(rms_middle, 5),
            "last_500ms": round(rms_last_500ms, 5),
            "fade_in_ratio": round(fade_ratio_start, 3),
            "fade_out_ratio": round(fade_ratio_end, 3),
        },
        "spectral_centroid_by_quartile_hz": centroid_quartiles,
        "first_vs_last_correlation": seam_corr,
    }
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main(sys.argv[1])
