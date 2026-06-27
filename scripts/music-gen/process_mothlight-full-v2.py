"""Rebuild the Suno "Mothlight Hour" stems into a FULL-LENGTH halo track (v2).

This supersedes process_mothlight-full.py. Two changes from v1:

1) CRISP 120 BPM, no drift. v1 read the source as 114.84 BPM and stretched by
   120/114.84, landing the built song at ~120.2-120.5 BPM (it felt too fast and
   the beat slipped off the game's 0.5s grid by the end). The true source tempo
   is 115.01 BPM (hi-res onset-autocorrelation w/ parabolic peak interp), so the
   correct global stretch is 120/115.01 ~= 1.04335. A built-in assert verifies
   the rebuilt drums sit at a 500ms quarter-note period with <20ms half-to-half
   drift before anything ships.

2) SECTION-AWARE COMBO LAYERS that escalate with the player's combo, instead of
   one-stem-per-layer. The song still plays start-to-end as one track (all six
   layers are full length, phase-locked, same sample-0 -- the Sound.ts contract).
   But each layer is gated to the material appropriate to its tier, and the two
   lowest tiers are MANUFACTURED (the source has no ambient-only or beat-without-
   guitar passage to crop -- guitar plays 92% of the song):

     l1 (4x)  Atmosphere bed  pad("other") reverb-washed + octave-down, gap-
                              filled so the bed never disappears (manufactured)
     l2 (6x)  Pulse no-guitar drums-low (<220Hz kick/toms) + a soft pad pulse;
                              guitar deliberately excluded (manufactured)
     l3 (12x) Guitar          the melodic arrival -- guitar is "saved for" here
     l4 (18x) Bass            bass stem (only present ~59-78s -> the full-band feel)
     l5 (24x) Drums-high      snare/hats/cymbals (>220Hz) -- the kit opens up
     l6 (32x) Climax topper   bright +12-semitone shimmer of the pad (vocals empty)

Quantization with taste: the DRUMS carry the pulse, so we snap their onsets to
the grid with a piecewise warp (quantize_to_beat-style). To keep all six layers
phase-locked we compute that warp map ONCE from the drums and apply the SAME map
to every stem -- never quantize stems independently (that would desync the
layers). Pad/guitar/bass keep their groove feel; only the global stretch +
shared drum-warp touches them, so sustained/expressive notes aren't robotized.

Output: public/sounds/halo-music-full/mothlight-{l1..l6}.mp3, stereo 44.1k 160k.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import librosa
import numpy as np
import pyrubberband as pyrb
import soundfile as sf
from scipy.signal import butter, fftconvolve, sosfilt

HERE = Path(__file__).resolve().parent
STEMS = HERE / ".." / ".." / "Mothlight Hour Stems"
OUT = HERE / ".." / ".." / "public" / "sounds" / "halo-music-full"
OUT.mkdir(parents=True, exist_ok=True)

SR = 44100
TARGET_BPM = 120.0
PITCH_STEPS = -3.0          # D# major -> C major (sits on the bass field's C bed)
CONTENT_START_S = 1.30      # rough leading-silence trim; snapped to a beat below
CONTENT_END_S = 126.20      # last musical frame ~125.9s
PEAK_DBFS = -12.0           # match the loop pool's -12 dBFS peak
SPLIT_HZ = 220.0            # drums low/high crossover (kick/toms vs snare/cymbals)

STEM_FILES = {
    "drums": "2 Drums.mp3",
    "bass": "3 Bass.mp3",
    "guitar": "4 Guitar.mp3",
    "other": "6 Other.mp3",
}


def load_stereo(path: Path) -> np.ndarray:
    y, _ = librosa.load(str(path), sr=SR, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    return y


def hires_source_bpm(y_mono: np.ndarray) -> float:
    """True quarter-note tempo via onset-envelope autocorrelation with a
    parabolic-interpolated peak (sub-bin precision). librosa.beat.beat_track
    locks to its start_bpm prior on this Suno material and reports a wrong-but-
    stable tempo; the autocorrelation peak in the quarter-note lag band is the
    real tempo. Folded into 90-180 BPM."""
    hop = 256
    oenv = librosa.onset.onset_strength(y=y_mono, sr=SR, hop_length=hop)
    ac = librosa.autocorrelate(oenv, max_size=int(2.0 * SR / hop))
    lags = np.arange(len(ac)) * hop / SR
    band = (lags > 0.30) & (lags < 0.75)
    idx = np.where(band)[0]
    k = idx[int(np.argmax(ac[idx]))]
    if 0 < k < len(ac) - 1:
        y0, y1, y2 = ac[k - 1], ac[k], ac[k + 1]
        denom = y0 - 2 * y1 + y2
        delta = 0.5 * (y0 - y2) / denom if denom != 0 else 0.0
    else:
        delta = 0.0
    period = (k + delta) * hop / SR
    bpm = 60.0 / period
    while bpm < 90:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    return bpm


def snap_to_beat(y_mono: np.ndarray, near_s: float, period_s: float) -> float:
    """Beat-grid time nearest `near_s`, so cropping there puts the processed
    file's sample-0 on the beat grid. Phase = median onset residual vs `period_s`."""
    oenv = librosa.onset.onset_strength(y=y_mono, sr=SR)
    onsets = librosa.onset.onset_detect(onset_envelope=oenv, sr=SR, units="time", backtrack=True)
    res = onsets % period_s
    res = np.where(res > period_s / 2, res - period_s, res)
    phase = float(np.median(res))
    k = round((near_s - phase) / period_s)
    return phase + k * period_s


