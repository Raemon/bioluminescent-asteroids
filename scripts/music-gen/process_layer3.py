"""Post-process the new per-variation layer-3 stems.

Same invariants as process_r2/r4: trim to 32s, peak-normalize to -12 dBFS,
50 ms edge fades, sox reverb tuned per stem timbre.

Outputs land in processed/{variation}-layer3.{wav,mp3} so the names match
Sound.ts's haloMusicUrl() expectation; the wire-in step copies them to
public/sounds/halo-music/.

Reverb settings per stem:
  r2-sb (felt glockenspiel)   long warm hall — bells want room to ring
  r3-el (synth-bass arp)      short plate — synth-bass wants tight low end
                              so it doesn't smear the kick register
  r4-sb (counter-melody glock) short tight reverb so chime notes stay
                              articulated and interlock cleanly with the
                              arp's 16ths
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


def process_one(raw_name: str, out_name: str,
                reverb: tuple[int, int, int, int]) -> dict:
    rev_path = RAW / f"{raw_name}-reverb.wav"
    sox_reverb(RAW / f"{raw_name}.wav", rev_path, *reverb)
    y, sr = load_stereo(rev_path)
    y = trim_or_pad(y, sr, LOOP_S)
    y = fade_edges(y, sr)
    y = normalize_peak(y, -12.0)
    return {"name": out_name, **write_wav_and_mp3(y, sr, out_name)}


def main():
    results = []
    plan = [
        # r2-sb glock: long warm hall lets the bell tones ring into each other
        ("r2-sb-layer3", "r2-sb-layer3", (55, 65, 80, 30)),
        # r3-el synth-bass: tight short plate — keep low end articulate
        ("r3-el-layer3", "r3-el-layer3", (15, 50, 40, 10)),
        # r4-sb counter-glock: short tight verb — must interlock with arp
        ("r4-sb-layer3", "r4-sb-layer3", (25, 60, 50, 15)),
    ]
    for raw, out, rev in plan:
        results.append(process_one(raw, out, rev))

    summary = PROC / "_layer3_summary.json"
    summary.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
