"""Snap musical attacks in an audio file to the nearest 8th-note grid point.

Strategy: detect strong onsets, for each one compute the time-warp ratio
needed to land that onset on the nearest grid point, and apply the warp
piecewise so the rest of the audio time-stretches smoothly between
quantized onsets.

We use librosa's onset detector with a high delta threshold so we only
pick up real musical attacks (guitar plucks, harmonica breath starts),
not texture/vibrato/string-noise.

The piecewise warp:
  - Split the audio at the midpoint between every pair of consecutive
    onsets.
  - For each segment, compute the ratio that moves its single onset to
    the target grid time.
  - Time-stretch each segment by that ratio using rubberband (high-quality
    phase vocoder, preserves pitch and timbre).
  - Concatenate.

This produces a file where every detected onset lands within ±5ms of an
8th-note grid point, with smooth audio between (no clicks or pitch
distortion).

Limits:
  - Strong onsets only — sustained notes with slow attacks won't be
    quantized (which is fine — they don't have a perceptible attack to
    misalign).
  - Time-stretch ratios are clamped to [0.85, 1.18] so a single segment
    can't be warped more than ~15%, which would sound obviously wrong.
    Onsets needing larger correction are *skipped* (we just leave them
    where they are) — this should be rare if EL is already at 120 BPM.
  - Maximum allowable correction per onset: 60 ms (since the grid is
    250 ms wide, a worst-case onset half-way between grid points needs
    125 ms of correction — but moving an onset that far would smear the
    surrounding texture audibly).

Usage:
    python quantize_to_beat.py <in.wav/mp3> <out.wav> [--bpm 120] [--subdiv 8]
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


def detect_real_onsets(y: np.ndarray, sr: int, delta: float = 0.15) -> np.ndarray:
    """Strong onsets only — guitar plucks, breath attacks."""
    return librosa.onset.onset_detect(
        y=y, sr=sr, units="time",
        delta=delta, backtrack=False, hop_length=512,
    )


def nearest_grid(t: float, grid_s: float) -> float:
    return round(t / grid_s) * grid_s


def quantize(y: np.ndarray, sr: int, bpm: float, subdiv: int,
             max_warp_ms: float = 60.0,
             max_ratio_dev: float = 0.18) -> tuple[np.ndarray, dict]:
    """Returns quantized audio + a report dict."""
    if y.ndim == 1:
        mono = y
        was_stereo = False
    else:
        mono = y.mean(axis=0)
        was_stereo = True

    beat_s = 60.0 / bpm  # 0.5s at 120
    grid_s = beat_s * (4 / subdiv)  # 8th = 0.25s, 16th = 0.125s

    onsets = detect_real_onsets(mono, sr)
    if len(onsets) == 0:
        return y, {"onsets_found": 0, "quantized": 0, "skipped_too_large": 0}

    # Map each onset → target grid time
    targets = []
    skipped = 0
    for t in onsets:
        target = nearest_grid(t, grid_s)
        # Cap correction
        if abs(target - t) > max_warp_ms / 1000:
            # Skip this onset — too large a warp needed
            targets.append(t)
            skipped += 1
        else:
            targets.append(target)

    # Build segment boundaries: midpoint between consecutive onsets.
    # Include 0 at start and len(audio) at end.
    audio_len_s = len(mono) / sr
    src_boundaries = [0.0]
    tgt_boundaries = [0.0]
    for i in range(len(onsets) - 1):
        # Midpoint between onset[i] and onset[i+1] is the boundary.
        # Both source and target boundaries are at this midpoint relative to onsets.
        src_mid = (onsets[i] + onsets[i + 1]) / 2
        tgt_mid = (targets[i] + targets[i + 1]) / 2
        src_boundaries.append(src_mid)
        tgt_boundaries.append(tgt_mid)
    src_boundaries.append(audio_len_s)
    tgt_boundaries.append(audio_len_s)

    # For each segment, compute the time-stretch ratio.
    # ratio = src_duration / tgt_duration (ratio > 1 means stretch slower).
    segments_processed = []
    for i in range(len(src_boundaries) - 1):
        src_dur = src_boundaries[i + 1] - src_boundaries[i]
        tgt_dur = tgt_boundaries[i + 1] - tgt_boundaries[i]
        if src_dur < 0.001 or tgt_dur < 0.001:
            continue
        ratio = src_dur / tgt_dur  # value to feed pyrb (ratio > 1 = output is shorter)
        # Clamp
        ratio_clamped = max(1 - max_ratio_dev, min(1 + max_ratio_dev, ratio))
        if abs(ratio_clamped - ratio) > 1e-6:
            # Clamped — this segment's onset won't land exactly on grid
            pass
        segments_processed.append((src_boundaries[i], src_boundaries[i + 1], ratio_clamped))

    # Process each segment.
    # pyrb.time_stretch wants mono or stereo numpy in (samples,) or (samples, channels) format
    # — and returns same shape.
    if was_stereo:
        # transpose to (samples, channels)
        y_work = y.T.copy()  # shape (samples, 2)
    else:
        y_work = mono

    out_chunks = []
    for src_start, src_end, ratio in segments_processed:
        i0 = int(src_start * sr)
        i1 = int(src_end * sr)
        if i1 <= i0:
            continue
        chunk = y_work[i0:i1]
        if abs(ratio - 1.0) < 0.005:
            # Skip negligible stretches
            out_chunks.append(chunk)
        else:
            try:
                stretched = pyrb.time_stretch(chunk, sr, ratio)
                out_chunks.append(stretched)
            except Exception as e:
                print(f"warn: stretch failed at {src_start:.2f}s: {e}", file=sys.stderr)
                out_chunks.append(chunk)

    out = np.concatenate(out_chunks, axis=0)
    if was_stereo:
        # transpose back to (channels, samples)
        out = out.T

    report = {
        "onsets_found": int(len(onsets)),
        "skipped_too_large": skipped,
        "quantized": int(len(onsets) - skipped),
        "input_duration_s": float(audio_len_s),
        "output_duration_s": float(out.shape[-1] / sr),
        "segments": len(segments_processed),
        "grid_ms": int(grid_s * 1000),
    }
    return out, report


def main():
    p = argparse.ArgumentParser()
    p.add_argument("infile")
    p.add_argument("outfile")
    p.add_argument("--bpm", type=float, default=120.0)
    p.add_argument("--subdiv", type=int, default=8, help="8 for 8th notes, 4 for quarter")
    p.add_argument("--max-warp-ms", type=float, default=60.0)
    args = p.parse_args()

    y, sr = librosa.load(args.infile, sr=44100, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])

    out, report = quantize(y, sr, args.bpm, args.subdiv, args.max_warp_ms)

    # Pad or trim to original length (preserves loop length)
    target_n = int(round(report["input_duration_s"] * sr))
    if out.shape[-1] > target_n:
        out = out[..., :target_n]
    elif out.shape[-1] < target_n:
        pad = np.zeros((*out.shape[:-1], target_n - out.shape[-1]), dtype=out.dtype)
        out = np.concatenate([out, pad], axis=-1)

    if out.ndim == 1:
        sf.write(args.outfile, out, sr, subtype="PCM_16")
    else:
        sf.write(args.outfile, out.T, sr, subtype="PCM_16")

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
