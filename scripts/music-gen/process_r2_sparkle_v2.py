"""Post-process the 16th-note arp sparkle v2 stems.

Same shape as process_r2_sparkle.py but with reverb settings tuned for the
denser 16th-note material (heavy hall on dense arps blurs the rhythmic
read — we want clarity, not wash):

  r2-el-sparkle  New Age synth + halo wash. Mild plate-ish reverb so the
                 arp reads as cinematic-synthwave, not concert hall. The
                 wash voices already provide the "atmospheric depth".

  r2-sb-sparkle  Steel-string fast-pluck. Light reverb so the 16ths stay
                 articulated. Heavier reverb than EL since SB has no wash
                 underneath providing ambience.

Outputs: r2-{el,sb}-sparkle.{wav,mp3} in processed/ (overwrites the v1 files).
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
               reverberance: int, hf_damping: int, room_scale: int,
               pre_delay_ms: int = 25) -> None:
    subprocess.run([
        "sox", str(in_wav), str(out_wav),
        "reverb", str(reverberance), str(hf_damping), str(room_scale),
        str(pre_delay_ms),
    ], check=True, capture_output=True)


def main():
    results = []

    # --- r2-sb-sparkle: steel-string fast-pluck — moderate reverb ---
    rev = RAW / "r2-sparkle-sb-v2-reverb.wav"
    sox_reverb(RAW / "r2-sparkle-sb-v2.wav", rev,
               reverberance=40, hf_damping=65, room_scale=75, pre_delay_ms=25)
    y, sr = load_stereo(rev)
    y = trim_or_pad(y, sr, LOOP_S)
    y = fade_edges(y, sr)
    y = normalize_peak(y, -12.0)
    results.append({"name": "r2-sb-sparkle",
                    **write_wav_and_mp3(y, sr, "r2-sb-sparkle")})

    # --- r2-el-sparkle: New Age synth + halo wash — mild reverb ---
    rev = RAW / "r2-sparkle-el-v2-reverb.wav"
    sox_reverb(RAW / "r2-sparkle-el-v2.wav", rev,
               reverberance=30, hf_damping=70, room_scale=60, pre_delay_ms=20)
    y, sr = load_stereo(rev)
    y = trim_or_pad(y, sr, LOOP_S)
    y = fade_edges(y, sr)
    y = normalize_peak(y, -12.0)
    results.append({"name": "r2-el-sparkle",
                    **write_wav_and_mp3(y, sr, "r2-el-sparkle")})

    summary = PROC / "_r2_sparkle_v2_summary.json"
    summary.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