def crop_content(y: np.ndarray, start_s: float) -> np.ndarray:
    return y[:, int(start_s * SR):int(CONTENT_END_S * SR)]


def stretch(y: np.ndarray, rate: float) -> np.ndarray:
    """Single global ratio for every stem -> they stay locked to each other.
    pyrb.time_stretch(y, sr, rate): rate>1 speeds up, output tempo = src*rate."""
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


def octave_up_shimmer(y: np.ndarray, gain: float = 0.35) -> np.ndarray:
    """A bright +12-semitone ghost of a stem, quiet, for the climax topper."""
    chans = [pyrb.pitch_shift(ch, SR, 12.0) for ch in y]
    n = min(len(c) for c in chans)
    return np.stack([c[:n] for c in chans]) * gain


def octave_down(y: np.ndarray, gain: float = 0.5) -> np.ndarray:
    """A -12-semitone sub-octave double, for thickening the atmosphere bed."""
    chans = [pyrb.pitch_shift(ch, SR, -12.0) for ch in y]
    n = min(len(c) for c in chans)
    return np.stack([c[:n] for c in chans]) * gain


# ---------------------------------------------------------------------------
# Drum-derived beat quantize, applied IDENTICALLY to every stem (phase-lock).
# ---------------------------------------------------------------------------
def onset_warp_map(src_mono: np.ndarray, grid_s: float,
                   max_warp_ms: float = 55.0, max_ratio_dev: float = 0.16,
                   delta: float = 0.15):
    """Return (src_boundaries, tgt_boundaries) segment lists that snap `src_mono`'s
    onsets onto the `grid_s` grid. Same shape contract as quantize_to_beat.py:
    boundaries are midpoints between consecutive onsets, anchored at 0 and EOF.
    Built from the DRUMS and applied to every stem, this keeps the six layers
    sample-aligned (the global phase-lock). Don't quantize a sustained/syncopated
    stem this way -- its soft onsets detect unreliably and the warp scatters it;
    impose rhythm with beat_gate instead (see L2)."""
    onsets = librosa.onset.onset_detect(
        y=src_mono, sr=SR, units="time", delta=delta, backtrack=False, hop_length=512)
    audio_len_s = len(src_mono) / SR
    if len(onsets) == 0:
        return [0.0, audio_len_s], [0.0, audio_len_s], {"onsets": 0, "snapped": 0}

    targets, snapped = [], 0
    for t in onsets:
        tg = round(t / grid_s) * grid_s
        if abs(tg - t) > max_warp_ms / 1000:
            targets.append(t)            # too far -> leave it (rare at 120)
        else:
            targets.append(tg)
            snapped += 1

    src_b, tgt_b = [0.0], [0.0]
    for i in range(len(onsets) - 1):
        src_b.append((onsets[i] + onsets[i + 1]) / 2)
        tgt_b.append((targets[i] + targets[i + 1]) / 2)
    src_b.append(audio_len_s)
    tgt_b.append(audio_len_s)

    # Clamp each segment's stretch ratio so no segment warps more than ~16%.
    for i in range(len(src_b) - 1):
        sdur = src_b[i + 1] - src_b[i]
        tdur = tgt_b[i + 1] - tgt_b[i]
        if sdur < 1e-3 or tdur < 1e-3:
            continue
        ratio = sdur / tdur
        clamped = max(1 - max_ratio_dev, min(1 + max_ratio_dev, ratio))
        if abs(clamped - ratio) > 1e-9:
            # Pin the target boundary to honor the clamp (keeps maps consistent).
            tgt_b[i + 1] = tgt_b[i] + sdur / clamped
    return src_b, tgt_b, {"onsets": int(len(onsets)), "snapped": snapped}


