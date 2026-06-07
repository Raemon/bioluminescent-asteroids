"""Post-process the outerwilds-el (Outer Wilds) variation.

Three EL stems were generated at 64 seconds. We:
  1. Extract the best 32s window per stem (from find_loop_outerwilds-el.py).
  2. Snap musical attacks to the 8th-note grid (250 ms) using
     quantize_to_beat.py — guitar plucks and harmonica breaths get
     pulled onto grid via piecewise rubberband stretching.
  3. Trim to exactly 32.000s, fade edges 50ms, normalize peak to -12 dBFS.

Best 32s windows (find_loop_outerwilds-el.py):
  ambient: offset 14.00s (RMS-matched seam, not chroma-best)
  melodic: offset 7.25s
  layer3:  offset 4.75s  (v2: pump organ, replaces v1 harmonica)

Only the melodic gets quantized. The ambient is a sustained pad with
no real attacks. The layer3 (pump organ, sustained held notes) also
has no crisp attacks — running the quantizer on it created audible
clicks at piecewise-stretch segment boundaries, so it's off.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from quantize_to_beat import quantize

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
PROC = HERE / "processed"
PROC.mkdir(parents=True, exist_ok=True)

LOOP_S = 32.0
SR = 44100
BPM = 120
SUBDIV = 8  # 8th-note grid

OFFSETS = {
    "ambient": 14.0,
    "melodic": 7.25,
    "layer3": 4.75,
}

# Quantize only the melodic guitar — sustained-note instruments have
# no crisp attacks, and the piecewise rubberband stretcher creates
# audible click artifacts at segment boundaries on them.
QUANTIZE = {
    "ambient": False,
    "melodic": True,
    "layer3": False,
}

# Allow per-stem override of the raw file name (v2 pump organ replaces v1 harmonica).
RAW_NAME = {
    "ambient": "outerwilds-el-ambient.mp3",
    "melodic": "outerwilds-el-melodic.mp3",
    "layer3": "outerwilds-el-layer3-v2.mp3",
}


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
    for layer in ("ambient", "melodic", "layer3"):
        # Read 33s window (one extra second of headroom) so quantization
        # can shrink without leaving gaps at the end.
        y, sr = load_stereo(RAW / RAW_NAME[layer],
                            offset=OFFSETS[layer], duration=LOOP_S + 1.0)

        q_report = None
        if QUANTIZE[layer]:
            y_quant, q_report = quantize(y, sr, BPM, SUBDIV,
                                         max_warp_ms=60.0,
                                         max_ratio_dev=0.18)
            y = y_quant

        y = trim_or_pad(y, sr, LOOP_S)
        y = fade_edges(y, sr)
        y = normalize_peak(y, -12.0)

        entry = {"name": f"outerwilds-el-{layer}", "offset_s": OFFSETS[layer],
                 "quantized": QUANTIZE[layer],
                 **write_wav_and_mp3(y, sr, f"outerwilds-el-{layer}")}
        if q_report:
            entry["quantization_report"] = q_report
        results.append(entry)

    summary = PROC / "_r6_summary.json"
    summary.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
