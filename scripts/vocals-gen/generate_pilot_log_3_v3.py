"""Regenerate pilot-log-3 and PRESERVE the raw direct-from-ElevenLabs mp3s.

Two outputs per phrase per variant:
1. The raw ElevenLabs response — public/sounds/vocals/pilot-log-3-takes/raw/
2. The processed/assembled final take — public/sounds/vocals/pilot-log-3-takes/

Per-phrase Whisper verification runs against the trimmed pitched wav (so we
know what Ralf actually said), but the raw mp3 is saved regardless of pass/fail
so the user can audition what came back from the model unprocessed.

For each attempt, the raw mp3 is named:
  raw/<variant>/phrase_<idx>_attempt<N>_cov<C>.mp3

so the user can see exactly which take was generated, what Whisper heard, and
whether it cleared threshold. The accepted (best) attempt is also symlinked /
copied to phrase_<idx>_accepted.mp3 for easy auditioning.
"""

import re
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path

import requests

VOICE_ID = "A9evEp8yGjv4c3WsIKuY"
MODEL = "eleven_v3"
SLOT_SECONDS = 2.0
SQUELCH_IN = 0.22
PITCH_SEMITONES = -1.0
SAMPLE_RATE = 44100
MAX_ATTEMPTS = 6
COVERAGE_THRESHOLD = 0.75
INTERPHRASE_GAP = 0.15

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / ".env"
OUT_DIR = REPO_ROOT / "public" / "sounds" / "vocals" / "pilot-log-3-takes"
RAW_DIR = OUT_DIR / "raw"

TAGS_STANDARD = "[low voice][gravelly][slowly][weary][murmuring]"
TAGS_NO_MURMUR = "[low voice][gravelly][slowly][weary]"
TAGS_PLAIN = "[low voice][gravelly]"

VARIANT_A = [
    (1, "Hey, kid."),
    (2, "Long one tonight."),
    (3, "Hands went cold around hour four."),
    (4, "You know that knuckle that locks up? Locked."),
    (6, "Bent it loose against the console."),
    (7, "Hurts in a way I had forgotten about."),
    (9, "Coffee's been gone since Tuesday."),
    (10, "I miscounted the packets."),
    (11, "Tell your mother that one. She'll laugh."),
    (13, "...You should be asleep. I'm fine out here. Go on."),
]

VARIANT_B = [
    (1, "Hey, kid."),
    (2, "Long shift."),
    (3, "Cold start, slow heart, knuckle locked around hour four."),
    (5, "Bent it loose on the console."),
    (6, "Stings now in a way I half-forgot."),
    (8, "Coffee's been gone since Tuesday."),
    (9, "Miscounted the packets. Pack of fool, this old man."),
    (11, "Tell your mother. She'll laugh and she'll know."),
    (13, "...You should be down. I'm fine up here."),
    (14, "Go on, now. Go on."),
]


def load_api_key() -> str:
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith("ELEVENLABS_API_KEY"):
            _, _, val = line.partition("=")
            return val.strip().strip('"').strip("'")
    raise RuntimeError("ELEVENLABS_API_KEY not found in .env")


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kwargs)


def synth_phrase(api_key: str, tagged_text: str, out_path: Path) -> None:
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {"xi-api-key": api_key, "accept": "audio/mpeg", "content-type": "application/json"}
    body = {
        "text": tagged_text,
        "model_id": MODEL,
        "voice_settings": {
            "stability": 0.55,
            "similarity_boost": 0.75,
            "style": 0.35,
            "use_speaker_boost": True,
        },
    }
    last_exc: Exception | None = None
    for net_attempt in range(3):
        try:
            r = requests.post(url, headers=headers, json=body, timeout=180)
            if r.status_code != 200:
                raise RuntimeError(f"TTS failed ({r.status_code}): {r.text[:300]}")
            out_path.write_bytes(r.content)
            return
        except (requests.exceptions.ReadTimeout,
                requests.exceptions.ConnectionError) as e:
            last_exc = e
            print(f"      network retry {net_attempt+1}/3 after {type(e).__name__}")
            import time; time.sleep(2 ** net_attempt)
    raise RuntimeError(f"TTS network failure after 3 retries: {last_exc}")