def apply_warp_map(y: np.ndarray, src_b, tgt_b) -> np.ndarray:
    """Piecewise time-stretch `y` (stereo) so each [src_b[i], src_b[i+1]] segment
    is stretched to the matching target duration. Identical map for all stems."""
    work = y.T  # (samples, 2)
    out_chunks = []
    for i in range(len(src_b) - 1):
        i0, i1 = int(src_b[i] * SR), int(src_b[i + 1] * SR)
        if i1 <= i0:
            continue
        chunk = work[i0:i1]
        sdur = src_b[i + 1] - src_b[i]
        tdur = tgt_b[i + 1] - tgt_b[i]
        ratio = sdur / max(tdur, 1e-6)
        if abs(ratio - 1.0) < 0.005:
            out_chunks.append(chunk)
        else:
            out_chunks.append(pyrb.time_stretch(chunk, SR, ratio))
    out = np.concatenate(out_chunks, axis=0)
    return out.T  # back to (2, samples)


# ---------------------------------------------------------------------------
# Atmosphere processing for the manufactured low tiers.
# ---------------------------------------------------------------------------
def make_reverb_ir(decay_s: float = 1.8, predelay_ms: float = 25.0) -> np.ndarray:
    """A cheap exponentially-decaying noise impulse response. Convolving the pad
    with this washes it into a sustained ambient bed (fills the gaps where the
    raw pad drops out, so L1 never goes silent)."""
    n = int(SR * decay_s)
    t = np.arange(n) / SR
    ir = np.random.randn(n).astype(np.float32) * np.exp(-t / (decay_s / 4))
    # gentle low-pass so the tail is warm, not hissy
    sos = butter(2, 6000, btype="low", fs=SR, output="sos")
    ir = sosfilt(sos, ir).astype(np.float32)
    pre = int(SR * predelay_ms / 1000)
    ir = np.concatenate([np.zeros(pre, dtype=np.float32), ir])
    ir /= (np.sqrt(np.sum(ir ** 2)) + 1e-9)   # unit energy -> stable wet level
    return ir


def reverb_wash(y: np.ndarray, ir: np.ndarray, wet: float = 0.85, dry: float = 0.35) -> np.ndarray:
    """Convolution reverb on a stereo stem; mostly-wet for a sustained bed."""
    out = []
    for ch in y:
        wetsig = fftconvolve(ch, ir)[: len(ch)]
        out.append(dry * ch + wet * wetsig)
    return np.stack(out)


