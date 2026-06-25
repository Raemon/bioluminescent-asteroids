"""Process the Suno "Mothlight Hour" stems into a FULL-LENGTH halo track.

Unlike every other entry in public/sounds/halo-music/ (32s C-pedal loops), this
builds a ~2:10 through-composed song split into SIX combo-tier layers that fade
in at 4x/6x/12x/18x/24x/32x. All six layers are the full length and phase-locked,
so a combo-tier change is just a gain ramp on the matching layer (same contract
as the loop system, but non-looping and longer).

Source: "Mothlight Hour Stems/" — 7 Suno stems. Analysis (see plan) found:
  - Real musical content is ~1.5s..126s; the rest is trailing silence.
  - BackVocals (-63 dBFS peak) and Synth (-60) are effectively EMPTY -> dropped.
  - LeadVocals has a tiny ~2s fragment near 36s only.
  - Substantive stems: Drums, Bass, Guitar, Other(bright pad).
  - Tempo ~115 BPM -> time-stretched (pitch-preserving) to exactly 120.
  - Key D# major -> pitch-shifted DOWN 3 semitones to C major (smaller move
    than +9 up), matching the bass field's C bed like the loop pool.

Six layers, building intensity (taste call):
  l1 (4x)  Other     bright pad / atmosphere — the bed
  l2 (6x)  Guitar    warm melodic mid
  l3 (12x) Bass      low end arrives
  l4 (18x) Drums-lo  kick/toms (low-passed) — a pulse without the full kit
  l5 (24x) Drums-hi  snare/hats/cymbals (high-passed) — the kit opens up
  l6 (32x) Vocals+   the lead-vox fragment + a bright octave shimmer — climax

Output: public/sounds/halo-music-full/mothlight-{l1..l6}.mp3, stereo 44.1k 160k.
ALL six are stretched by the SAME ratio and shifted by the SAME semitones so they
stay sample-aligned with each other.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import librosa
import numpy as np
import pyrubberband as pyrb
import soundfile as sf
from scipy.signal import butter, sosfilt

HERE = Path(__file__).resolve().parent
STEMS = HERE / ".." / ".." / "Mothlight Hour Stems"
OUT = HERE / ".." / ".." / "public" / "sounds" / "halo-music-full"
OUT.mkdir(parents=True, exist_ok=True)

SR = 44100
# The source tempo is detected automatically (detect_source_bpm) rather than
# hard-coded — librosa's beat_track lies on this drifty Suno material (it locks
# to a fixed prior), so we read the true beat period from the onset-envelope
# autocorrelation instead. The song has NO cumulative drift (measured slope
# ~0 ms/beat over its length), so one global stretch to exactly 120 keeps every
# downbeat locked to the game's 2.0s bass-measure grid for the whole track.
TARGET_BPM = 120.0
PITCH_STEPS = -3.0       # D# major -> C major
# Rough leading-silence trim; the exact crop start is then snapped to the
# nearest beat line (snap_to_beat) so the processed file's sample-0 sits ON the
# beat grid. The game starts playback at sample-0 on a bass downbeat, so a
# beat-aligned sample-0 means every beat (incl. the drum entry) lands on the
# game's 0.5s grid after the stretch.
CONTENT_START_S = 1.30
CONTENT_END_S = 126.20   # last musical frame ~125.9s
PEAK_DBFS = -12.0        # match the loop pool's -12 dBFS peak
SPLIT_HZ = 220.0         # drums low/high crossover (kick/toms vs snare/cymbals)

STEM_FILES = {
    "drums": "2 Drums.mp3",
    "bass": "3 Bass.mp3",
    "guitar": "4 Guitar.mp3",
    "other": "6 Other.mp3",
    "vocals": "0 Lead Vocals.mp3",
}


def load_stereo(path: Path) -> np.ndarray:
    y, sr = librosa.load(str(path), sr=SR, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    return y


def snap_to_beat(y_mono: np.ndarray, near_s: float, period_s: float) -> float:
    """Return the beat-grid time nearest `near_s`. Phase is the median residual
    of the drum onsets against a grid of `period_s`, so cropping here puts the
    processed file's sample-0 on the beat grid."""
    oenv = librosa.onset.onset_strength(y=y_mono, sr=SR)
    onsets = librosa.onset.onset_detect(onset_envelope=oenv, sr=SR, units="time", backtrack=True)
    res = onsets % period_s
    res = np.where(res > period_s / 2, res - period_s, res)
    phase = float(np.median(res))
    k = round((near_s - phase) / period_s)
    return phase + k * period_s


def crop_content(y: np.ndarray, start_s: float) -> np.ndarray:
    a = int(start_s * SR)
    b = int(CONTENT_END_S * SR)
    return y[:, a:b]


def detect_source_bpm(y_mono: np.ndarray) -> float:
    """True beat period via onset-envelope autocorrelation (prior-independent).
    librosa.beat.beat_track locks to its start_bpm prior on this material and
    reports a wrong-but-stable tempo; the autocorrelation peak in the quarter-
    note lag band is the actual tempo. Octave-folded into 90-180 BPM."""
    hop = 256
    oenv = librosa.onset.onset_strength(y=y_mono, sr=SR, hop_length=hop)
    ac = librosa.autocorrelate(oenv, max_size=int(2.0 * SR / hop))
    lags_s = np.arange(len(ac)) * hop / SR
    band = (lags_s > 0.30) & (lags_s < 0.75)
    idx = np.where(band)[0]
    period = lags_s[idx[int(np.argmax(ac[idx]))]]
    bpm = 60.0 / period
    while bpm < 90:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    return bpm


