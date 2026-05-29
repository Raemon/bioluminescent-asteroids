"""Generate Pilot's Log Entry Two — both variants — with ElevenLabs (PL_Ralf_Deep).

Pipeline (mirrors pilot-log-1.mp3):
1. Synth each phrase as its own request with v3 + directorial tags
2. Pitch-shift down 1 semitone (formant-preserved via rubberband) for chest resonance
3. Lay each phrase onto a 2.0s downbeat slot grid (the game snaps to 2s downbeats)
4. Bandpass 380-2700 Hz + light bitcrush + chest-EQ boost at 160Hz
5. Pink-noise hiss bed throughout; brown-noise tremolo crackle (ionospheric fade)
6. 0.22s squelch-in head + 0.32s squelch-out tail
7. Normalize to -22 dB mean / leave ~-4 dB peak headroom

Outputs to public/sounds/vocals/pilot-log-2-takes/:
  pilot-log-2-variant-a-ralf.mp3
  pilot-log-2-variant-b-ralf.mp3
"""

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterable

import requests

VOICE_ID = "A9evEp8yGjv4c3WsIKuY"  # PL_Ralf_Deep
MODEL = "eleven_v3"
SLOT_SECONDS = 2.0
SQUELCH_IN = 0.22
SQUELCH_OUT = 0.32
PITCH_SEMITONES = -1.0
SAMPLE_RATE = 44100

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / ".env"
OUT_DIR = REPO_ROOT / "public" / "sounds" / "vocals" / "pilot-log-2-takes"

# Inline ElevenLabs v3 directorial tags. Ralf is a deep German voice — the tags
# coach him toward the murmured, slow, lullaby register the script asks for.
TAGS_OPEN = "[low voice][gravelly][slowly][weary][murmuring]"


def load_api_key() -> str:
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith("ELEVENLABS_API_KEY"):
            _, _, val = line.partition("=")
            return val.strip().strip('"').strip("'")
    raise RuntimeError("ELEVENLABS_API_KEY not found in .env")


# Phrase scripts. Each list entry: (slot_index, text). slot_index is the 2s
# downbeat slot the phrase should start on. Slot 0 is the squelch-in.
# Phrases that share a slot are concatenated within that slot.
VARIANT_A = [
    (1, "Hey, kid."),
    (2, "Couldn't sleep, huh."),
    (3, "Me neither — funny how that works."),
    (5, "Listen. Close your eyes."),
    (6, "There's three notes out here."),
    (7, "They go… low, lower, home."),
    (8, "Same three, every time. Counted 'em."),
    (9, "That's the trick, see."),
    (10, "You don't count sheep out here."),
    (11, "You count the ones that sing back."),
    (13, "One for the dark."),
    (14, "One for the long way."),
    (15, "One for the porch light."),
    (17, "Go on. I got the watch."),
]

VARIANT_B = [
    (1, "Hey, kid."),
    (2, "Couldn't sleep again."),
    (3, "Yeah. Me too. Been a while since I did."),
    (5, "Listen. Eyes closed."),
    (6, "There's three notes the dark keeps."),
    (7, "Low. Lower. Home."),
    (8, "Same three, every night I don't sleep."),
    (9, "That's the trick of it, see."),
    (10, "You don't count sheep out this far."),
    (11, "You count the ones that hum the bar."),
    (13, "One for the long dark."),
    (14, "One for the long road."),
    (15, "One for the porch we left on."),
    (17, "Go on now. Eyes shut."),
    (18, "I got the watch. I got the hold."),
]


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print("$", " ".join(shlex.quote(c) for c in cmd))
    return subprocess.run(cmd, check=True, **kwargs)


def synth_phrase(api_key: str, text: str, out_path: Path) -> None:
    """Synthesize a single phrase via ElevenLabs v3."""
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {"xi-api-key": api_key, "accept": "audio/mpeg", "content-type": "application/json"}
    body = {
        "text": f"{TAGS_OPEN} {text}",
        "model_id": MODEL,
        "voice_settings": {
            "stability": 0.55,
            "similarity_boost": 0.75,
            "style": 0.35,
            "use_speaker_boost": True,
        },
    }
    r = requests.post(url, headers=headers, json=body, timeout=120)
    if r.status_code != 200:
        raise RuntimeError(f"TTS failed ({r.status_code}): {r.text[:300]}")
    out_path.write_bytes(r.content)