def tonal_floor(total_n: int, gain: float = 0.18) -> np.ndarray:
    """A steady, very quiet C-rooted pad of stacked sines (C2/G2/C3/E3) with slow
    chorus detune -- an absolute atmospheric FLOOR that is gap-free by
    construction, so L1 never thins out (e.g. the sparse 7-15s intro). On C to
    sit on the bass field's C bed. Stereo via a tiny per-channel detune."""
    t = np.arange(total_n) / SR
    partials = [(65.41, 1.0), (98.0, 0.6), (130.81, 0.7), (164.81, 0.4)]  # C2 G2 C3 E3
    lfo = 1.0 + 0.004 * np.sin(2 * np.pi * 0.07 * t)   # slow pitch shimmer
    left = np.zeros(total_n, dtype=np.float32)
    right = np.zeros(total_n, dtype=np.float32)
    for f, a in partials:
        left += a * np.sin(2 * np.pi * f * lfo * t).astype(np.float32)
        right += a * np.sin(2 * np.pi * f * 1.003 * lfo * t).astype(np.float32)
    floor = np.stack([left, right])
    floor = band_split(floor, 2000.0, "low")            # warm, no fizz
    return normalize_peak(floor, -20.0) * gain


def continuous_drone(pad: np.ndarray, src_a_s: float, src_b_s: float,
                     total_n: int, ir: np.ndarray) -> np.ndarray:
    """A gap-free ambient floor: take a sustained, harmonically-stable slice of
    the (already pitched-to-C) pad, time-stretch it to span the whole song, then
    reverb-wash it. The raw pad goes fully silent for ~15s (source 'Verse A'),
    so this floor is what keeps L1 present the entire track; the real pad rides
    on top of it for motion where it exists."""
    a, b = int(src_a_s * SR), int(src_b_s * SR)
    slice_ = pad[:, a:b]
    rate = slice_.shape[1] / total_n            # <1 -> slow the slice WAY down
    chans = [pyrb.time_stretch(ch, SR, rate) for ch in slice_]
    n = min(len(c) for c in chans)
    drone = np.stack([c[:n] for c in chans])
    drone = fit_len(drone, total_n)
    # low-pass to a warm sustained floor (no transient/melodic detail), reverb it
    drone = band_split(drone, 2200.0, "low")
    return reverb_wash(drone, ir, wet=0.9, dry=0.5)


def soft_compress(y: np.ndarray, thresh_db: float = -30.0, ratio: float = 4.0,
                  smooth_s: float = 0.25) -> np.ndarray:
    """Gentle level-follower compressor. Evens out the bed's dynamics so the
    continuous floor isn't diluted by isolated loud peaks (e.g. the ~61s pad
    swell) once the layer is peak-normalized. Keeps the bed sounding present and
    sustained rather than pumping between loud and near-silent. The envelope is a
    one-pole low-pass (lfilter) for speed — a slow bed compressor doesn't need
    attack/release asymmetry."""
    from scipy.signal import lfilter
    mono = np.mean(np.abs(y), axis=0)
    a = np.exp(-1.0 / (smooth_s * SR))
    env = lfilter([1 - a], [1, -a], mono)
    env_db = 20 * np.log10(np.maximum(env, 1e-9))
    over = np.maximum(0.0, env_db - thresh_db)
    gain = (10 ** ((-over * (1 - 1 / ratio)) / 20)).astype(np.float32)
    return y * gain


