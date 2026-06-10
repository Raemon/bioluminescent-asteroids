"""Post-process the flagship-sb reroll + spectral-toll-sb EL stems.

flagship-sb reroll (replaces the procedural ghost lead / glass bells):
  - melodic = lush solo nylon-string guitar (cinematic, slow, reverberant)
  - layer3  = singing legato solo violin, upper register, HPF'd at 300 Hz so
              its body clears the arp + bass field

spectral-toll-sb (new Level 11-19 haunting variation):
  - ambient = deep C/G drone (bowed bass + low choir)
  - melodic = mournful solo cello
  - layer3  = procedural glass bells (already in processed/, NOT rebuilt here —
              parked as glassbells-sb-layer3 and copied to the variation name)

Standard invariants: extract best 32s window (offsets from
find_loop_flagship_reroll.py), trim to 32.000s, 50 ms edge fades, peak-normalize
to -12 dBFS, optional HPF, wav + mp3 to processed/.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy import signal

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
PROC = HERE / "processed"
PROC.mkdir(parents=True, exist_ok=True)

LOOP_S = 32.0

# (out_name, raw_filename, offset_s, hpf_hz)
STEMS = [
    ("flagship-sb-melodic", "flagship-sb-melodic-el.mp3", 10.0, 120),
    ("flagship-sb-layer3", "flagship-sb-layer3-el.mp3", 14.0, 300),
    ("spectral-toll-sb-ambient", "spectral-toll-sb-ambient.mp3", 6.0, 0),
    ("spectral-toll-sb-melodic", "spectral-toll-sb-melodic.mp3", 2.0, 0),
]


def load_stereo(path, offset, duration):
    y, sr = librosa.load(str(path), sr=None, mono=False, offset=offset, duration=duration)
    if y.ndim == 1:
        y = np.stack([y, y])
    return y, sr


def highpass(y, sr, cutoff_hz):
    if cutoff_hz <= 0:
        return y
    sos = signal.butter(4, cutoff_hz, btype="highpass", fs=sr, output="sos")
    return np.stack([signal.sosfiltfilt(sos, ch) for ch in y]).astype(y.dtype)


def trim_or_pad(y, sr, target_s):
    target_n = int(round(target_s * sr))
    if y.shape[-1] >= target_n:
        return y[..., :target_n]
    pad = np.zeros((y.shape[0], target_n - y.shape[-1]), dtype=y.dtype)
    return np.concatenate([y, pad], axis=-1)


def fade_edges(y, sr, fade_ms=50.0):
    n = int(sr * fade_ms / 1000)
    if n <= 0 or y.shape[-1] < 2 * n:
        return y
    y = y.copy()
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    y[:, :n] *= ramp
    y[:, -n:] *= ramp[::-1]
    return y


def normalize_peak(y, target_dbfs=-12.0):
    peak = float(np.max(np.abs(y)))
    if peak < 1e-9:
        return y
    return y * ((10 ** (target_dbfs / 20)) / peak)


def write_wav_and_mp3(y, sr, name):
    wav = PROC / f"{name}.wav"
    mp3 = PROC / f"{name}.mp3"
    sf.write(str(wav), y.T, sr, subtype="PCM_16")
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
        "-codec:a", "libmp3lame", "-b:a", "160k", str(mp3),
    ], check=True, capture_output=True)
    return {"wav": str(wav), "mp3": str(mp3),
            "duration_s": y.shape[-1] / sr, "channels": y.shape[0]}


def main():
    results = []
    for out_name, raw_name, offset_s, hpf_hz in STEMS:
        y, sr = load_stereo(RAW / raw_name, offset_s, LOOP_S + 1.0)
        y = highpass(y, sr, hpf_hz)
        y = trim_or_pad(y, sr, LOOP_S)
        y = fade_edges(y, sr)
        y = normalize_peak(y, -12.0)
        results.append({"name": out_name, "raw": raw_name, "offset_s": offset_s,
                        "hpf_hz": hpf_hz, **write_wav_and_mp3(y, sr, out_name)})

    # spectral-toll-sb layer3 = the parked procedural glass bells, copied to
    # the variation's stem name so the game loads it like any other layer3.
    bells = PROC / "glassbells-sb-layer3"
    for ext in (".wav", ".mp3"):
        src = bells.with_suffix(ext)
        if src.exists():
            (PROC / f"spectral-toll-sb-layer3{ext}").write_bytes(src.read_bytes())
    results.append({"name": "spectral-toll-sb-layer3",
                    "raw": "glassbells-sb-layer3 (procedural, parked)"})

    (PROC / "_flagship_reroll_summary.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
