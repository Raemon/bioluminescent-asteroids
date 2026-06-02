"""Sum the r2-el ambient + melodic + new violin at game-realistic gains and
analyze the result. Substitutes for ears: if the spectrum makes sense and
the violin shows up at the right times without smashing the bed, we're OK.

Game gain for r2-el is haloMusicGain (Sound.ts) — about 0.35 for ambient,
0.40 for melodic. Violin layer (layer3) target gain we set in Sound.ts.
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np
import soundfile as sf
import librosa

HERE = Path(__file__).resolve().parent
PUB = HERE.parent.parent / "public" / "sounds" / "halo-music"
SR = 44100


def load(path: Path):
    y, sr = librosa.load(str(path), sr=SR, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    return y


def band_rms_db(y: np.ndarray, sr: int) -> dict[str, float]:
    bands = {
        "sub_20-60": (20, 60),
        "bass_60-200": (60, 200),
        "lo_mid_200-500": (200, 500),
        "mid_500-2k": (500, 2000),
        "hi_mid_2k-6k": (2000, 6000),
        "air_6k-16k": (6000, 16000),
    }
    mono = y.mean(axis=0)
    n_fft = 8192
    hop = 2048
    S = np.abs(librosa.stft(mono, n_fft=n_fft, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    out = {}
    for name, (lo, hi) in bands.items():
        mask = (freqs >= lo) & (freqs < hi)
        if not mask.any():
            out[name] = -120.0
            continue
        E = (S[mask] ** 2).mean()
        out[name] = float(10 * np.log10(E + 1e-12))
    return out


def main(violin_path: str, violin_gain: float = 0.30):
    ambient = load(PUB / "r2-el-ambient.mp3")
    melodic = load(PUB / "r2-el-melodic.mp3")
    violin = load(Path(violin_path))

    # Match lengths
    n = min(ambient.shape[1], melodic.shape[1], violin.shape[1])
    ambient = ambient[:, :n]
    melodic = melodic[:, :n]
    violin = violin[:, :n]

    # Game-realistic gains (Sound.ts haloMusicGain for r2-el is ~0.35)
    G_AMB = 0.35
    G_MEL = 0.40
    G_VIO = violin_gain

    summed = G_AMB * ambient + G_MEL * melodic + G_VIO * violin
    bed = G_AMB * ambient + G_MEL * melodic   # for comparison: without violin

    # Did we add headroom problems?
    peak_summed = float(np.max(np.abs(summed)))
    peak_bed = float(np.max(np.abs(bed)))
    print(f"peak summed (3-layer): {20*np.log10(peak_summed + 1e-12):.2f} dBFS")
    print(f"peak bed (amb+mel):    {20*np.log10(peak_bed + 1e-12):.2f} dBFS")

    # Per-band: how much does the violin add to each band of the bed?
    b_with = band_rms_db(summed, SR)
    b_without = band_rms_db(bed, SR)

    print()
    print(f"{'band':<16} {'amb+mel':>9} {'+ violin':>9} {'delta':>7}")
    for band in b_with:
        delta = b_with[band] - b_without[band]
        print(f"{band:<16} {b_without[band]:>9.2f} {b_with[band]:>9.2f} {delta:>+7.2f}")

    # Write the summed result so it can be auditioned by a listener
    out = HERE / "mixaudit" / f"r2-el-stack-newviolin-g{int(violin_gain*100):03d}.wav"
    sf.write(str(out), summed.T, SR, subtype="PCM_16")
    print(f"\nwrote {out}")


if __name__ == "__main__":
    violin_path = sys.argv[1] if len(sys.argv) > 1 else "processed/r2-el-percussion.mp3"
    violin_gain = float(sys.argv[2]) if len(sys.argv) > 2 else 0.30
    main(violin_path, violin_gain)
