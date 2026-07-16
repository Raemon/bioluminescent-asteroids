"""Pitch-inspect the wraith SFX candidates, pick the best take per sound,
correct it toward a C-scale target, clean it up, and install it as a baked mp3.

Companion to generate_wraith_sfx.py. For every candidate in raw/ it measures the
dominant pitch (librosa.pyin), reports cents-off from the nearest allowed C-scale
tone, auto-picks the best take, then for the chosen take:
  - pitch-corrects toward the nearest C-scale target with rubberband, but only
    when the take is clearly pitched AND meaningfully off (> CENTS_SNAP cents);
  - trims leading/trailing near-silence;
  - applies short edge fades so the buffer can't click;
  - peak-normalizes to PEAK_DBFS;
and writes it to public/sounds/baked/<sound>__1.0000.mp3 (the pitchRatio=1 slug
Sound.ts.bakedFileSlug expects). Raw candidates are left in place for audition.

Auto-pick can be overridden per sound:
    tune_wraith_sfx.py --pick wraithScream=2 wraithLunge=1

The C-scale targets mirror the harmony the old synth used:
  scream / lunge  → C-minor colour  (C, Eb, G)
  death           → Eb-major colour (Eb, G, Bb)
  hit             → intentionally UNPITCHED (a breathy flinch); never corrected.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import librosa
import numpy as np
import pyrubberband as pyrb
import soundfile as sf

HERE = Path(__file__).resolve().parent
RAW_DIR = HERE / "raw"
BAKED_DIR = HERE.parent.parent / "public" / "sounds" / "baked"

# Only correct a pitched take if it's more than this far from its target — a few
# cents of "human" detune is part of the haunted character and re-stretching a
# nearly-in-tune take just smears its timbre for no gain.
CENTS_SNAP = 18.0
# SFX sit hotter than music (music targets -12). -6 leaves headroom for the
# shared master limiter when several copies pile up.
PEAK_DBFS = -6.0
SILENCE_DB = -45.0   # trim threshold for leading/trailing near-silence
FADE_MS = 12.0

# Allowed pitch-class targets per sound (semitone classes, C=0). None => the
# sound is treated as unpitched and never corrected.
NOTE_TO_PC = {"C": 0, "Db": 1, "D": 2, "Eb": 3, "E": 4, "F": 5,
              "Gb": 6, "G": 7, "Ab": 8, "A": 9, "Bb": 10, "B": 11}
# Consonant pitch classes with the C-root bed. Both C-minor and its relative
# Eb-major live inside {C, Eb, G, Bb}, so any take landing on one of these tones
# already fits — snapping only nudges out the worst detune, never drags a take
# that hit the tonic off onto a "prettier" chord tone two semitones away.
C_CONSONANT = ["C", "Eb", "G", "Bb"]
TARGETS: dict[str, list[str] | None] = {
    "wraithScream": C_CONSONANT,        # release cry — any consonant C tone
    "wraithHit": C_CONSONANT,           # voiced flinch — snap to a consonant C tone
    "wraithLunge": C_CONSONANT,         # voiced lunge cry — snap to a consonant C tone
    "wraithDeath": C_CONSONANT,         # soul-release — resolves on a consonant C tone
}


def median_pitch(y: np.ndarray, sr: int) -> tuple[float | None, float]:
    """Return (median_hz | None, voiced_fraction)."""
    try:
        f0, _, _ = librosa.pyin(y, fmin=70, fmax=1400, sr=sr)
    except Exception:
        return None, 0.0
    voiced = f0[~np.isnan(f0)]
    if len(f0) == 0 or len(voiced) == 0:
        return None, 0.0
    return float(np.median(voiced)), len(voiced) / len(f0)


def nearest_target_cents(hz: float, allowed_pcs: list[int]) -> tuple[int, float]:
    """Nearest allowed pitch-class to hz. Returns (target_midi, signed_cents_off)
    where cents_off is (measured - target); shift by -cents_off to snap up/down."""
    midi = 69 + 12 * np.log2(hz / 440.0)
    best = None
    for octave_midi in range(24, 108):          # C1..B7
        if octave_midi % 12 not in allowed_pcs:
            continue
        cents = (midi - octave_midi) * 100.0
        if best is None or abs(cents) < abs(best[1]):
            best = (octave_midi, cents)
    return best  # type: ignore[return-value]


def note_name(hz: float) -> str:
    midi = 69 + 12 * np.log2(hz / 440.0)
    return librosa.midi_to_note(int(round(midi)))


def peak_dbfs(y: np.ndarray) -> float:
    return 20 * np.log10(np.max(np.abs(y)) + 1e-12)


def analyze_take(path: Path, allowed_pcs: list[int] | None) -> dict:
    y, sr = librosa.load(path, sr=None, mono=True)
    hz, voiced = median_pitch(y, sr)
    info: dict = {
        "path": path, "y": y, "sr": sr, "dur": len(y) / sr,
        "peak": peak_dbfs(y), "hz": hz, "voiced": voiced,
    }
    if hz is not None and voiced >= 0.6:
        info["note"] = note_name(hz)
        if allowed_pcs is not None:
            tgt_midi, cents = nearest_target_cents(hz, allowed_pcs)
            info["target_midi"] = tgt_midi
            info["cents_off"] = cents
    return info


def pick_best(sound: str, takes: list[dict]) -> int:
    """Return the index of the auto-picked take."""
    allowed = TARGETS[sound]
    if allowed is None:
        # Unpitched sound (hit): prefer the loudest CLEAN take — one that reads
        # as breathy noise, not a rumble. Loudest peak is the best proxy for
        # "has a usable transient"; ties break toward the shorter file.
        return max(range(len(takes)),
                   key=lambda i: (takes[i]["peak"], -takes[i]["dur"]))
    # Pitched: prefer a clearly-voiced, present take that's near a target tone.
    # Unvoiced takes get a large penalty so a noisy one never wins a pitched
    # slot. Among voiced takes, cost trades off detune (cheap to fix with a snap)
    # against how vocal (voiced_frac) and audible (peak) the take is — a strongly
    # sung take a semitone off beats a whisper that happens to sit on-pitch.
    def score(i: int) -> float:
        t = takes[i]
        if "cents_off" not in t:
            return 1e6
        detune = abs(t["cents_off"]) / 100.0          # semitones off (0..~0.5)
        breathiness = (1.0 - t.get("voiced", 0.0))     # 0 = fully voiced
        quiet = max(0.0, (-6.0 - t["peak"]) / 12.0)    # penalize below ~-6 dBFS
        return detune + 1.2 * breathiness + 0.8 * quiet
    return min(range(len(takes)), key=score)


def trim_silence(y: np.ndarray, sr: int) -> np.ndarray:
    thr = 10 ** (SILENCE_DB / 20)
    above = np.abs(y) > thr
    if not np.any(above):
        return y
    first, last = np.argmax(above), len(above) - np.argmax(above[::-1])
    return y[first:last]


def edge_fade(y: np.ndarray, sr: int) -> np.ndarray:
    n = min(len(y) // 2, int(sr * FADE_MS / 1000))
    if n <= 0:
        return y
    ramp = np.linspace(0.0, 1.0, n)
    y = y.copy()
    y[:n] *= ramp
    y[-n:] *= ramp[::-1]
    return y


def install(sound: str, take: dict, args) -> dict:
    y, sr = take["y"].astype(np.float32), take["sr"]
    report: dict = {"sound": sound, "take": take["path"].name,
                    "measured": None, "correction": "none"}

    allowed = TARGETS[sound]
    if allowed is not None and "cents_off" in take:
        report["measured"] = f"{take['hz']:.1f}Hz ({take['note']})"
        cents = take["cents_off"]
        tgt = librosa.midi_to_note(take["target_midi"])
        if abs(cents) > CENTS_SNAP:
            # snap toward target: shift by -cents (in semitones)
            semis = -cents / 100.0
            y = pyrb.pitch_shift(y, sr, n_steps=semis).astype(np.float32)
            report["correction"] = f"{cents:+.0f}c -> {tgt} (shift {semis:+.2f} st)"
        else:
            report["correction"] = f"{cents:+.0f}c from {tgt} (within {CENTS_SNAP:.0f}c, left as-is)"
    elif allowed is None:
        report["measured"] = "unpitched (intentional)"

    y = trim_silence(y, sr)
    y = edge_fade(y, sr)
    # peak-normalize
    pk = np.max(np.abs(y)) + 1e-12
    y = y * (10 ** (PEAK_DBFS / 20) / pk)

    BAKED_DIR.mkdir(parents=True, exist_ok=True)
    tmp_wav = HERE / "raw" / f"_tmp_{sound}.wav"
    out_mp3 = BAKED_DIR / f"{sound}__1.0000.mp3"
    sf.write(tmp_wav, y, sr)
    # mirror the dev bake plugin's encode settings (libmp3lame -q:a 4)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(tmp_wav),
         "-codec:a", "libmp3lame", "-q:a", "4", str(out_mp3)],
        check=True,
    )
    tmp_wav.unlink(missing_ok=True)
    report["installed"] = str(out_mp3.relative_to(BAKED_DIR.parent.parent.parent))
    report["final_dur"] = round(len(y) / sr, 2)
    report["final_peak"] = round(peak_dbfs(y), 1)
    return report


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--sounds", nargs="*", default=list(TARGETS.keys()))
    p.add_argument("--pick", nargs="*", default=[],
                   help="override auto-pick, e.g. wraithScream=2 wraithLunge=1")
    p.add_argument("--dry-run", action="store_true",
                   help="analyze + report picks but do not write baked mp3s")
    args = p.parse_args()

    overrides = {}
    for kv in args.pick:
        k, v = kv.split("=")
        overrides[k] = int(v)

    reports = []
    for sound in args.sounds:
        allowed = TARGETS[sound]
        allowed_pcs = None if allowed is None else [NOTE_TO_PC[n] for n in allowed]
        takes = []
        k = 1
        while (RAW_DIR / f"{sound}_take{k}.mp3").exists():
            takes.append(analyze_take(RAW_DIR / f"{sound}_take{k}.mp3", allowed_pcs))
            k += 1
        if not takes:
            print(f"[skip] no candidates for {sound}")
            continue

        print(f"\n=== {sound}  (target: {allowed or 'unpitched'}) ===")
        for i, t in enumerate(takes):
            if t["hz"]:
                cents = f"  {t['cents_off']:+.0f}c" if "cents_off" in t else ""
                pitch = f"{t['hz']:.1f}Hz {t.get('note', '')}{cents}"
            else:
                pitch = "unpitched"
            print(f"  take{i+1}: {t['dur']:.2f}s peak{t['peak']:6.1f}dB  {pitch}")

        idx = (overrides[sound] - 1) if sound in overrides else pick_best(sound, takes)
        print(f"  -> picked take{idx+1}"
              + ("  (override)" if sound in overrides else "  (auto)"))

        if args.dry_run:
            continue
        reports.append(install(sound, takes[idx], args))

    if reports:
        print("\n================ INSTALL SUMMARY ================")
        for r in reports:
            print(f"{r['sound']:14s} <- {r['take']:20s}  "
                  f"pitch: {r['measured']}")
            print(f"{'':14s}    correction: {r['correction']}")
            print(f"{'':14s}    -> {r['installed']}  "
                  f"({r['final_dur']}s, peak {r['final_peak']}dB)")
    if args.dry_run:
        print("\n[dry-run] no files written.")


if __name__ == "__main__":
    main()
