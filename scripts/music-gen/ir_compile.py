"""IR → MIDI compiler: terse, hand/LLM-editable music notation → expression MIDI.

The split this enforces (per the music-authoring research):
  - NOTES & STRUCTURE live in a compact IR an LLM/human writes by hand.
  - CONTINUOUS EXPRESSION (pitch-bend glides, CC11 swells, CC1 vibrato) is
    compiled into explicit MIDI control lanes — never left to a notation symbol.

The output is the exact tuple shape build_cinematic-el_violin_sfizz.write_midi
already consumes, so the same .mid both pre-bakes through fluidsynth/sfizz AND
opens cleanly in REAPER's CC / pitch-wheel automation lanes (the human-engineer
round-trip). MIDI is the shared human<->LLM boundary on purpose: it's already
what the expression layer targets.

  notes:       [(beat_on, beat_off, channel, midi_note, velocity), ...]
  cc_events:   [(beat, channel, cc_number, value 0..127), ...]
  bend_events: [(beat, channel, bend_14bit 0..16383; 8192 = center), ...]

These three lists are returned by compile_ir(); hand them straight to write_midi.

----------------------------------------------------------------------------
IR shape (plain dict / JSON — terse for plain notes, opt-in for expression):

{
  "bpm": 120,
  "channel": 0,
  "program": 40,                 # GM program (40 = violin); omit to leave default
  "bend_range": 2.0,             # semitones the synth maps full pitch-wheel to
  "notes": [
    # The common case is ABC-cheap: "pitch dur" or [pitch, dur].
    "G4 1",                      # G4 for 1 beat at default velocity
    ["Eb4", 0.5, 78],            # pitch, dur, velocity
    {                            # only spend tokens when expression is present:
      "p": "C5", "dur": 4, "vel": 90,
      "bend": [["+0", 0.0], ["-2", 4.0]],   # start in tune, glide down a whole
                                            #   step over the note (portamento)
      "swell": [[20, 0.0], [96, 3.0], [40, 4.0]],  # CC11: rise then fall (a bow)
      "vib":   [[0, 0.0], [70, 2.0]]        # CC1: vibrato in after 2 beats
    }
  ]
}

Expression curve syntax: a list of [value, beat_offset] breakpoints, where
beat_offset is relative to the note's own start. We emit them as stepped CC /
pitch-wheel points; REAPER (and a smooth-enough tick grid) turns the points into
the audible curve. `bend` values are SEMITONE offsets ("+2", "-2", "0"), which
we convert to 14-bit using bend_range, so the IR stays musician-readable.
----------------------------------------------------------------------------
"""

from __future__ import annotations

from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build_v3 import midi_note  # reuse the existing 'C4'/'Eb3' -> int parser

BEND_CENTER = 0x2000  # 8192
DEFAULT_VELOCITY = 88
CC_EXPRESSION = 11    # swells
CC_MODWHEEL = 1       # vibrato depth
# How many control points to interpolate between two breakpoints, per beat.
# Higher = smoother audible curve; REAPER reads the same points as a ramp.
CURVE_POINTS_PER_BEAT = 16


def _semitones_to_bend14(semitones: float, bend_range: float) -> int:
    """Convert a signed semitone offset to a 14-bit pitch-wheel value."""
    frac = max(-1.0, min(1.0, semitones / bend_range))
    return max(0, min(16383, BEND_CENTER + int(round(frac * 8191))))


def _parse_bend_token(tok) -> float:
    """'+2' / '-2' / '0' / 2 / -2.0  -> float semitones."""
    if isinstance(tok, (int, float)):
        return float(tok)
    return float(tok)  # '+2' and '-2' parse fine as floats


def _normalize_note(raw, default_ch: int):
    """Accept the three note spellings and return a uniform dict."""
    if isinstance(raw, str):  # "G4 1" or "G4 1 78"
        parts = raw.split()
        d = {"p": parts[0], "dur": float(parts[1])}
        if len(parts) > 2:
            d["vel"] = int(parts[2])
        return d
    if isinstance(raw, (list, tuple)):  # ["Eb4", 0.5, 78]
        d = {"p": raw[0], "dur": float(raw[1])}
        if len(raw) > 2:
            d["vel"] = int(raw[2])
        return d
    return dict(raw)  # already a dict


def _interp_curve(breakpoints, start_beat: float):
    """Turn [[value, beat_off], ...] into interpolated (abs_beat, value) points.

    Linear between breakpoints, sampled at CURVE_POINTS_PER_BEAT so the synth
    hears a ramp rather than a stair-step. A single breakpoint = one static set.
    """
    pts = sorted(breakpoints, key=lambda bp: bp[1])
    if len(pts) == 1:
        v, off = pts[0]
        return [(start_beat + off, v)]
    out = []
    for (v0, o0), (v1, o1) in zip(pts, pts[1:]):
        span = o1 - o0
        steps = max(1, int(round(span * CURVE_POINTS_PER_BEAT)))
        for i in range(steps):
            f = i / steps
            out.append((start_beat + o0 + f * span, v0 + f * (v1 - v0)))
    out.append((start_beat + pts[-1][1], pts[-1][0]))  # land exactly on final
    return out


def compile_ir(ir: dict):
    """Compile an IR dict into (notes, cc_events, bend_events, programs, bpm).

    programs maps channel -> GM program for build_stem-style program changes;
    bend_events / cc_events are ready for the violin script's write_midi.
    """
    bpm = ir.get("bpm", 120)
    default_ch = ir.get("channel", 0)
    bend_range = ir.get("bend_range", 2.0)

    notes, cc_events, bend_events = [], [], []
    programs: dict[int, int] = {}
    if "program" in ir:
        programs[default_ch] = ir["program"]

    cursor = 0.0  # running beat position for notes that don't pin their own
    for raw in ir["notes"]:
        n = _normalize_note(raw, default_ch)
        ch = n.get("ch", default_ch)
        start = float(n["at"]) if "at" in n else cursor
        dur = float(n["dur"])
        vel = int(n.get("vel", DEFAULT_VELOCITY))
        pitch = midi_note(n["p"]) if isinstance(n["p"], str) else int(n["p"])

        notes.append((start, start + dur, ch, pitch, vel))

        if "swell" in n:
            for beat, val in _interp_curve(n["swell"], start):
                cc_events.append((beat, ch, CC_EXPRESSION, val))
        if "vib" in n:
            for beat, val in _interp_curve(n["vib"], start):
                cc_events.append((beat, ch, CC_MODWHEEL, val))
        if "bend" in n:
            semis = [[_parse_bend_token(v), off] for v, off in n["bend"]]
            for beat, st in _interp_curve(semis, start):
                bend_events.append((beat, ch, _semitones_to_bend14(st, bend_range)))
            # Re-center after the note so a bend doesn't bleed into the next.
            bend_events.append((start + dur, ch, BEND_CENTER))

        if "at" not in n:
            cursor = start + dur

    cc_events.sort(key=lambda e: e[0])
    bend_events.sort(key=lambda e: e[0])
    return notes, cc_events, bend_events, programs, bpm