def to_wav(src: Path, dst: Path, pitch_semitones: float = 0.0) -> None:
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
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(src),
        "-af", "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB:"
               "stop_periods=1:stop_silence=0.08:stop_threshold=-55dB",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(dst),
    ])


_whisper_model = None


def whisper_transcribe(audio_path: Path) -> str:
    global _whisper_model
    if _whisper_model is None:
        import whisper
        _whisper_model = whisper.load_model("tiny")
    result = _whisper_model.transcribe(str(audio_path), language="en", fp16=False)
    return result["text"].strip()


def normalize_words(s: str) -> set[str]:
    s = s.lower()
    s = re.sub(r"\[[^\]]*\]", " ", s)
    s = s.replace("'", "")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return {t for t in s.split() if t}


def phrase_coverage(expected: str, transcript: str) -> tuple[float, list[str]]:
    e = normalize_words(expected)
    t = normalize_words(transcript)
    if not e:
        return 1.0, []
    missing = [w for w in e if w not in t]
    return (len(e) - len(missing)) / len(e), missing


def synth_with_verification(
    api_key: str,
    text: str,
    workdir: Path,
    raw_phrase_dir: Path,
    idx: int,
) -> Path:
    """Synthesize and verify Whisper hears most of the content. Saves every raw
    ElevenLabs response to raw_phrase_dir so the user can audition them later."""
    prompts = [
        f"{TAGS_STANDARD} {text}",
        f"{TAGS_NO_MURMUR} {text}",
        f"{TAGS_STANDARD} {text}",
        f"{TAGS_NO_MURMUR} Hmm. {text}",
        f"{TAGS_PLAIN} {text}",
        f"{TAGS_PLAIN} ... {text}",
    ]

    best_wav: Path | None = None
    best_raw: Path | None = None
    best_cov = -1.0
    best_dur = 0.0
    best_heard = ""

    raw_phrase_dir.mkdir(parents=True, exist_ok=True)

    for attempt in range(MAX_ATTEMPTS):
        prompt = prompts[min(attempt, len(prompts) - 1)]
        raw_mp3 = workdir / f"phrase_{idx:02d}_a{attempt}_raw.mp3"
        shifted_wav = workdir / f"phrase_{idx:02d}_a{attempt}_shift.wav"
        trimmed_wav = workdir / f"phrase_{idx:02d}_a{attempt}_trim.wav"
        synth_phrase(api_key, prompt, raw_mp3)
        to_wav(raw_mp3, shifted_wav, pitch_semitones=PITCH_SEMITONES)
        trim_silence(shifted_wav, trimmed_wav)
        dur = probe_duration(trimmed_wav)
        transcript = whisper_transcribe(trimmed_wav)
        cov, missing = phrase_coverage(text, transcript)
        print(f"    attempt {attempt+1}: dur={dur:.2f}s cov={cov:.2f} heard={transcript!r}")

        # Persist the raw ElevenLabs response — unmodified, no pitch-shift,
        # no trim, no radio FX. Filename encodes whether it cleared threshold.
        archive_name = f"phrase_{idx:02d}_attempt{attempt+1}_cov{cov:.2f}.mp3"
        shutil.copy2(raw_mp3, raw_phrase_dir / archive_name)

        if cov > best_cov:
            best_cov = cov
            best_wav = trimmed_wav
            best_raw = raw_mp3
            best_dur = dur
            best_heard = transcript
        if cov >= COVERAGE_THRESHOLD:
            # Also stash the accepted raw mp3 under a memorable name
            shutil.copy2(raw_mp3, raw_phrase_dir / f"phrase_{idx:02d}_ACCEPTED.mp3")
            return trimmed_wav

    print(f"    WARN: best cov={best_cov:.2f} after {MAX_ATTEMPTS} attempts; heard={best_heard!r}")
    assert best_wav is not None and best_raw is not None
    shutil.copy2(best_raw, raw_phrase_dir / f"phrase_{idx:02d}_BEST_FAIL.mp3")
    return best_wav


