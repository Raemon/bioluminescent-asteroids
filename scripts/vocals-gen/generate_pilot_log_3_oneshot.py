"""Regenerate pilot-log-3 using one-shot ElevenLabs synthesis (Entry-1 style).

Background: the per-phrase approach used since Entry 2 turned out to trigger
v3's swallowed-line failure mode on Entry 3 — Ralf+v3 + heavy directorial tags
on short fragments produced near-silence or garbled syllables for many lines.
This script reverts to Entry 1's strategy:

1. One ElevenLabs call for the entire script.
2. Silence-detect the natural phrase boundaries in the returned audio.
3. Beat-quantize each phrase onto the 2.0s downbeat grid by padding the
   inter-phrase silences.

Trade-off vs per-phrase: less precise slot control (we can't force "hour four"
onto a specific downbeat), but the words actually come out cleanly because
ElevenLabs sees the full script and conditions each line on the previous one.

Outputs preserved:
- Raw one-shot ElevenLabs mp3 → raw/<variant>/oneshot.mp3
- Per-attempt raws (if retried for verification) → raw/<variant>/oneshot_attempt<N>.mp3
- Final assembled take → pilot-log-3-<variant>-ralf.mp3
"""

import re
import shlex
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import requests

VOICE_ID = "A9evEp8yGjv4c3WsIKuY"
MODEL = "eleven_v3"
SLOT_SECONDS = 2.0
PITCH_SEMITONES = -1.0
SAMPLE_RATE = 44100
COVERAGE_THRESHOLD = 0.85  # one-shot should score well; lower is a sign to retry
MAX_ATTEMPTS = 3
SILENCE_NOISE_DB = -38      # silence detection threshold
SILENCE_MIN_DUR = 0.30      # minimum gap to count as inter-phrase

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / ".env"
OUT_DIR = REPO_ROOT / "public" / "sounds" / "vocals" / "pilot-log-3-takes"
RAW_DIR = OUT_DIR / "raw"

# Single directorial tag block at the top — v3 reads it once for the whole
# script, exactly as Entry 1 did. Newlines + punctuation handle the rest.
TAGS = "[low voice][gravelly][slowly][weary][murmuring]"

VARIANT_A_SCRIPT = (
    "Hey, kid. "
    "Long one tonight. Hands went cold around hour four — "
    "you know that knuckle that locks up? Locked. "
    "Bent it loose against the console. "
    "Hurts in a way I'd forgotten about.\n\n"
    "Coffee's been gone since Tuesday. I miscounted the packets. "
    "Tell your mother that one. She'll laugh.\n\n"
    "...You should be asleep. I'm fine out here. Go on."
)

VARIANT_B_SCRIPT = (
    "Hey, kid. "
    "Long shift. Cold start, slow heart, knuckle locked around hour four. "
    "Bent it loose on the console. Stings now in a way I half-forgot.\n\n"
    "Coffee's been gone since Tuesday. "
    "Miscounted the packets — pack of fool, this old man. "
    "Tell your mother. She'll laugh and she'll know.\n\n"
    "...You should be down. I'm fine up here. Go on, now. Go on."
)


def load_api_key() -> str:
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith("ELEVENLABS_API_KEY"):
            _, _, val = line.partition("=")
            return val.strip().strip('"').strip("'")
    raise RuntimeError("ELEVENLABS_API_KEY not found in .env")


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kwargs)


