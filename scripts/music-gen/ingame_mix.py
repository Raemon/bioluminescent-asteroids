"""Render a representative in-game audio bed (bass kit + bg-beat) and mix
candidate halo music against it. Output the summed wav, analyze spectral
overlap with the bass family, and report whether the music is sitting under
or fighting the bass.

This is my "ears" for the next round. The Tone.js MembraneSynth voices used
for the bass kit (bassKick C2, bassBoom F2, bassPluck G2, bassSnap C3) and
the bg-beat C2 quarter-note kick are all sine-based with exponentially
falling pitch sweeps — straightforward to approximate in numpy.

Goal metric: in the 60–200 Hz "bass" band, the bass kit RMS should exceed
the halo music RMS by ≥6 dB. Lower means music is fighting the bass.

Tempo: 120 BPM, BASS_MEASURE_LENGTH = 2.0s.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

SR = 44100
BPM = 120
BEAT_S = 60.0 / BPM
MEASURE_S = BEAT_S * 4   # 2.0
SEGMENT_S = 32.0          # render a 32-second segment


def hz(midi_n: int) -> float:
    return 440.0 * (2 ** ((midi_n - 69) / 12.0))


def env_exp(n: int, peak: float, decay_s: float) -> np.ndarray:
    t = np.arange(n) / SR
    return peak * np.exp(-t / decay_s).astype(np.float32)


def sine(freq_curve_hz: np.ndarray) -> np.ndarray:
    """Sine oscillator driven by a per-sample frequency curve."""
    phase = np.cumsum(2 * np.pi * freq_curve_hz / SR)
    return np.sin(phase).astype(np.float32)


def membrane(start_hz: float, end_hz: float, sweep_s: float, decay_s: float,
             peak: float, dur_s: float) -> np.ndarray:
    """Approximate Tone.MembraneSynth: sine with exponential pitch fall + amp decay."""
    n = int(SR * dur_s)
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    t = np.arange(n) / SR
    # exponential pitch glide from start to end over sweep_s seconds
    decay_factor = np.where(t <= sweep_s, t / max(sweep_s, 1e-6), 1.0)
    freq = start_hz * np.exp(np.log(end_hz / start_hz) * decay_factor)
    sig = sine(freq)
    amp = peak * np.exp(-t / decay_s)
    # tiny attack so we don't hear a click at t=0
    attack_n = int(0.003 * SR)
    if attack_n > 0:
        amp[:attack_n] *= np.linspace(0, 1, attack_n, dtype=np.float32)
    return (sig * amp).astype(np.float32)


def metal_snap(start_hz: float, end_hz: float, decay_s: float, peak: float,
               dur_s: float) -> np.ndarray:
    """Approximate MetalSynth: bandpassed noise + inharmonic body."""
    n = int(SR * dur_s)
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    noise = np.random.randn(n).astype(np.float32) * 0.5
    # narrow bandpass that sweeps from start to end
    t = np.arange(n) / SR
    # apply a static bandpass at the geometric mean — close enough for our purposes
    fc = float(np.sqrt(start_hz * end_hz))
    sos = butter(4, [max(20, fc * 0.6), min(SR / 2 - 100, fc * 1.6)], btype="bandpass",
                 fs=SR, output="sos")
    body = sosfilt(sos, noise)
    amp = peak * np.exp(-t / decay_s)
    return (body * amp).astype(np.float32)


def render_bg_beat_segment() -> np.ndarray:
    """A 32s segment of just the bg-beat (C2 every quarter note at 120 BPM)."""
    total_n = int(SR * SEGMENT_S)
    out = np.zeros(total_n, dtype=np.float32)
    beat_n = int(BEAT_S * SR)
    # MembraneSynth recipe (bgBeat): pitchDecay 0.06, octaves 6, decay 0.45
    # That means the body starts at 64×C2 (sweep over 6 octaves) and falls to C2.
    # Practical match: start ~3300 Hz, end ~65 Hz, sweep ~0.06s, decay 0.45s.
    one_kick = membrane(start_hz=hz(36) * 32, end_hz=hz(36),
                        sweep_s=0.06, decay_s=0.45, peak=0.6, dur_s=1.0)
    kick_n = len(one_kick)
    for i in range(int(SEGMENT_S / BEAT_S)):
        start = i * beat_n
        end = min(start + kick_n, total_n)
        out[start:end] += one_kick[: end - start]
    return out


def render_bass_kit_segment() -> np.ndarray:
    """A 32s segment of all four bassteroid voices firing at their natural cadence.
    Each bassteroid fires once per measure (every 2.0s). We simulate one of each
    kind cycling through measures so the bass family is fully represented."""
    total_n = int(SR * SEGMENT_S)
    out = np.zeros(total_n, dtype=np.float32)

    # bassKick on C2 (65.4 Hz), pitch sweep from ~140 Hz down to 55 Hz, decay 0.32s
    bass_kick = membrane(140, 55, 0.09, 0.32, peak=0.55, dur_s=1.0)
    # bassBoom on F2 (87.3 Hz), starts ~180 Hz, decay 0.42s, with a sub layer
    bass_boom_body = membrane(180, 87.3, 0.06, 0.42, peak=0.5, dur_s=1.2)
    bass_boom_sub = membrane(43.65, 43.65, 0.0, 0.5, peak=0.28, dur_s=1.2)
    bass_boom = bass_boom_body + bass_boom_sub
    # bassPluck on G2 (98 Hz) — sawtooth-like with closing filter. Approximate
    # as sine + 2nd harmonic decaying faster (gives a brighter pluck).
    pluck_n = int(0.5 * SR)
    pluck_t = np.arange(pluck_n) / SR
    pluck_fund = np.sin(2 * np.pi * 98 * pluck_t) * np.exp(-pluck_t / 0.45) * 0.28
    pluck_h2 = np.sin(2 * np.pi * 196 * pluck_t) * np.exp(-pluck_t / 0.15) * 0.18
    bass_pluck = (pluck_fund + pluck_h2).astype(np.float32)
    # bassSnap — bandpass noise centered ~700–1700 Hz
    bass_snap = metal_snap(1700, 700, 0.15, peak=0.28, dur_s=0.5)

    voices = [bass_kick, bass_boom, bass_pluck, bass_snap]

    measure_n = int(MEASURE_S * SR)
    for m in range(int(SEGMENT_S / MEASURE_S)):
        voice = voices[m % len(voices)]
        start = m * measure_n
        end = min(start + len(voice), total_n)
        out[start:end] += voice[: end - start]
    return out


def render_ingame_bed(out_path: Path) -> None:
    """Sum bass kit + bg-beat (no music) and write to disk. This is the
    'naked game' reference. Halo music will be analyzed against this."""
    bg = render_bg_beat_segment()
    bass = render_bass_kit_segment()
    summed = bg + bass
    # peak normalize to -6 dBFS so it doesn't clip when we add music on top
    peak = float(np.max(np.abs(summed)))
    if peak > 0:
        summed *= (10 ** (-6 / 20)) / peak
    # mono → fake stereo
    stereo = np.stack([summed, summed], axis=1)
    sf.write(str(out_path), stereo, SR, subtype="PCM_16")


def rms_band(y: np.ndarray, lo: float, hi: float) -> float:
    sos = butter(4, [lo, hi], btype="bandpass", fs=SR, output="sos")
    filt = sosfilt(sos, y)
    return float(np.sqrt(np.mean(filt**2)))


def db(x: float) -> float:
    return 20 * np.log10(max(x, 1e-12))


def analyze_mix(bed_path: Path, music_path: Path, mix_out_path: Path,
                music_gain: float = 0.15) -> dict:
    """Mix the in-game bed with the candidate music at music_gain, write the
    summed wav for posterity, and report sub-band RMS / collision metrics."""
    bed, sr_bed = librosa.load(str(bed_path), sr=None, mono=False)
    if bed.ndim == 1:
        bed = np.stack([bed, bed])
    music, sr_m = librosa.load(str(music_path), sr=None, mono=False)
    if music.ndim == 1:
        music = np.stack([music, music])

    # Match lengths
    n = min(bed.shape[1], music.shape[1])
    bed = bed[:, :n]
    music = music[:, :n] * music_gain

    summed = bed + music
    peak = float(np.max(np.abs(summed)))
    if peak > 0.99:
        summed *= 0.99 / peak

    sf.write(str(mix_out_path), summed.T, SR, subtype="PCM_16")

    # Per-band RMS analysis (mono fold)
    bed_mono = bed.mean(axis=0)
    music_mono = music.mean(axis=0)
    bands = {
        "sub_20-60": (20, 60),
        "bass_60-200": (60, 200),
        "lo_mid_200-500": (200, 500),
        "mid_500-2k": (500, 2000),
        "hi_mid_2k-6k": (2000, 6000),
        "air_6k-16k": (6000, 16000),
    }
    report = {}
    for name, (lo, hi) in bands.items():
        bed_rms = rms_band(bed_mono, lo, hi)
        music_rms = rms_band(music_mono, lo, hi)
        report[name] = {
            "bed_dbfs": round(db(bed_rms), 1),
            "music_dbfs": round(db(music_rms), 1),
            "bed_minus_music_db": round(db(bed_rms) - db(music_rms), 1),
        }
    # Verdict against "bass should beat music by ≥6 dB in 60–200 Hz"
    verdict = "PASS" if report["bass_60-200"]["bed_minus_music_db"] >= 6 else "MUSIC FIGHTING BASS"
    return {
        "mix_out": str(mix_out_path),
        "music_gain": music_gain,
        "bands": report,
        "bass_dominance_verdict": verdict,
    }


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    sp1 = sub.add_parser("render-bed")
    sp1.add_argument("out_path")

    sp2 = sub.add_parser("analyze-mix")
    sp2.add_argument("bed_path")
    sp2.add_argument("music_path")
    sp2.add_argument("mix_out_path")
    sp2.add_argument("--gain", type=float, default=0.15)

    args = p.parse_args()
    if args.cmd == "render-bed":
        render_ingame_bed(Path(args.out_path))
        print(json.dumps({"wrote": args.out_path, "duration_s": SEGMENT_S}, indent=2))
    elif args.cmd == "analyze-mix":
        result = analyze_mix(Path(args.bed_path), Path(args.music_path),
                             Path(args.mix_out_path), music_gain=args.gain)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