def stretch_to_120(y: np.ndarray, src_bpm: float) -> np.ndarray:
    """Single global ratio for every stem -> they stay locked to each other.
    pyrb.time_stretch(y, sr, rate): rate>1 speeds up, and output tempo =
    src_bpm * rate (verified against output durations). To land on TARGET_BPM
    from a slower source, rate = TARGET_BPM / src_bpm (>1, speeds it up)."""
    rate = TARGET_BPM / src_bpm
    chans = [pyrb.time_stretch(ch, SR, rate) for ch in y]
    n = min(len(c) for c in chans)
    return np.stack([c[:n] for c in chans])


def pitch_to_c(y: np.ndarray) -> np.ndarray:
    chans = [pyrb.pitch_shift(ch, SR, PITCH_STEPS) for ch in y]
    n = min(len(c) for c in chans)
    return np.stack([c[:n] for c in chans])


def band_split(y: np.ndarray, hz: float, kind: str) -> np.ndarray:
    sos = butter(4, hz, btype=kind, fs=SR, output="sos")
    return np.stack([sosfilt(sos, ch) for ch in y])


def octave_up_shimmer(y: np.ndarray) -> np.ndarray:
    """A bright +12-semitone ghost of a stem, quiet, for the climax topper."""
    chans = [pyrb.pitch_shift(ch, SR, 12.0) for ch in y]
    n = min(len(c) for c in chans)
    return np.stack([c[:n] for c in chans]) * 0.35


def fit_len(y: np.ndarray, n: int) -> np.ndarray:
    if y.shape[1] >= n:
        return y[:, :n]
    pad = np.zeros((y.shape[0], n - y.shape[1]), dtype=y.dtype)
    return np.concatenate([y, pad], axis=1)


def fade_edges(y: np.ndarray, fade_ms: float = 60.0) -> np.ndarray:
    n = int(SR * fade_ms / 1000)
    if n <= 0 or y.shape[1] < 2 * n:
        return y
    y = y.copy()
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    y[:, :n] *= ramp
    y[:, -n:] *= ramp[::-1]
    return y


def normalize_peak(y: np.ndarray, target_dbfs: float) -> np.ndarray:
    peak = float(np.max(np.abs(y)))
    if peak < 1e-9:
        return y
    return y * ((10 ** (target_dbfs / 20)) / peak)


def write(y: np.ndarray, name: str) -> dict:
    wav = OUT / f"{name}.wav"
    mp3 = OUT / f"{name}.mp3"
    sf.write(str(wav), y.T, SR, subtype="PCM_16")
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
        "-codec:a", "libmp3lame", "-b:a", "160k", str(mp3),
    ], check=True, capture_output=True)
    wav.unlink()
    return {"name": name, "mp3": str(mp3), "duration_s": round(y.shape[1] / SR, 3)}


def main():
    raw = {key: load_stereo(STEMS / fn) for key, fn in STEM_FILES.items()}

    # Detect the true source tempo from the drums (cleanest onset grid); librosa's
    # beat_track lies on this material so detect_source_bpm reads the autocorr peak.
    drums_mono = librosa.to_mono(raw["drums"])
    src_bpm = detect_source_bpm(drums_mono)
    # Snap the crop start to the nearest beat line so sample-0 lands on the grid.
    crop_start = snap_to_beat(drums_mono, CONTENT_START_S, 60.0 / src_bpm)
    print(f"  detected source tempo = {src_bpm:.2f} BPM -> stretching to {TARGET_BPM:.0f}")
    print(f"  beat-aligned crop start = {crop_start:.4f}s")

    # Load + crop + lock-to-120 + pitch-to-C, every stem by the SAME transform.
    proc = {}
    for key, y in raw.items():
        y = crop_content(y, crop_start)
        y = stretch_to_120(y, src_bpm)
        y = pitch_to_c(y)
        proc[key] = y
        print(f"  {key:7s} -> {y.shape[1] / SR:.2f}s")

    # Song length is the LONGEST substantive stem (drums/guitar), not the
    # shortest — the vocals fragment is only ~2s and must be padded up, not
    # used to truncate the whole song.
    target_n = max(proc["drums"].shape[1], proc["guitar"].shape[1],
                   proc["other"].shape[1], proc["bass"].shape[1])
    for k in proc:
        proc[k] = fit_len(proc[k], target_n)

    drums_lo = band_split(proc["drums"], SPLIT_HZ, "low")
    drums_hi = band_split(proc["drums"], SPLIT_HZ, "high")
    shimmer = fit_len(octave_up_shimmer(proc["other"]), target_n)
    topper = fit_len(proc["vocals"], target_n) + shimmer

    # Per-layer peak normalization keeps relative balance roughly even; the
    # in-game /music sliders do final per-layer tuning afterward.
    layers = {
        "mothlight-l1": proc["other"],
        "mothlight-l2": proc["guitar"],
        "mothlight-l3": proc["bass"],
        "mothlight-l4": drums_lo,
        "mothlight-l5": drums_hi,
        "mothlight-l6": topper,
    }

    results = []
    for name, y in layers.items():
        y = fade_edges(y)
        y = normalize_peak(y, PEAK_DBFS)
        results.append(write(y, name))
        print(f"  wrote {name}")

    (OUT / "_mothlight_summary.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
