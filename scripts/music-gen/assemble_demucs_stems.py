"""Assemble the 3 game stems from a Demucs-split source.

Maps htdemucs {drums, other, vocals} (bass is dropped — the game owns the
low end with its own C-major drone) onto the combo tiers. Per the
levels-1-9 design decision, melodic stays a *lead* (not drums) and the
beat is the 12x reward:

  ambient (>=4)  = `other`, low/mid bed   : HPF 150 Hz, LPF ~2 kHz  -> a pad
  melodic (>=6)  = `other` bright lead + vocals : HPF ~400 Hz       -> the lead
  layer3  (>=12) = `drums`                : HPF 130 Hz (kill kick)   -> the beat

When the source is a single EL/Udio/Suno track, ambient and melodic both
come from `other`, split by frequency (bed vs lead). Vocals are summed into
melodic only if they carry real content (peak > -40 dBFS); otherwise the
instrumental's near-empty vocals stem is ignored.

All three stems use the SAME loop offset (from find_loop_demucs.py on the
`other` stem) so they stay phase-locked when the runtime starts them
together at sample 0. Post-chain mirrors process_haunting-el.py: slice
window -> HPF/LPF -> trim -> 50 ms fades -> peak-normalize -12 dBFS ->
wav + 160k mp3 into processed/.

Edit CONFIG below for the track, then:
  venv/bin/python assemble_demucs_stems.py
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

LOOP_S = 64.0
SR = 44100

# --- per-track config -------------------------------------------------------
# variation : output name (also the shipped {variation}-{layer}.mp3 prefix)
# demucs_dir: raw/demucs/htdemucs/<source-stem-name>/
# offset_s  : the winning window start from find_loop_demucs.py (a 2.0s multiple)
VARIATION = "tidewatch-el"
DEMUCS_DIR = RAW / "demucs" / "htdemucs" / "tidewatch-el-source"
OFFSET_S = 0.0  # <-- set from find_loop_demucs.py before the final run

# Frequency split that turns one `other` stem into bed (ambient) + lead (melodic).
AMBIENT_HPF = 150.0
AMBIENT_LPF = 2000.0
MELODIC_HPF = 400.0
LAYER3_HPF = 130.0  # drums: drop the kick fundamental so it doesn't fight 60-200 Hz
VOCALS_FLOOR_DBFS = -40.0  # below this, treat the vocals stem as bleed/empty
# ---------------------------------------------------------------------------


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
    y[:, :n] *= ramp
    y[:, -n:] *= ramp[::-1]
    return y


def butter_filt(y: np.ndarray, sr: int, cutoff_hz: float, btype: str) -> np.ndarray:
    if cutoff_hz <= 0:
        return y
    sos = signal.butter(4, cutoff_hz, btype=btype, fs=sr, output="sos")
    return np.stack([signal.sosfiltfilt(sos, ch) for ch in y]).astype(y.dtype)


def highpass(y, sr, hz):
    return butter_filt(y, sr, hz, "highpass")


def lowpass(y, sr, hz):
    return butter_filt(y, sr, hz, "lowpass")


def peak_dbfs(y: np.ndarray) -> float:
    peak = float(np.max(np.abs(y)))
    return -120.0 if peak < 1e-9 else 20.0 * np.log10(peak)


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
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
        "-codec:a", "libmp3lame", "-b:a", "160k", str(mp3),
    ], check=True, capture_output=True)
    return {"wav": str(wav), "mp3": str(mp3),
            "duration_s": round(y.shape[-1] / sr, 3), "channels": y.shape[0]}


def finish(y: np.ndarray, sr: int, name: str) -> dict:
    y = trim_or_pad(y, sr, LOOP_S)
    y = fade_edges(y, sr)
    y = normalize_peak(y, -12.0)
    return {"name": name, **write_wav_and_mp3(y, sr, name)}


def main():
    other_path = DEMUCS_DIR / "other.wav"
    drums_path = DEMUCS_DIR / "drums.wav"
    vocals_path = DEMUCS_DIR / "vocals.wav"
    for p in (other_path, drums_path):
        if not p.exists():
            raise SystemExit(f"missing stem: {p} (run separate_stems.py first)")

    dur = LOOP_S + 1.0  # 1 s headroom for trim
    other, sr = load_stereo(other_path, OFFSET_S, dur)
    drums, _ = load_stereo(drums_path, OFFSET_S, dur)

    # ambient = the harmonic bed: lowpassed `other`.
    ambient = lowpass(highpass(other, sr, AMBIENT_HPF), sr, AMBIENT_LPF)

    # melodic = the lead: highpassed `other`, plus vocals if they carry content.
    melodic = highpass(other, sr, MELODIC_HPF)
    voc_db = None
    if vocals_path.exists():
        vocals, _ = load_stereo(vocals_path, OFFSET_S, dur)
        voc_db = peak_dbfs(vocals)
        if voc_db > VOCALS_FLOOR_DBFS:
            n = min(melodic.shape[-1], vocals.shape[-1])
            melodic = melodic[..., :n] + highpass(vocals, sr, MELODIC_HPF)[..., :n]

    # layer3 = the beat: highpassed drums (kick fundamental removed).
    layer3 = highpass(drums, sr, LAYER3_HPF)

    results = [
        finish(ambient, sr, f"{VARIATION}-ambient"),
        finish(melodic, sr, f"{VARIATION}-melodic"),
        finish(layer3, sr, f"{VARIATION}-layer3"),
    ]
    summary = {
        "variation": VARIATION, "offset_s": OFFSET_S, "loop_s": LOOP_S,
        "vocals_peak_dbfs": None if voc_db is None else round(voc_db, 1),
        "vocals_used": bool(voc_db is not None and voc_db > VOCALS_FLOOR_DBFS),
        "stems": results,
    }
    (PROC / f"_{VARIATION}_summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