def synth_oneshot(api_key: str, full_text: str, out_path: Path) -> None:
    """One ElevenLabs call for the whole script. v3 with directorial tags at the
    top. Conditioning is per-call, so doing it as one call means each line is
    informed by the previous one — which is exactly what was missing in the
    per-phrase pipeline."""
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {"xi-api-key": api_key, "accept": "audio/mpeg", "content-type": "application/json"}
    body = {
        "text": f"{TAGS}\n\n{full_text}",
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
            r = requests.post(url, headers=headers, json=body, timeout=300)
            if r.status_code != 200:
                raise RuntimeError(f"TTS failed ({r.status_code}): {r.text[:300]}")
            out_path.write_bytes(r.content)
            return
        except (requests.exceptions.ReadTimeout,
                requests.exceptions.ConnectionError) as e:
            last_exc = e
            print(f"    network retry {net_attempt+1}/3 after {type(e).__name__}")
            time.sleep(2 ** net_attempt)
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


def detect_silences(wav_path: Path) -> list[tuple[float, float]]:
    """Return list of (silence_start, silence_end) tuples from ffmpeg silencedetect."""
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(wav_path),
         "-af", f"silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_DUR}",
         "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    output = result.stderr
    silences: list[tuple[float, float]] = []
    cur_start: float | None = None
    for line in output.splitlines():
        m = re.search(r"silence_start: ([0-9.]+)", line)
        if m:
            cur_start = float(m.group(1))
        m = re.search(r"silence_end: ([0-9.]+)", line)
        if m and cur_start is not None:
            silences.append((cur_start, float(m.group(1))))
            cur_start = None
    return silences


def extract_phrases(wav_path: Path, total_dur: float, workdir: Path) -> list[Path]:
    """Slice the one-shot wav into phrase wavs along detected silences."""
    silences = detect_silences(wav_path)
    # Build phrase boundaries: each phrase is from end-of-previous-silence to
    # start-of-next-silence. Leading silence (if any) is dropped; trailing
    # silence likewise.
    phrases: list[tuple[float, float]] = []
    prev_end = 0.0
    for s_start, s_end in silences:
        if s_start > prev_end + 0.05:
            phrases.append((prev_end, s_start))
        prev_end = s_end
    if prev_end < total_dur - 0.05:
        phrases.append((prev_end, total_dur))

    # Skip any "phrase" that's too short to be real speech (clicks, breath).
    phrases = [(a, b) for a, b in phrases if (b - a) >= 0.15]

    print(f"    silence-detected {len(phrases)} phrases:")
    for i, (a, b) in enumerate(phrases):
        print(f"      [{i:02d}] {a:.2f}s -> {b:.2f}s ({b-a:.2f}s)")

    phrase_paths: list[Path] = []
    for i, (start, end) in enumerate(phrases):
        out = workdir / f"phrase_{i:02d}.wav"
        # Pad ends slightly so we don't clip the last consonant.
        pad_end = min(0.05, max(0.0, total_dur - end))
        run([
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(wav_path),
            "-ss", f"{max(0, start - 0.02):.3f}",
            "-to", f"{end + pad_end:.3f}",
            "-ar", str(SAMPLE_RATE), "-ac", "1",
            str(out),
        ])
        phrase_paths.append(out)
    return phrase_paths


def quantize_to_grid(phrase_paths: list[Path], out_path: Path) -> float:
    """Place each phrase at the next 2.0s downbeat slot. If a phrase exceeds
    one slot, give it the slots it needs and start the next phrase one slot
    after the previous one ends. Captain starts at t=0 — there is no squelch
    pre-roll to fill the first slot anymore."""
    placements: list[tuple[float, Path]] = []
    next_slot_time = 0.0
    for path in phrase_paths:
        dur = probe_duration(path)
        slots_needed = max(1, int((dur + 0.4) // SLOT_SECONDS) + 1)  # phrase + a beat of breath
        placements.append((next_slot_time, path))
        next_slot_time += slots_needed * SLOT_SECONDS

    total_seconds = next_slot_time + 0.5

    inputs: list[str] = []
    filters: list[str] = []
    for i, (start, path) in enumerate(placements):
        inputs += ["-i", str(path)]
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

    print(f"    placed {len(placements)} phrases over {total_seconds:.1f}s")
    return total_seconds


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


def coverage(expected: str, transcript: str) -> tuple[float, list[str]]:
    e = normalize_words(expected)
    t = normalize_words(transcript)
    if not e:
        return 1.0, []
    missing = [w for w in e if w not in t]
    return (len(e) - len(missing)) / len(e), missing


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


def mix_final(voice: Path, total_seconds: float, out_mp3: Path) -> None:
    """Voice-only master. No squelch, no hiss, no crackle. The radio character
    comes entirely from the bandpass + chest EQ + bitcrush chain on the voice."""
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(voice),
        "-af", f"atrim=duration={total_seconds},"
               "loudnorm=I=-18:TP=-2:LRA=11",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        "-c:a", "libmp3lame", "-b:a", "128k",
        str(out_mp3),
    ])


def build_variant(api_key: str, name: str, script: str, workdir: Path) -> Path:
    print(f"\n=== {name} ===")
    workdir.mkdir(parents=True, exist_ok=True)
    raw_dir = RAW_DIR / name
    raw_dir.mkdir(parents=True, exist_ok=True)

    # One-shot synth with retry-on-low-coverage. Save every attempt's raw mp3
    # so the user can audition.
    best_pitched_wav: Path | None = None
    best_cov = -1.0
    best_attempt = -1
    for attempt in range(MAX_ATTEMPTS):
        print(f"  attempt {attempt+1}: one-shot synth")
        raw_mp3 = workdir / f"oneshot_a{attempt}.mp3"
        pitched_wav = workdir / f"oneshot_a{attempt}.wav"
        synth_oneshot(api_key, script, raw_mp3)
        to_wav(raw_mp3, pitched_wav, pitch_semitones=PITCH_SEMITONES)
        dur = probe_duration(pitched_wav)
        transcript = whisper_transcribe(pitched_wav)
        cov, missing = coverage(script, transcript)
        print(f"    dur={dur:.2f}s cov={cov:.2f}")
        print(f"    heard: {transcript!r}")
        print(f"    missing: {missing}")

        # Archive the raw response and pitched wav.
        shutil.copy2(raw_mp3, raw_dir / f"oneshot_attempt{attempt+1}_cov{cov:.2f}.mp3")

        if cov > best_cov:
            best_cov = cov
            best_pitched_wav = pitched_wav
            best_attempt = attempt
        if cov >= COVERAGE_THRESHOLD:
            print(f"    -> cleared threshold, using this take")
            break
    else:
        print(f"  WARN: best cov={best_cov:.2f} after {MAX_ATTEMPTS} attempts")

    assert best_pitched_wav is not None
    # Mark the chosen raw with an obvious name.
    chosen_raw = workdir / f"oneshot_a{best_attempt}.mp3"
    shutil.copy2(chosen_raw, raw_dir / "oneshot_CHOSEN.mp3")

    # Slice along silences, quantize to grid, FX, mix in squelch-in.
    total_dur = probe_duration(best_pitched_wav)
    phrase_wavs = extract_phrases(best_pitched_wav, total_dur, workdir)

    voice_quantized = workdir / "voice_quantized.wav"
    total_seconds = quantize_to_grid(phrase_wavs, voice_quantized)

    voice_fx = workdir / "voice_fx.wav"
    apply_radio_fx(voice_quantized, voice_fx)

    final_mp3 = OUT_DIR / f"pilot-log-3-{name}-ralf.mp3"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mix_final(voice_fx, total_seconds, final_mp3)
    print(f"  -> wrote {final_mp3} ({probe_duration(final_mp3):.2f}s, best cov={best_cov:.2f})")
    return final_mp3


def main() -> None:
    api_key = load_api_key()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pilot-log-3-oneshot-") as td:
        td_path = Path(td)
        a = build_variant(api_key, "variant-a", VARIANT_A_SCRIPT, td_path / "variant-a")
        b = build_variant(api_key, "variant-b", VARIANT_B_SCRIPT, td_path / "variant-b")
    print("\nDone.")
    print(f"  Variant A: {a}")
    print(f"  Variant B: {b}")
    print(f"  Raw mp3s: {RAW_DIR}/")


if __name__ == "__main__":
    main()
