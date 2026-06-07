"""Round-4 post-process: rhythmic self-built flagship (r4-sb).

Same invariants as r2/r3: trim to 32s, peak-normalize to -12 dBFS, 50 ms
edge fades. Sox reverb pass on each layer tuned for the timbre:
  - ambient: short tight reverb (25/60/55) — preserves arp punch
  - melodic: moderate plate (40/65/75) — gives the sawtooth lead air
  - sparkle: longer hall (55/70/85) — celesta wants room to bloom
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


def load_stereo(path: Path, offset: float = 0.0, duration: float | None = None):
    y, sr = librosa.load(str(path), sr=None, mono=False, offset=offset, duration=duration)
    if y.ndim == 1:
        y = np.stack([y, y])
    return y, sr


def normalize_peak(y, target_dbfs=-12.0):
    peak = float(np.max(np.abs(y)))
    if peak < 1e-9:
        return y
    return y * ((10 ** (target_dbfs / 20)) / peak)


def fade_edges(y, sr, fade_ms=50.0):
    n = int(sr * fade_ms / 1000)
    if n <= 0 or y.shape[1] < 2 * n:
        return y
    y = y.copy()
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    y[:, :n] *= ramp
    y[:, -n:] *= ramp[::-1]
    return y


def trim_or_pad(y, sr, target_s):
    target_n = int(round(target_s * sr))
    if y.shape[1] >= target_n:
        return y[:, :target_n]
    pad = np.zeros((y.shape[0], target_n - y.shape[1]), dtype=y.dtype)
    return np.concatenate([y, pad], axis=1)


def write_wav_and_mp3(y, sr, name):
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


def sox_reverb(in_wav, out_wav, reverberance, hf_damping, room_scale, pre_delay_ms=20):
    subprocess.run([
        "sox", str(in_wav), str(out_wav),
        "reverb", str(reverberance), str(hf_damping), str(room_scale),
        str(pre_delay_ms),
    ], check=True, capture_output=True)


def main():
    results = []

    # Ambient: tight reverb keeps the arp punch
    rev = RAW / "r4-sb-ambient-reverb.wav"
    sox_reverb(RAW / "r4-sb-ambient.wav", rev, 25, 60, 55, pre_delay_ms=15)
    y, sr = load_stereo(rev)
    y = trim_or_pad(y, sr, LOOP_S)
    y = fade_edges(y, sr)
    y = normalize_peak(y, -12.0)
    results.append({"name": "r4-sb-ambient", **write_wav_and_mp3(y, sr, "r4-sb-ambient")})

    # Melodic: moderate plate for the saw lead
    rev = RAW / "r4-sb-melodic-reverb.wav"
    sox_reverb(RAW / "r4-sb-melodic.wav", rev, 40, 65, 75, pre_delay_ms=25)
    y, sr = load_stereo(rev)
    y = trim_or_pad(y, sr, LOOP_S)
    y = fade_edges(y, sr)
    y = normalize_peak(y, -12.0)
    results.append({"name": "r4-sb-melodic", **write_wav_and_mp3(y, sr, "r4-sb-melodic")})

    # Sparkle: hall reverb for celesta bloom
    rev = RAW / "r4-sb-sparkle-reverb.wav"
    sox_reverb(RAW / "r4-sb-sparkle.wav", rev, 55, 70, 85, pre_delay_ms=30)
    y, sr = load_stereo(rev)
    y = trim_or_pad(y, sr, LOOP_S)
    y = fade_edges(y, sr)
    y = normalize_peak(y, -12.0)
    results.append({"name": "r4-sb-sparkle", **write_wav_and_mp3(y, sr, "r4-sb-sparkle")})

    summary = PROC / "_r4_summary.json"
    summary.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
