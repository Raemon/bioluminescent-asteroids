"""Post-process the r5-el variation.

Three EL Music stems were generated at 64 seconds each (asked EL for the
32-second phrase played twice, EL ignored that and gave through-composed
64s pieces). We trim each to the best 32s window found by find_loop_r5.py,
fade the edges so the loop seam doesn't click, and peak-normalize to
-12 dBFS so the bass field stays dominant.

Best 32s windows (from find_loop_r5.py):
  ambient: offset 3.5s
  melodic: offset 12.5s
  layer3:  offset 0.5s

Same invariants as process_r3 — trim to 32s, 50 ms edge fades, normalize
peak to -12 dBFS. No sox reverb pass (EL output is already reverby).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
PROC = HERE / "processed"
PROC.mkdir(parents=True, exist_ok=True)

LOOP_S = 32.0
SR = 44100

OFFSETS = {
    "ambient": 3.5,
    "melodic": 12.5,
    "layer3": 0.5,
}


def load_stereo(path: Path, offset: float = 0.0, duration: float | None = None):
    y, sr = librosa.load(str(path), sr=None, mono=False, offset=offset, duration=duration)
    if y.ndim == 1:
        y = np.stack([y, y])
    return y, sr


def normalize_peak(y: np.ndarray, target_dbfs: float = -12.0) -> np.ndarray:
    peak = float(np.max(np.abs(y)))
    if peak < 1e-9:
        return y
    return y * ((10 ** (target_dbfs / 20)) / peak)


def fade_edges(y: np.ndarray, sr: int, fade_ms: float = 50.0) -> np.ndarray:
    n = int(sr * fade_ms / 1000)
    if n <= 0 or y.shape[1] < 2 * n:
        return y
    y = y.copy()
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    y[:, :n] *= ramp
    y[:, -n:] *= ramp[::-1]
    return y


def trim_or_pad(y: np.ndarray, sr: int, target_s: float) -> np.ndarray:
    target_n = int(round(target_s * sr))
    if y.shape[1] >= target_n:
        return y[:, :target_n]
    pad = np.zeros((y.shape[0], target_n - y.shape[1]), dtype=y.dtype)
    return np.concatenate([y, pad], axis=1)


def write_wav_and_mp3(y: np.ndarray, sr: int, name: str) -> dict:
    wav = PROC / f"{name}.wav"
    mp3 = PROC / f"{name}.mp3"
    sf.write(str(wav), y.T, sr, subtype="PCM_16")
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(wav),
        "-codec:a", "libmp3lame", "-b:a", "160k",
        str(mp3),
    ], check=True, capture_output=True)
    return {"wav": str(wav), "mp3": str(mp3),
            "duration_s": y.shape[1] / sr, "channels": y.shape[0]}


def main():
    results = []
    for layer, offset in OFFSETS.items():
        y, sr = load_stereo(RAW / f"r5-el-{layer}.mp3", offset=offset, duration=LOOP_S + 0.1)
        y = trim_or_pad(y, sr, LOOP_S)
        y = fade_edges(y, sr)
        y = normalize_peak(y, -12.0)
        results.append({"name": f"r5-el-{layer}", "offset_s": offset,
                        **write_wav_and_mp3(y, sr, f"r5-el-{layer}")})

    summary = PROC / "_r5_summary.json"
    summary.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