def to_wav(src: Path, dst: Path, pitch_semitones: float = 0.0) -> None:
    """Decode mp3 to mono 44.1k wav, optionally pitch-shift via rubberband."""
    tmp = dst.with_suffix(".pre.wav")
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(src),
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        str(tmp),
    ])
    if pitch_semitones != 0.0:
        run([
            "rubberband", "-q", "--formant",
            "-p", f"{pitch_semitones}",
            str(tmp), str(dst),
        ])
        tmp.unlink()
    else:
        tmp.rename(dst)


def probe_duration(path: Path) -> float:
    out = subprocess.check_output([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]).decode().strip()
    return float(out)


def trim_silence(src: Path, dst: Path) -> None:
    """Strip leading/trailing silence so phrase head lines up with slot start."""
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(src),
        "-af", "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB:"
               "stop_periods=1:stop_silence=0.05:stop_threshold=-50dB",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(dst),
    ])


def build_voice_track(phrases_with_slots: list[tuple[int, Path]], total_slots: int, out_path: Path) -> float:
    """Place each phrase wav onto its 2s slot in a master timeline."""
    total_seconds = total_slots * SLOT_SECONDS + 1.0
    inputs: list[str] = []
    filters: list[str] = []
    for i, (slot_idx, wav_path) in enumerate(phrases_with_slots):
        inputs += ["-i", str(wav_path)]
        delay_ms = int(slot_idx * SLOT_SECONDS * 1000)
        filters.append(f"[{i}]adelay={delay_ms}|{delay_ms}[v{i}]")
    mix_inputs = "".join(f"[v{i}]" for i in range(len(phrases_with_slots)))
    filters.append(f"{mix_inputs}amix=inputs={len(phrases_with_slots)}:normalize=0[mix]")
    filters.append(f"[mix]apad=whole_dur={total_seconds},atrim=duration={total_seconds}[out]")
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        *inputs,
        "-filter_complex", ";".join(filters),
        "-map", "[out]",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(out_path),
    ])
    return total_seconds


def make_squelch(out_path: Path, duration: float) -> None:
    """A burst of bandpassed white noise — the 'kssht' on PTT release."""
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"anoisesrc=color=white:duration={duration}:amplitude=0.45",
        "-af", f"highpass=f=1200,lowpass=f=4500,"
               f"volume=0.30,"
               f"afade=t=in:st=0:d=0.02,afade=t=out:st={max(0,duration-0.08):.3f}:d={min(0.08,duration):.3f}",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(out_path),
    ])


def make_hiss(out_path: Path, duration: float) -> None:
    """Pink-noise hiss bed. Bookended fade-in/out around the squelches only —
    silent through the middle so the voice sits clean. The hiss is a tiny halo
    on the transmission bookends, not a layer over the speech."""
    head_fade = 0.4    # ramp in during the squelch-in
    tail_start = max(0.0, duration - 0.7)
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"anoisesrc=color=pink:duration={duration}:amplitude=0.10",
        "-af", "highpass=f=600,lowpass=f=3500,"
               f"volume=0.10,"
               f"afade=t=in:st=0:d={head_fade},"
               f"afade=t=out:st={head_fade}:d=0.3,"
               f"afade=t=in:st={tail_start}:d=0.3,"
               f"afade=t=out:st={tail_start+0.4}:d=0.3",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(out_path),
    ])


def make_crackle(out_path: Path, duration: float) -> None:
    """Silent placeholder — the continuous crackle layer was removed because it
    was reading as 'too much static.' The squelch bookends carry all the
    transmission character now; the body of the take stays clean."""
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"anullsrc=duration={duration}:sample_rate={SAMPLE_RATE}",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(out_path),
    ])


def apply_radio_fx(voice_in: Path, voice_out: Path) -> None:
    """Bandpass + chest EQ + compression + light bitcrush on the voice track."""
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(voice_in),
        "-af",
        "highpass=f=380,lowpass=f=2700,"
        "equalizer=f=160:t=q:w=1.2:g=3.5,"
        "equalizer=f=2200:t=q:w=1.5:g=2.0,"
        "acompressor=threshold=-20dB:ratio=4:attack=5:release=80,"
        "aeval='floor(val(0)*64)/64':c=same,"
        "volume=1.3",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(voice_out),
    ])


