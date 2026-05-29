"""Audio analysis utilities for the halo combo music pipeline.

Three jobs:
  - inspect(path): report duration / detected BPM / chroma key / loudness
  - lock_to_120(path, out_path): time-stretch (pitch-preserving) to exactly
    120 BPM, then trim/loop-pad to a clean N-measure boundary
  - mix(stems, out_path, gains): sum two stems into a stereo mix

Run from CLI:
  python analyze.py inspect path.mp3
  python analyze.py lock-to-120 in.mp3 out.wav --measures 8
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import librosa
import numpy as np
import pyrubberband as pyrb
import soundfile as sf


KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _scalar(x):
    """librosa 0.11 returns numpy scalars/arrays from tempo — coerce to float."""
    if hasattr(x, "item"):
        try:
            return float(x.item())
        except Exception:
            pass
    if isinstance(x, np.ndarray):
        return float(x.flat[0])
    return float(x)


def inspect(path: str) -> dict:
    y, sr = librosa.load(path, sr=None, mono=False)
    y_mono = librosa.to_mono(y) if y.ndim > 1 else y
    duration = float(len(y_mono) / sr)

    # Tempo / beats
    tempo, beats = librosa.beat.beat_track(y=y_mono, sr=sr)
    bpm = _scalar(tempo)
    beat_times = librosa.frames_to_time(beats, sr=sr).tolist()

    # Key estimation via Krumhansl-Schmuckler-ish chroma correlation
    chroma = librosa.feature.chroma_cqt(y=y_mono, sr=sr).mean(axis=1)
    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    corr_major = [float(np.corrcoef(np.roll(major, i), chroma)[0, 1]) for i in range(12)]
    corr_minor = [float(np.corrcoef(np.roll(minor, i), chroma)[0, 1]) for i in range(12)]
    best_major_i = int(np.argmax(corr_major))
    best_minor_i = int(np.argmax(corr_minor))
    if corr_major[best_major_i] >= corr_minor[best_minor_i]:
        key = f"{KEY_NAMES[best_major_i]} major"
        key_confidence = corr_major[best_major_i]
    else:
        key = f"{KEY_NAMES[best_minor_i]} minor"
        key_confidence = corr_minor[best_minor_i]

    # Loudness (RMS dBFS)
    rms = librosa.feature.rms(y=y_mono)[0]
    peak_db = 20 * np.log10(max(float(np.max(np.abs(y_mono))), 1e-9))
    rms_db = 20 * np.log10(max(float(np.sqrt(np.mean(y_mono ** 2))), 1e-9))

    # Spectral centroid — gives a rough "brightness" reading
    centroid = float(librosa.feature.spectral_centroid(y=y_mono, sr=sr).mean())

    return {
        "path": path,
        "duration_s": duration,
        "sample_rate": int(sr),
        "channels": int(y.ndim if y.ndim == 2 else 1) if y.ndim > 1 else 1,
        "bpm_detected": bpm,
        "beats_detected": len(beat_times),
        "first_beat_s": beat_times[0] if beat_times else None,
        "key": key,
        "key_confidence": key_confidence,
        "peak_dbfs": peak_db,
        "rms_dbfs": rms_db,
        "spectral_centroid_hz": centroid,
    }


def lock_to_120(in_path: str, out_path: str, measures: int = 8,
                target_bpm: float = 120.0, beats_per_measure: int = 4,
                detected_bpm: float | None = None,
                normalize_to_dbfs: float | None = -6.0,
                fade_ms: int = 30) -> dict:
    """Stretch the input so its detected BPM lands exactly on target_bpm, then
    crop to N measures and apply short fade in/out for clean looping."""
    y, sr = librosa.load(in_path, sr=None, mono=False)
    if y.ndim == 1:
        y = y[np.newaxis, :]

    # Detect tempo on a mono fold (more reliable than per-channel).
    mono = librosa.to_mono(y)
    if detected_bpm is None:
        tempo, _ = librosa.beat.beat_track(y=mono, sr=sr)
        detected_bpm = _scalar(tempo)

    ratio = detected_bpm / target_bpm  # rubberband stretches by this much
    # Stretch each channel; rubberband preserves pitch.
    stretched_channels = []
    for ch in y:
        stretched_channels.append(pyrb.time_stretch(ch, sr, ratio))
    # Channels may end up off-by-one in length after independent processing.
    min_len = min(len(c) for c in stretched_channels)
    stretched = np.stack([c[:min_len] for c in stretched_channels])

    # Crop to exact measure-aligned length
    samples_per_beat = sr * 60.0 / target_bpm
    samples_per_measure = samples_per_beat * beats_per_measure
    target_samples = int(round(samples_per_measure * measures))
    if stretched.shape[1] < target_samples:
        # Pad with silence on the tail
        pad = np.zeros((stretched.shape[0], target_samples - stretched.shape[1]),
                       dtype=stretched.dtype)
        stretched = np.concatenate([stretched, pad], axis=1)
    else:
        stretched = stretched[:, :target_samples]

    # Short fade in/out so the loop boundary doesn't click.
    fade_samples = int(sr * fade_ms / 1000)
    if fade_samples > 0 and stretched.shape[1] > 2 * fade_samples:
        fade_in = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
        fade_out = fade_in[::-1]
        stretched[:, :fade_samples] *= fade_in
        stretched[:, -fade_samples:] *= fade_out

    if normalize_to_dbfs is not None:
        peak = float(np.max(np.abs(stretched)))
        if peak > 1e-9:
            target_peak = 10 ** (normalize_to_dbfs / 20)
            stretched = stretched * (target_peak / peak)

    out_data = stretched.T  # soundfile wants (frames, channels)
    sf.write(out_path, out_data, sr, subtype="PCM_16")

    return {
        "out_path": out_path,
        "detected_bpm": detected_bpm,
        "stretch_ratio": ratio,
        "output_duration_s": stretched.shape[1] / sr,
        "measures": measures,
        "samples": int(stretched.shape[1]),
    }


def mix(stems: list[str], out_path: str, gains: list[float] | None = None) -> dict:
    """Sum stems to a single stereo file. Gains default to 1.0 each."""
    if gains is None:
        gains = [1.0] * len(stems)
    elif len(gains) != len(stems):
        raise ValueError("len(gains) must equal len(stems)")

    loaded = []
    sr_first = None
    for p in stems:
        y, sr = librosa.load(p, sr=None, mono=False)
        if y.ndim == 1:
            y = np.stack([y, y])
        if sr_first is None:
            sr_first = sr
        elif sr != sr_first:
            y = librosa.resample(y, orig_sr=sr, target_sr=sr_first)
        loaded.append(y)

    min_len = min(y.shape[1] for y in loaded)
    summed = np.zeros((2, min_len), dtype=np.float32)
    for y, g in zip(loaded, gains):
        summed += y[:, :min_len].astype(np.float32) * g

    # Soft limit so a sum that overshoots 0 dBFS doesn't clip
    peak = float(np.max(np.abs(summed)))
    if peak > 0.95:
        summed *= 0.95 / peak

    sf.write(out_path, summed.T, sr_first, subtype="PCM_16")
    return {"out_path": out_path, "duration_s": min_len / sr_first}


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    sp1 = sub.add_parser("inspect")
    sp1.add_argument("path")

    sp2 = sub.add_parser("lock-to-120")
    sp2.add_argument("in_path")
    sp2.add_argument("out_path")
    sp2.add_argument("--measures", type=int, default=8)
    sp2.add_argument("--bpm", type=float, default=120.0)
    sp2.add_argument("--detected-bpm", type=float, default=None)
    sp2.add_argument("--no-normalize", action="store_true")

    sp3 = sub.add_parser("mix")
    sp3.add_argument("out_path")
    sp3.add_argument("stems", nargs="+")
    sp3.add_argument("--gains", type=float, nargs="*", default=None)

    args = p.parse_args()
    if args.cmd == "inspect":
        result = inspect(args.path)
    elif args.cmd == "lock-to-120":
        result = lock_to_120(args.in_path, args.out_path,
                             measures=args.measures, target_bpm=args.bpm,
                             detected_bpm=args.detected_bpm,
                             normalize_to_dbfs=None if args.no_normalize else -6.0)
    elif args.cmd == "mix":
        result = mix(args.stems, args.out_path, args.gains)
    else:
        raise SystemExit(f"unknown command: {args.cmd}")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