def build_voice_track_with_collision_avoidance(
    phrases: list[tuple[int, Path]],
    out_path: Path,
) -> float:
    placements: list[tuple[float, Path]] = []
    last_end = 0.0
    for slot_idx, wav_path in phrases:
        intended_start = slot_idx * SLOT_SECONDS
        actual_start = max(intended_start, last_end + INTERPHRASE_GAP)
        dur = probe_duration(wav_path)
        placements.append((actual_start, wav_path))
        last_end = actual_start + dur
        if actual_start > intended_start:
            print(f"    slot collision: pushed from {intended_start:.2f}s -> {actual_start:.2f}s")

    total_seconds = last_end + 0.5
    inputs: list[str] = []
    filters: list[str] = []
    for i, (start, wav_path) in enumerate(placements):
        inputs += ["-i", str(wav_path)]
        delay_ms = int(start * 1000)
        filters.append(f"[{i}]adelay={delay_ms}|{delay_ms}[v{i}]")
    mix_inputs = "".join(f"[v{i}]" for i in range(len(placements)))
    filters.append(f"{mix_inputs}amix=inputs={len(placements)}:normalize=0[mix]")
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
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"anoisesrc=color=white:duration={duration}:amplitude=0.45",
        "-af", f"highpass=f=1200,lowpass=f=4500,"
               f"volume=0.30,"
               f"afade=t=in:st=0:d=0.02,afade=t=out:st={max(0,duration-0.08):.3f}:d={min(0.08,duration):.3f}",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(out_path),
    ])


def apply_radio_fx(voice_in: Path, voice_out: Path) -> None:
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


def mix_final(voice: Path, squelch_in: Path, total_seconds: float, out_mp3: Path) -> None:
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(voice),
        "-i", str(squelch_in),
        "-filter_complex",
        "[0][1]amix=inputs=2:normalize=0:duration=longest[m];"
        f"[m]atrim=duration={total_seconds},"
        "loudnorm=I=-18:TP=-2:LRA=11[final]",
        "-map", "[final]",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        "-c:a", "libmp3lame", "-b:a", "128k",
        str(out_mp3),
    ])


def build_variant(api_key: str, name: str, script: list[tuple[int, str]], workdir: Path) -> Path:
    print(f"\n=== {name} ===")
    workdir.mkdir(parents=True, exist_ok=True)
    raw_dir = RAW_DIR / name
    placed: list[tuple[int, Path]] = []
    for i, (slot_idx, text) in enumerate(script):
        print(f"  [{i:02d}] slot={slot_idx:>2}  text={text!r}")
        wav = synth_with_verification(api_key, text, workdir, raw_dir, i)
        placed.append((slot_idx, wav))

    voice_raw = workdir / "voice_placed.wav"
    total_seconds = build_voice_track_with_collision_avoidance(placed, voice_raw)

    voice_fx = workdir / "voice_fx.wav"
    apply_radio_fx(voice_raw, voice_fx)

    squelch_in = workdir / "squelch_in.wav"
    make_squelch(squelch_in, SQUELCH_IN)

    final_mp3 = OUT_DIR / f"pilot-log-3-{name}-ralf.mp3"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mix_final(voice_fx, squelch_in, total_seconds, final_mp3)
    print(f"  -> wrote {final_mp3} ({probe_duration(final_mp3):.2f}s)")
    return final_mp3


def main() -> None:
    api_key = load_api_key()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pilot-log-3-v3-") as td:
        td_path = Path(td)
        a = build_variant(api_key, "variant-a", VARIANT_A, td_path / "variant-a")
        b = build_variant(api_key, "variant-b", VARIANT_B, td_path / "variant-b")
    print("\nDone.")
    print(f"  Variant A: {a}")
    print(f"  Variant B: {b}")
    print(f"  Raw mp3s: {RAW_DIR}/")


if __name__ == "__main__":
    main()