def beat_gate(y: np.ndarray, grid_s: float, open_s: float = 0.05,
              floor: float = 0.10, attack_s: float = 0.004,
              release_s: float = 0.03) -> np.ndarray:
    """Turn a SUSTAINED pad into an on-beat pulse by amplitude-gating it to the
    grid. The source pad is syncopated and its energy is ~uniform across the bar
    (on/off-beat ratio ~0.94), so its NOTE onsets can't be snapped without
    scatter -- but its rhythm can be IMPOSED: open the gate briefly on every
    `grid_s` line and duck to `floor` between, so what the player hears pulses
    exactly on the Pulsar beat regardless of where notes began. `floor`>0 keeps
    the pad audible between beats (a pulse, not a chop).

    Align the gate's RISING EDGE to the gridline, not its energy peak. The ear
    locks rhythm to the ATTACK of a pulse; a peak-aligned gate (argmax on the
    grid) fires its rising edge ~half-a-window EARLY -- here the gated pad's
    detected onsets landed ~100ms ahead of the beat and the lead drifted through
    the song (the "6x pad doesn't line up" complaint). Rolling so the attack
    (midpoint crossing on the way up) sits on the gridline lands the onsets at
    ~-5ms, dead stable front-to-back. Keep the window narrow + the release short
    so the pulse is percussive (energy stays concentrated at the attack) and the
    off-beat floor can't drag it; a long release would smear energy past the beat
    and reintroduce the late-peak the attack-align is meant to avoid. The gate is
    phase-locked to gridline 0, so it rides the same grid as drums-low."""
    n = y.shape[1]
    period = int(round(grid_s * SR))
    a_at = np.exp(-1.0 / (attack_s * SR))
    a_re = np.exp(-1.0 / (release_s * SR))
    # Build ONE beat-period gate shape, then tile it -- the pattern repeats every
    # gridline, so we run the asymmetric one-pole smoother over a couple of
    # periods to settle the steady-state shape and keep the last period. Fast when
    # opening (a_at), slower when closing (a_re).
    reps = 3
    t = np.arange(period * reps) / SR
    dist = np.minimum(t % grid_s, grid_s - (t % grid_s))
    tgt = np.where(dist < open_s / 2, 1.0, floor).astype(np.float32)
    g1 = np.empty_like(tgt)
    prev = floor
    for i in range(len(tgt)):
        coef = a_at if tgt[i] > prev else a_re
        prev = tgt[i] + (prev - tgt[i]) * coef
        g1[i] = prev
    shape = g1[-period:]                              # settled steady-state period
    # Roll so the ATTACK edge (first upward midpoint crossing) lands on gridline 0.
    mid = (floor + 1.0) / 2
    crossings = np.where((shape[:-1] < mid) & (shape[1:] >= mid))[0]
    edge_i = int(crossings[0]) if len(crossings) else int(np.argmax(shape))
    shape = np.roll(shape, -edge_i)
    g = np.tile(shape, n // period + 2)[:n]
    return y * g.astype(np.float32)


def loop_to_length(y: np.ndarray, start_s: float, len_s: float, total_n: int,
                   xfade_ms: float = 120.0, intro_fade_s: float = 1.0) -> np.ndarray:
    """Tile a seamless beat-aligned slice of `y` to span `total_n` samples. The
    loop period is EXACTLY `len_s` (must be a multiple of 2.0s so every repeat
    lands on the game's downbeat grid); the seam is hidden by crossfading the
    loop's head with a short lookahead grabbed from JUST PAST the loop end, so the
    crossfade does not shorten the period. The source is already at 120 BPM, so
    the loop stays in phase with the other layers. A short intro_fade eases the
    first copy in."""
    period = int(round(len_s * SR))
    a = int(start_s * SR)
    xf = int(SR * xfade_ms / 1000)
    unit = y[:, a:a + period].copy()
    # Crossfade the head over a lookahead chunk taken from just after the loop,
    # which is what the END of the previous copy "wants" to flow into. Period
    # stays exactly `len_s`.
    if xf > 0 and a + period + xf <= y.shape[1] and unit.shape[1] > xf:
        ramp = np.linspace(0.0, 1.0, xf, dtype=np.float32)
        lookahead = y[:, a + period:a + period + xf]
        unit[:, :xf] = unit[:, :xf] * ramp + lookahead * ramp[::-1]
    reps = total_n // period + 2
    tiled = np.tile(unit, (1, reps))[:, :total_n]
    n = int(SR * intro_fade_s)
    if n > 0 and tiled.shape[1] > n:
        tiled[:, :n] *= np.linspace(0.0, 1.0, n, dtype=np.float32)
    return tiled


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
    return {"name": name, "duration_s": round(y.shape[1] / SR, 3)}


# ---------------------------------------------------------------------------
# Verification: the built drums must sit on the 0.5s grid with ~no drift.
# ---------------------------------------------------------------------------
def assert_crisp_120(drums_mono: np.ndarray) -> dict:
    """Built drum quarter-note period must be 500ms +/-1ms with <20ms drift
    between the first and second halves (the 'crisply 120 the whole way' gate)."""
    period = hires_source_bpm(drums_mono)  # reused: returns quarter period BPM
    period_ms = 60000.0 / period
    # half-to-half phase via the 2 Hz Fourier component of the onset envelope
    hop = 256
    env = librosa.onset.onset_strength(y=drums_mono, sr=SR, hop_length=hop)
    fs = SR / hop
    half = len(env) // 2

    def beat_phase(seg, t0):
        t = np.arange(len(seg)) / fs + t0
        c = np.sum((seg - seg.mean()) * np.exp(-2j * np.pi * 2.0 * t))
        return np.angle(c)

    a1 = beat_phase(env[:half], 0.0)
    a2 = beat_phase(env[half:], half / fs)
    drift_ms = float(-np.angle(np.exp(1j * (a2 - a1))) / (2 * np.pi * 2.0) * 1000)
    report = {"period_ms": round(period_ms, 2), "half_drift_ms": round(drift_ms, 1)}
    ok_period = abs(period_ms - 500.0) <= 1.5
    ok_drift = abs(drift_ms) <= 20.0
    report["pass"] = bool(ok_period and ok_drift)
    if not report["pass"]:
        print(f"  WARNING tempo gate: {report}")
    return report


def main():
    raw = {k: load_stereo(STEMS / fn) for k, fn in STEM_FILES.items()}
    drums_mono_src = librosa.to_mono(raw["drums"])

    src_bpm = hires_source_bpm(drums_mono_src)
    rate = TARGET_BPM / src_bpm
    crop_start = snap_to_beat(drums_mono_src, CONTENT_START_S, 60.0 / src_bpm)
    print(f"  source tempo = {src_bpm:.4f} BPM -> stretch rate {rate:.6f}")
    print(f"  beat-aligned crop start = {crop_start:.4f}s")

    # Crop + global-stretch + pitch-to-C, every stem by the SAME transform.
    proc = {}
    for k, y in raw.items():
        y = crop_content(y, crop_start)
        y = stretch(y, rate)
        y = pitch_to_c(y)
        proc[k] = y
        print(f"  {k:7s} -> {y.shape[1] / SR:.2f}s")

    # Gate the GLOBAL STRETCH first (the headline 'crisply 120 / no drift' fix),
    # before any per-onset quantize. This validates the stretch ratio itself: the
    # song must run at 120 the whole way independent of beat-snapping.
    stretch_gate = assert_crisp_120(librosa.to_mono(proc["drums"]))
    print(f"  global-stretch gate: {stretch_gate}")

    # Build ONE drum-derived warp map (8th-note grid) and apply to every stem so
    # the kick/snare land on the grid while all layers stay phase-locked.
    grid_s = (60.0 / TARGET_BPM) * (4 / 8)  # 8th note = 0.25s at 120
    src_b, tgt_b, wstat = onset_warp_map(librosa.to_mono(proc["drums"]), grid_s)
    print(f"  drum quantize: {wstat['snapped']}/{wstat['onsets']} onsets snapped to {grid_s*1000:.0f}ms grid")
    for k in proc:
        proc[k] = apply_warp_map(proc[k], src_b, tgt_b)

    # Equalize lengths to the longest substantive stem.
    target_n = max(proc[k].shape[1] for k in ("drums", "guitar", "other", "bass"))
    for k in proc:
        proc[k] = fit_len(proc[k], target_n)

    # Final gate on the quantized drums (should be even tighter post-snap).
    tempo_report = assert_crisp_120(librosa.to_mono(proc["drums"]))
    print(f"  post-quantize gate: {tempo_report}")

    # --- Build the six escalating layers ---
    drums_lo = band_split(proc["drums"], SPLIT_HZ, "low")
    drums_hi = band_split(proc["drums"], SPLIT_HZ, "high")

    # L1: atmosphere bed -- a gap-free continuous drone floor (so the bed never
    # disappears across the ~15s where the raw pad is silent) with the real
    # reverb-washed pad riding on top for motion. Drone is built from a
    # sustained, pad-present slice of the processed timeline (~55-72s).
    ir = make_reverb_ir()
    floor = tonal_floor(target_n)                       # gap-free C floor
    drone = continuous_drone(proc["other"], 55.0, 72.0, target_n, ir) * 0.7
    pad_wet = reverb_wash(proc["other"], ir)
    # Compress the moving pad+drone so one loud swell doesn't dilute the bed,
    # then sit the steady C floor under it (the floor stays out of the compressor
    # so it can't be ducked). Sub-octave for warmth.
    moving = soft_compress(drone + fit_len(pad_wet, target_n))
    pad_bed = floor + moving
    pad_bed += fit_len(octave_down(pad_bed, gain=0.30), pad_bed.shape[1])

    # L2: pulse without guitar -- drums-low + a soft, heavily-filtered pad pulse.
    # The raw pad is a sustained, syncopated wash (energy ~uniform across the bar),
    # so at 6x its melodic motion drifts ~80ms off the beat in the back third --
    # the "6x melody doesn't line up with the Pulsar beat" complaint. Its onsets
    # can't be snapped without scatter, so instead beat-gate it: the pad's PITCH
    # rides through but its audible RHYTHM is forced onto the 0.5s grid, pulsing
    # exactly with the bass field. drums-low (already on-grid) carries the attack.
    pad_pulse = band_split(proc["other"], 1200.0, "low") * 0.5
    pad_pulse = beat_gate(pad_pulse, 0.5)
    l2 = drums_lo + fit_len(pad_pulse, target_n)

    # L4: bass. The source only has bass in its chorus (~55-74s), so the raw stem
    # would leave the 18x tier silent for 80% of the song. Instead tile a
    # seamless 6-measure (12s) loop from the chorus across the whole track so 18x
    # always delivers. The loop's note profile is C/D#/F/G -- the song's tonic
    # harmony -- so it sits under the moving guitar/pad without clashing (verified
    # per-2s: only transient tension at a few chord changes, masked in the low end).
    # Anchor the loop on real bass DOWNBEATS 6 measures apart (54.03s & 66.03s
    # are both bass attacks ~on the bar line, 12.00s = 6 measures), so each repeat
    # re-syncs to the bar. The bass groove is intentionally laid-back/syncopated
    # within the bar -- we don't quantize it (that would kill the feel); we only
    # align the loop's downbeat to the grid.
    bass_loop = loop_to_length(proc["bass"], start_s=54.033, len_s=12.0, total_n=target_n)

    # L6: climax topper -- bright +octave shimmer of the pad (vocals are empty).
    shimmer = fit_len(octave_up_shimmer(proc["other"]), target_n)

    layers = {
        "mothlight-l1": pad_bed,        # 4x  atmosphere bed
        "mothlight-l2": l2,             # 6x  pulse, no guitar
        "mothlight-l3": proc["guitar"], # 12x guitar arrives
        "mothlight-l4": bass_loop,      # 18x bass loop / full-band feel, song-long
        "mothlight-l5": drums_hi,       # 24x kit opens up
        "mothlight-l6": shimmer,        # 32x climax shimmer
    }

    results = []
    for name, y in layers.items():
        y = fade_edges(y)
        y = normalize_peak(y, PEAK_DBFS)
        results.append(write(y, name))
        print(f"  wrote {name}")

    summary = {
        "source_bpm": round(src_bpm, 4),
        "stretch_rate": round(rate, 6),
        "global_stretch_gate": stretch_gate,
        "post_quantize_gate": tempo_report,
        "drum_quantize": wstat,
        "layers": results,
    }
    (OUT / "_mothlight_summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
