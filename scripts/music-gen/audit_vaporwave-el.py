"""Deep audit for the r5-el stems.

Three checks:
  1. Loop quality — does each stem loop cleanly when played end-to-end?
     We concatenate stem×3 and measure the spectral discontinuity at each
     seam (0→32s, 32→64s). A clean seam shows similar spectra and low
     transient energy at the boundary. The seam_db measures the
     instantaneous amplitude jump (in dB) — anything above ~1 dB will be
     audible as a click/thump.

  2. Onset/attack alignment to the 120 BPM grid (0.5s per beat, 2.0s per
     bass measure). We run librosa.onset.onset_detect and measure each
     onset's deviation from the nearest beat boundary. >50ms drift =
     audibly off-grid; the chime/bell hits especially need to land on
     beats.

  3. Inter-layer compatibility — three sub-checks:
     a. Chroma correlation: do the three stems share the same harmonic
        center, or are they pulling in different directions? Cosine
        similarity of mean chroma vectors.
     b. Busyness: onsets-per-second per stem. The full stack at combo 12
        should not exceed ~3-4 onsets/s sustained, or the music feels busy.
     c. Frequency overlap: which bands does each stem occupy? If two
        layers fight for the same band, the audit will already have
        flagged it, but this gives the per-layer breakdown.

Output written to stdout as JSON.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import librosa
import numpy as np

HERE = Path(__file__).resolve().parent
PROC = HERE / "processed"

LOOP_S = 32.0
SR = 44100
BPM = 120
BEAT_S = 60.0 / BPM  # 0.5s
BASS_MEASURE_S = 2.0


def load(path: Path):
    y, sr = librosa.load(str(path), sr=SR, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    return y, sr


def to_mono(y: np.ndarray) -> np.ndarray:
    return y.mean(axis=0)


def loop_seam_quality(y_stereo: np.ndarray, sr: int) -> dict:
    """Concatenate stem with itself 3x and measure the seam at t=32s, t=64s."""
    y = to_mono(y_stereo)
    looped = np.concatenate([y, y, y])
    n_loop = len(y)

    # Window around each seam: 100 ms either side
    n_win = int(0.1 * sr)
    seams = []
    for seam_idx, label in [(n_loop, "seam_1_at_32s"), (2 * n_loop, "seam_2_at_64s")]:
        pre = looped[seam_idx - n_win:seam_idx]
        post = looped[seam_idx:seam_idx + n_win]
        # Instantaneous amplitude RMS difference around the seam
        pre_rms = np.sqrt(np.mean(pre ** 2) + 1e-12)
        post_rms = np.sqrt(np.mean(post ** 2) + 1e-12)
        # Sample-level jump in the exact boundary
        boundary_jump = abs(looped[seam_idx] - looped[seam_idx - 1])
        # First-derivative spike (clicks read as sample-level discontinuities)
        deriv = np.diff(looped[seam_idx - n_win:seam_idx + n_win])
        deriv_peak = float(np.max(np.abs(deriv)))
        # Normal "no seam" derivative max in the middle of the stem
        middle = y[n_win:-n_win]
        normal_deriv_peak = float(np.max(np.abs(np.diff(middle))))
        # Click severity: how much the seam's deriv spike exceeds normal max
        click_excess_db = 20 * np.log10(max(deriv_peak, 1e-9) / max(normal_deriv_peak, 1e-9))

        # Spectral comparison
        pre_mel = librosa.feature.melspectrogram(y=pre, sr=sr, n_mels=32).mean(axis=1)
        post_mel = librosa.feature.melspectrogram(y=post, sr=sr, n_mels=32).mean(axis=1)
        pre_mel = pre_mel / (np.linalg.norm(pre_mel) + 1e-9)
        post_mel = post_mel / (np.linalg.norm(post_mel) + 1e-9)
        spec_cos = float(np.dot(pre_mel, post_mel))

        seams.append({
            "label": label,
            "pre_rms_dbfs": round(float(20 * np.log10(pre_rms + 1e-12)), 2),
            "post_rms_dbfs": round(float(20 * np.log10(post_rms + 1e-12)), 2),
            "rms_jump_db": round(float(abs(20 * np.log10(post_rms / pre_rms))), 2),
            "boundary_sample_jump": round(float(boundary_jump), 5),
            "click_excess_db": round(float(click_excess_db), 2),
            "spectral_cos_pre_vs_post": round(float(spec_cos), 4),
        })
    return {"seams": seams}


def onset_alignment(y_stereo: np.ndarray, sr: int, label: str) -> dict:
    """Detect onsets, measure each onset's deviation from the 0.5s beat grid."""
    y = to_mono(y_stereo)
    onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time",
                                        backtrack=False,
                                        delta=0.06)
    onset_count = len(onsets)
    onsets_per_s = onset_count / LOOP_S

    # For each onset, deviation from nearest 0.5s beat
    if onset_count > 0:
        deviations_ms = []
        on_beat_count = 0  # within 50ms of a beat
        on_downbeat_count = 0  # within 50ms of a 2.0s bass-measure boundary
        for t in onsets:
            dev_beat = (t % BEAT_S)
            if dev_beat > BEAT_S / 2:
                dev_beat -= BEAT_S
            deviations_ms.append(abs(dev_beat * 1000))
            if abs(dev_beat) < 0.05:
                on_beat_count += 1
            dev_dbeat = t % BASS_MEASURE_S
            if dev_dbeat > BASS_MEASURE_S / 2:
                dev_dbeat -= BASS_MEASURE_S
            if abs(dev_dbeat) < 0.05:
                on_downbeat_count += 1
        median_dev_ms = float(np.median(deviations_ms))
        mean_dev_ms = float(np.mean(deviations_ms))
        on_beat_pct = round(100 * on_beat_count / onset_count, 1)
        on_downbeat_pct = round(100 * on_downbeat_count / onset_count, 1)
    else:
        median_dev_ms = 0.0
        mean_dev_ms = 0.0
        on_beat_pct = 0.0
        on_downbeat_pct = 0.0

    return {
        "label": label,
        "onset_count": onset_count,
        "onsets_per_s": round(onsets_per_s, 2),
        "median_dev_from_beat_ms": round(median_dev_ms, 1),
        "mean_dev_from_beat_ms": round(mean_dev_ms, 1),
        "on_beat_pct": on_beat_pct,
        "on_downbeat_pct": on_downbeat_pct,
        "first_5_onsets_s": [round(t, 3) for t in onsets[:5].tolist()],
    }


