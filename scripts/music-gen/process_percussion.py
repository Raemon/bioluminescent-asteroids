"""Post-process the new per-variation percussion stems (and the r2-el lonely
violin exception). Same invariants as process_r2/r4: trim to 32s, peak-
normalize to -12 dBFS, 50 ms edge fades, sox reverb tuned per stem timbre.

Outputs land in processed/{variation}-percussion.{wav,mp3} so the names
match Sound.ts's haloMusicUrl() expectation; the wire-in step copies them
to public/sounds/halo-music/.

Reverb settings per stem:
  r2-sb (warm/dry kit)     moderate room — kit needs a bit of air without
                           losing the dry, sparse character
  r3-el (synthwave kit)    short plate — electronic kits want tight reverb
                           or none; a touch of plate puts them "in the mix"
  r4-sb (interlocked kit)  short tight reverb so the 16ths stay articulated
                           (matches the r4-sb ambient's tight verb setting)
  r2-el (lonely violin)    moderate hall — violin wants room to breathe;
                           matches the cinematic-strings ambient/melodic
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
    # (raw, out, reverb=(reverberance, hf_damping, room_scale, pre_delay_ms))
    plan = [
        ("r2-sb-percussion", "r2-sb-percussion", (35, 65, 65, 20)),
        ("r3-el-percussion", "r3-el-percussion", (25, 60, 55, 15)),
        ("r4-sb-percussion", "r4-sb-percussion", (25, 60, 55, 15)),
        # Bumped room_scale 80→95 and pre-delay 25→35 to push the lonely
        # violin further back in the mix — it should float over the bed,
        # not sit in front of it.
        ("r2-el-percussion", "r2-el-percussion", (55, 70, 95, 35)),
    ]
    for raw, out, rev in plan:
        results.append(process_one(raw, out, rev))

    summary = PROC / "_percussion_summary.json"
    summary.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