def mix_final(voice: Path, hiss: Path, crackle: Path, squelch_in: Path, squelch_out: Path,
              squelch_out_offset: float, total_seconds: float, out_mp3: Path) -> None:
    """Layer voice + hiss + crackle, then bookend with squelches."""
    sq_out_ms = int(squelch_out_offset * 1000)
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(voice),
        "-i", str(hiss),
        "-i", str(crackle),
        "-i", str(squelch_in),
        "-i", str(squelch_out),
        "-filter_complex",
        f"[4]adelay={sq_out_ms}|{sq_out_ms}[sqout];"
        "[0][1][2][3][sqout]amix=inputs=5:normalize=0:duration=longest[m];"
        f"[m]atrim=duration={total_seconds},"
        "loudnorm=I=-20:TP=-3:LRA=11[final]",
        "-map", "[final]",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        "-c:a", "libmp3lame", "-b:a", "128k",
        str(out_mp3),
    ])


def build_variant(api_key: str, name: str, script: list[tuple[int, str]], workdir: Path) -> Path:
    """Synth + assemble one variant. Returns path to the final mp3."""
    print(f"\n=== {name} ===")
    workdir.mkdir(parents=True, exist_ok=True)
    placed_phrase_wavs: list[tuple[int, Path]] = []
    for i, (slot_idx, text) in enumerate(script):
        raw_mp3 = workdir / f"phrase_{i:02d}_raw.mp3"
        shifted_wav = workdir / f"phrase_{i:02d}_shift.wav"
        trimmed_wav = workdir / f"phrase_{i:02d}_trim.wav"
        print(f"  [{i:02d}] slot={slot_idx:>2}  text={text!r}")
        synth_phrase(api_key, text, raw_mp3)
        to_wav(raw_mp3, shifted_wav, pitch_semitones=PITCH_SEMITONES)
        trim_silence(shifted_wav, trimmed_wav)
        dur = probe_duration(trimmed_wav)
        print(f"        -> {dur:.2f}s (slot capacity {SLOT_SECONDS}s)")
        if dur > SLOT_SECONDS * 1.8:
            print(f"        WARN: phrase exceeds 1.8 slots; will overlap next slot")
        placed_phrase_wavs.append((slot_idx, trimmed_wav))

    last_slot = max(s for s, _ in script)
    last_phrase_dur = probe_duration(placed_phrase_wavs[-1][1])
    voice_end = last_slot * SLOT_SECONDS + last_phrase_dur
    total_seconds = voice_end + SQUELCH_OUT + 0.3
    total_slots = int((total_seconds + SLOT_SECONDS - 1) // SLOT_SECONDS)

    voice_raw = workdir / "voice_placed.wav"
    build_voice_track(placed_phrase_wavs, total_slots, voice_raw)

    voice_fx = workdir / "voice_fx.wav"
    apply_radio_fx(voice_raw, voice_fx)

    hiss = workdir / "hiss.wav"
    crackle = workdir / "crackle.wav"
    squelch_in = workdir / "squelch_in.wav"
    squelch_out = workdir / "squelch_out.wav"
    make_hiss(hiss, total_seconds)
    make_crackle(crackle, total_seconds)
    make_squelch(squelch_in, SQUELCH_IN)
    make_squelch(squelch_out, SQUELCH_OUT)

    final_mp3 = OUT_DIR / f"pilot-log-2-{name}-ralf.mp3"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mix_final(voice_fx, hiss, crackle, squelch_in, squelch_out,
              squelch_out_offset=voice_end,
              total_seconds=total_seconds,
              out_mp3=final_mp3)
    print(f"  -> wrote {final_mp3} ({probe_duration(final_mp3):.2f}s)")
    return final_mp3


def main() -> None:
    api_key = load_api_key()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pilot-log-2-") as td:
        td_path = Path(td)
        a = build_variant(api_key, "variant-a", VARIANT_A, td_path / "variant-a")
        b = build_variant(api_key, "variant-b", VARIANT_B, td_path / "variant-b")
    print("\nDone.")
    print(f"  Variant A: {a}")
    print(f"  Variant B: {b}")


if __name__ == "__main__":
    main()