def chroma_vector(y_stereo: np.ndarray, sr: int) -> np.ndarray:
    y = to_mono(y_stereo)
    c = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    return c / (c.sum() + 1e-9)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def main():
    stems = ["ambient", "melodic", "layer3"]
    paths = {s: PROC / f"r5-el-{s}.mp3" for s in stems}
    loaded = {s: load(paths[s]) for s in stems}

    report = {"loops": {}, "onsets": {}, "compat": {}}

    # 1. Loop quality
    for s in stems:
        y, sr = loaded[s]
        report["loops"][s] = loop_seam_quality(y, sr)

    # 2. Onset alignment
    for s in stems:
        y, sr = loaded[s]
        report["onsets"][s] = onset_alignment(y, sr, s)

    # 3. Inter-layer compatibility
    chromas = {s: chroma_vector(loaded[s][0], loaded[s][1]) for s in stems}
    pitch_names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    for s in stems:
        # Top-3 pitch classes by weight
        c = chromas[s]
        idx = c.argsort()[::-1][:3]
        report["compat"].setdefault("top3_per_stem", {})[s] = [
            {"pc": pitch_names[i], "weight": round(float(c[i]), 3)} for i in idx
        ]

    report["compat"]["chroma_cosine"] = {
        "ambient_vs_melodic": round(cosine(chromas["ambient"], chromas["melodic"]), 4),
        "ambient_vs_layer3": round(cosine(chromas["ambient"], chromas["layer3"]), 4),
        "melodic_vs_layer3": round(cosine(chromas["melodic"], chromas["layer3"]), 4),
    }

    # Combined busyness when all three play
    total_onsets = sum(report["onsets"][s]["onset_count"] for s in stems)
    report["compat"]["full_stack_onsets_per_s"] = round(total_onsets / LOOP_S, 2)
    report["compat"]["full_stack_onset_count"] = total_onsets

    # Per-band dominance per stem (so we can see who lives where)
    def band_pct(y_stereo, sr):
        y = to_mono(y_stereo)
        S = np.abs(librosa.stft(y, n_fft=4096)) ** 2
        freqs = librosa.fft_frequencies(sr=sr, n_fft=4096)
        bands = {
            "sub_20-60": (20, 60), "bass_60-200": (60, 200),
            "lo_mid_200-500": (200, 500), "mid_500-2k": (500, 2000),
            "hi_mid_2k-6k": (2000, 6000), "air_6k-16k": (6000, 16000),
        }
        total = S.sum()
        result = {}
        for name, (lo, hi) in bands.items():
            mask = (freqs >= lo) & (freqs < hi)
            result[name] = round(float(100 * S[mask].sum() / total), 1)
        return result

    report["compat"]["band_pct_per_stem"] = {
        s: band_pct(loaded[s][0], loaded[s][1]) for s in stems
    }

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
