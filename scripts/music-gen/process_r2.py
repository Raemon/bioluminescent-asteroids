"""Round-2 post-process pipeline.

Stems are now 32 seconds (was 8s in round 1) at 120 BPM = 4 phrases × 4 bars.
Adjusted targets based on the in-game-mix audit:
  - Peak normalized to -12 dBFS (was -6 dBFS — leaves headroom, closer to
    the loudness the bed-ambient reference sits at)
  - 50 ms fade-in / 50 ms fade-out at the very edges (longer fades than r1
    because the loop length is 4x bigger and edge clicks become more
    noticeable when they're 1/32th of the cycle vs 1/8th)
  - EL melodic stem: trim from offset 32s for 32s (the first 32s came back
    as silence)
  - Self-built melodic: trim to 32s exactly (FluidSynth left tail reverb)
  - Run self-built stems through sox reverb post-process for spatial depth

Output naming: r2-{el,sb}-{ambient,melodic}.{wav,mp3}
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


def sox_reverb(in_wav: Path, out_wav: Path,
               reverberance: int = 35, hf_damping: int = 70,
               room_scale: int = 80) -> None:
    """Apply sox's room-emulation reverb. Defaults give a moderate hall —
    enough to take the dryness off the FluidSynth + procedural pads."""
    subprocess.run([
        "sox", str(in_wav), str(out_wav),
        "reverb", str(reverberance), str(hf_damping), str(room_scale),
    ], check=True, capture_output=True)


def main():
    results = []

    # --- EL ambient ---
    y, sr = load_stereo(RAW / "r2-cinematic-ambient.mp3")
    y = trim_or_pad(y, sr, LOOP_S)
    y = fade_edges(y, sr)
    y = normalize_peak(y, -12.0)
    results.append({"name": "cinematic-el-ambient", **write_wav_and_mp3(y, sr, "cinematic-el-ambient")})

    # --- EL melodic: trim from 32s for 32s (first 32s came back as silence) ---
    y, sr = load_stereo(RAW / "r2-cinematic-melodic.mp3", offset=32.0, duration=LOOP_S)
    y = trim_or_pad(y, sr, LOOP_S)
    y = fade_edges(y, sr)
    y = normalize_peak(y, -12.0)
    results.append({"name": "cinematic-el-melodic", **write_wav_and_mp3(y, sr, "cinematic-el-melodic")})

    # --- Self-built ambient: reverb pass ---
    reverbed = RAW / "r2-ambient-reverb.wav"
    sox_reverb(RAW / "r2-ambient.wav", reverbed)
    y, sr = load_stereo(reverbed)
    y = trim_or_pad(y, sr, LOOP_S)
    y = fade_edges(y, sr)
    y = normalize_peak(y, -12.0)
    results.append({"name": "musicbox-sb-ambient", **write_wav_and_mp3(y, sr, "musicbox-sb-ambient")})

    # --- Self-built melodic: reverb pass, then trim ---
    reverbed = RAW / "r2-melodic-reverb.wav"
    sox_reverb(RAW / "r2-melodic.wav", reverbed)
    y, sr = load_stereo(reverbed)
    y = trim_or_pad(y, sr, LOOP_S)
    y = fade_edges(y, sr)
    y = normalize_peak(y, -12.0)
    results.append({"name": "musicbox-sb-melodic", **write_wav_and_mp3(y, sr, "musicbox-sb-melodic")})

    summary = PROC / "_r2_summary.json"
    summary.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
