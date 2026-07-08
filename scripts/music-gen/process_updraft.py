"""Process the updraft-el streak-music stems: pick the best 16s loop window
out of each 120-locked ElevenLabs source, splice the seam with an equal-power
crossfade, highpass away the register the bass field owns, and land wav+mp3
in processed/.

The streak slot layers on TOP of both the bass field and any playing halo
music, so unlike halo stems these are aggressively highpassed — the pad's
body would otherwise sit right in the 200-500 Hz band the bass field owns.

Window scoring mirrors find_loop_vaporwave-el.py (seam mel-cosine +
chroma fit + level steadiness) but with sus2-friendly chroma weights: the
base stem intentionally leans C-D-G, so D is a favored pitch class here,
not a penalized one.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import librosa
import numpy as np
from scipy.signal import butter, sosfiltfilt

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
PROC = HERE / "processed"

SR = 44100
LOOP_S = 16.0
LOOP_N = int(SR * LOOP_S)
STEP_S = 0.5           # search on the beat grid
SEAM_XFADE_S = 0.25    # equal-power splice length at the loop point
EDGE_FADE_S = 0.05     # house invariant: 50 ms edge fades
PEAK_DBFS = -12.0

# Favored pitch classes for a C-D-G sus colour over the C-major bass bed.
FAVOR = np.array([1.0, 0, 0.6, 0, 0.6, 0, 0, 1.0, 0, 0, 0, 0.4])
#                  C  C#   D  Eb   E   F  F#   G  G#   A  A#   B
PENALTY = np.array([0, 0.5, 0, 0.2, 0, 1.0, 0.5, 0, 0.5, 0.4, 0.4, 0])


def mel_vec(y: np.ndarray, sr: int) -> np.ndarray:
    m = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=32).mean(axis=1)
    n = np.linalg.norm(m)
    return m / n if n > 0 else m


def score_window(mono: np.ndarray, sr: int, start_n: int) -> dict:
    w = mono[start_n : start_n + LOOP_N]
    seam_n = int(sr * 0.5)
    seam = float(np.dot(mel_vec(w[:seam_n], sr), mel_vec(w[-seam_n:], sr)))
    chroma = librosa.feature.chroma_cqt(y=w, sr=sr).mean(axis=1)
    chroma = chroma / (chroma.max() + 1e-9)
    fit = float((chroma * FAVOR).sum() - (chroma * PENALTY).sum())
    head_rms = float(np.sqrt(np.mean(w[: sr * 2] ** 2)))
    tail_rms = float(np.sqrt(np.mean(w[-sr * 2 :] ** 2)))
    mid_rms = float(np.sqrt(np.mean(w**2)))
    # steady = head and tail at similar level, and the window not near-silent.
    steady = min(head_rms, tail_rms) / (max(head_rms, tail_rms) + 1e-9)
    level_ok = min(1.0, mid_rms / 0.03)
    return {
        "seam": seam,
        "fit": fit,
        "steady": steady,
        "level": level_ok,
        "score": seam * 1.0 + fit * 0.5 + steady * 0.8 + level_ok * 0.5,
    }


def grid_phase(mono: np.ndarray, sr: int) -> tuple[float, float]:
    """Phase in [0, 0.5) whose 0.5s comb best catches the onsets, plus the
    on-grid/off-grid energy contrast (a low contrast means the material has
    no real pulse and the phase is cosmetic)."""
    hop = 512
    env = librosa.onset.onset_strength(y=mono, sr=sr, hop_length=hop)
    t = librosa.frames_to_time(np.arange(len(env)), sr=sr, hop_length=hop)
    phases = np.arange(0, 0.5, 0.01)
    strength = np.array([
        env[(np.abs(((t - p) % 0.5 + 0.25) % 0.5 - 0.25) < 0.03)].sum() for p in phases
    ])
    best = float(phases[int(strength.argmax())])
    contrast = float(strength.max() / (strength.mean() + 1e-9))
    return best, contrast


def find_best_window(path: Path) -> tuple[int, dict]:
    mono, sr = librosa.load(str(path), sr=SR, mono=True)
    # Candidate starts sit ON the source's own beat grid, so the loop's first
    # sample is a beat and the game's beat-aligned .start() keeps it in time.
    phase, contrast = grid_phase(mono, sr)
    max_start = len(mono) - LOOP_N - int(SEAM_XFADE_S * sr) - 1
    best = None
    step_n = int(STEP_S * SR)
    first = int((2.0 + phase) * sr)
    for start_n in range(first, max_start, step_n):
        s = score_window(mono, sr, start_n)
        if best is None or s["score"] > best[1]["score"]:
            best = (start_n, s)
    assert best is not None
    best[1]["grid_phase_s"] = phase
    best[1]["grid_contrast"] = contrast
    return best


def splice_loop(y: np.ndarray, sr: int, start_n: int) -> np.ndarray:
    """Cut [start, start+16s) and equal-power blend the head with the audio
    that naturally follows the cut, so sample N-1 -> sample 0 is continuous."""
    xf = int(SEAM_XFADE_S * sr)
    w = y[:, start_n : start_n + LOOP_N + xf]
    out = w[:, :LOOP_N].copy()
    theta = np.linspace(0, np.pi / 2, xf)
    out[:, :xf] = w[:, LOOP_N : LOOP_N + xf] * np.cos(theta) + w[:, :xf] * np.sin(theta)
    return out


def highpass(y: np.ndarray, sr: int, fc: float) -> np.ndarray:
    sos = butter(4, fc, btype="highpass", fs=sr, output="sos")
    return sosfiltfilt(sos, y, axis=1)


def normalize_peak(y: np.ndarray, dbfs: float) -> np.ndarray:
    peak = np.abs(y).max()
    return y * (10 ** (dbfs / 20) / (peak + 1e-12))


def fade_edges(y: np.ndarray, sr: int) -> np.ndarray:
    n = int(EDGE_FADE_S * sr)
    env = np.ones(y.shape[1])
    env[:n] = np.linspace(0, 1, n)
    env[-n:] = np.linspace(1, 0, n)
    return y * env


def write_wav_and_mp3(y: np.ndarray, sr: int, name: str) -> dict:
    import soundfile as sf

    PROC.mkdir(exist_ok=True)
    wav = PROC / f"{name}.wav"
    mp3 = PROC / f"{name}.mp3"
    sf.write(str(wav), y.T, sr)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
         "-codec:a", "libmp3lame", "-b:a", "160k", str(mp3)],
        check=True,
    )
    return {"wav": str(wav), "mp3": str(mp3)}


def process(src: Path, name: str, hpf_hz: float) -> dict:
    start_n, scores = find_best_window(src)
    y, sr = librosa.load(str(src), sr=SR, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    out = splice_loop(y, sr, start_n)
    out = highpass(out, sr, hpf_hz)
    out = fade_edges(out, sr)
    out = normalize_peak(out, PEAK_DBFS)
    files = write_wav_and_mp3(out, sr, name)
    return {
        "name": name,
        "window_start_s": start_n / SR,
        "hpf_hz": hpf_hz,
        **scores,
        **files,
    }


def main() -> None:
    results = [
        process(RAW / "updraft-el-base-120.wav", "updraft-el-base", 500.0),
        process(RAW / "updraft-el-rise-120.wav", "updraft-el-rise", 400.0),
    ]
    summary = PROC / "_updraft-el_summary.json"
    summary.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
