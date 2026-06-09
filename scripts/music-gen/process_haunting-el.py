"""Post-process the three haunting-el variations for the level-11–19 arc.

Three variations × 3 stems = 9 ElevenLabs raw clips at 64s each. For each:
  1. Extract the best 32s window (offsets picked by find_loop_haunting-el.py).
  2. Trim to exactly 32.000s @ 44.1 kHz stereo.
  3. Fade edges 50 ms for clean loop seam.
  4. Peak-normalize to -12 dBFS.
  5. Optional HPF where a layer leaks bass content into the bass-field's range.

Window offsets (downbeat-aligned, top-of-the-scoreboard from find_loop):
  cathedral-hymn-el-ambient    offset 2.0s
  cathedral-hymn-el-melodic    offset 28.0s
  cathedral-hymn-el-layer3     offset 20.0s  (low monastic male chant)
  lost-transmission-el-ambient offset 16.0s
  lost-transmission-el-melodic offset 26.0s  (using v2 — v1 was Bb-rooted)
  lost-transmission-el-layer3  offset 20.0s  (whispered breaths + crackle)
  underwater-requiem-el-ambient offset 18.0s
  underwater-requiem-el-melodic offset 24.0s
  underwater-requiem-el-layer3  offset 18.0s (celesta countermelody)

No quantization — these are all slow held-tone stems where the EL natural
timing reads musical, and the quantizer's rubberband stretch tends to click
on diffuse attacks (lesson learned in outerwilds-el).
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
SR = 44100

STEMS = [
    # (variation, layer, raw_filename, offset_s, hpf_hz)
    ("cathedral-hymn-el", "ambient", "cathedral-hymn-el-ambient.mp3", 2.0, 0),
    ("cathedral-hymn-el", "melodic", "cathedral-hymn-el-melodic.mp3", 28.0, 0),
    ("cathedral-hymn-el", "layer3", "cathedral-hymn-el-layer3.mp3", 20.0, 0),
    ("lost-transmission-el", "ambient", "lost-transmission-el-ambient.mp3", 16.0, 0),
    ("lost-transmission-el", "melodic", "lost-transmission-el-melodic-v2.mp3", 26.0, 0),
    ("lost-transmission-el", "layer3", "lost-transmission-el-layer3.mp3", 20.0, 0),
    ("underwater-requiem-el", "ambient", "underwater-requiem-el-ambient.mp3", 18.0, 0),
    ("underwater-requiem-el", "melodic", "underwater-requiem-el-melodic.mp3", 24.0, 0),
    ("underwater-requiem-el", "layer3", "underwater-requiem-el-layer3.mp3", 18.0, 500),
]


def load_stereo(path: Path, offset: float, duration: float):
    y, sr = librosa.load(str(path), sr=None, mono=False,
                         offset=offset, duration=duration)
    if y.ndim == 1:
        y = np.stack([y, y])
    return y, sr


def trim_or_pad(y: np.ndarray, sr: int, target_s: float) -> np.ndarray:
    target_n = int(round(target_s * sr))
    if y.shape[-1] >= target_n:
        return y[..., :target_n]
    pad_shape = list(y.shape)
    pad_shape[-1] = target_n - y.shape[-1]
    pad = np.zeros(pad_shape, dtype=y.dtype)
    return np.concatenate([y, pad], axis=-1)


def fade_edges(y: np.ndarray, sr: int, fade_ms: float = 50.0) -> np.ndarray:
    n = int(sr * fade_ms / 1000)
    if n <= 0 or y.shape[-1] < 2 * n:
        return y
    y = y.copy()
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    if y.ndim == 1:
        y[:n] *= ramp
        y[-n:] *= ramp[::-1]
    else:
        y[:, :n] *= ramp
        y[:, -n:] *= ramp[::-1]
    return y


def highpass(y: np.ndarray, sr: int, cutoff_hz: float) -> np.ndarray:
    if cutoff_hz <= 0:
        return y
    sos = signal.butter(4, cutoff_hz, btype="highpass", fs=sr, output="sos")
    if y.ndim == 1:
        return signal.sosfiltfilt(sos, y).astype(y.dtype)
    return np.stack([signal.sosfiltfilt(sos, ch) for ch in y]).astype(y.dtype)


def normalize_peak(y: np.ndarray, target_dbfs: float = -12.0) -> np.ndarray:
    peak = float(np.max(np.abs(y)))
    if peak < 1e-9:
        return y
    return y * ((10 ** (target_dbfs / 20)) / peak)


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
            "duration_s": y.shape[-1] / sr, "channels": y.shape[0]}


def main():
    results = []
    for variation, layer, raw_name, offset_s, hpf_hz in STEMS:
        # 33s window (one extra second of headroom) so trim has slack.
        y, sr = load_stereo(RAW / raw_name, offset=offset_s, duration=LOOP_S + 1.0)
        y = highpass(y, sr, hpf_hz)
        y = trim_or_pad(y, sr, LOOP_S)
        y = fade_edges(y, sr)
        y = normalize_peak(y, -12.0)
        out_name = f"{variation}-{layer}"
        entry = {"name": out_name, "raw": raw_name, "offset_s": offset_s,
                 "hpf_hz": hpf_hz,
                 **write_wav_and_mp3(y, sr, out_name)}
        results.append(entry)

    summary = PROC / "_haunting_summary.json"
    summary.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
