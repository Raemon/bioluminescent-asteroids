"""Generate pilot-log-2 — one-shot ElevenLabs, beat-resynced, two final flavors.

Pipeline:
  1. ElevenLabs v3, one-shot synth of the whole script with directorial tags.
     Tags target hints-of-lullaby-but-slightly-cracked, not pure lullaby.
  2. Whisper-tiny coverage check on the raw mp3, retry up to MAX_ATTEMPTS.
  3. Decode -> wav, pitch -1 semitone (rubberband, formant-preserved).
  4. Apply the full radio FX chain (chest+presence EQ, bandpass, compressor).
  5. Branch into two final variants:
       a. _loudnorm:  + volume 1.3 + loudnorm I=-18:TP=-2:LRA=11
       b. _bitcrush:  + bitcrush floor(val*64)/64
  6. For each variant, silencedetect + slot-quantize onto the 2.0s downbeat
     grid so phrases land on beats.
  7. Staple the 0.35s opening static clip onto the front of each (concat —
     not mixed under the voice).

Outputs:
  raw/oneshot_attempt<N>_cov<C>.mp3
  raw/oneshot_CHOSEN.mp3
  pilot-log-2-takes/pilot-log-2-loudnorm.mp3
  pilot-log-2-takes/pilot-log-2-bitcrush.mp3

The user picks which flavor to promote to public/sounds/vocals/pilot-log-2.mp3
after auditioning both.
"""

import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import requests

VOICE_ID = "A9evEp8yGjv4c3WsIKuY"  # PL_Ralf_Deep
MODEL = "eleven_v3"
SLOT_SECONDS = 2.0
PITCH_SEMITONES = -1.0
SAMPLE_RATE = 44100
COVERAGE_THRESHOLD = 0.85
MAX_ATTEMPTS = 3
SILENCE_NOISE_DB = -38
SILENCE_MIN_DUR = 0.30
OPEN_STATIC_SECONDS = 0.35

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / ".env"
OUT_DIR = REPO_ROOT / "public" / "sounds" / "vocals" / "pilot-log-2-takes"
RAW_DIR = OUT_DIR / "raw"

# Tags target: weary, slightly off, hints of lullaby cadence — not full lullaby.
# Earlier takes were "too lullaby-ish". Dropped [murmuring][slowly] (gentle),
# kept [low voice][gravelly][weary], added [unsettled] for the slight-crazy hint.
TAGS = "[low voice][gravelly][weary][unsettled]"

# Paragraph breaks become longer pauses; line breaks become shorter ones. The
# whitespace layout matches the design doc in scripts/pilotlog.md.
SCRIPT = (
    "Couldn't sleep, huh.\n\n"
    "Listen.\n\n"
    "Close your eyes.\n\n"
    "Here's three notes out here. "
    "Same three, every time. Counted 'em.\n\n"
    "One coming low, that you feel in your bones. "
    "One droning on till it tickles your throat. "
    "One swelling up, like it's calling you home.\n\n"
    "That's the trick, see. "
    "You don't count sheep out here. "
    "You count the ones that sing back."
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
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {"xi-api-key": api_key, "accept": "audio/mpeg", "content-type": "application/json"}
    body = {
        "text": f"{TAGS}\n\n{full_text}",
        "model_id": MODEL,
        "voice_settings": {
            "stability": 0.45,        # slightly lower than before -> more variation
            "similarity_boost": 0.75,
            "style": 0.50,            # slightly higher -> more performance, less neutral
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


def probe_duration(path: Path) -> float:
    out = subprocess.check_output([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]).decode().strip()
    return float(out)


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


def to_wav(src: Path, dst: Path, pitch_semitones: float = 0.0) -> None:
    """Decode -> mono 44.1k wav, optionally pitch-shift (formant-preserved)."""
    pre = dst.with_suffix(".pre.wav")
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-ac", "1", "-ar", str(SAMPLE_RATE), str(pre)])
    if pitch_semitones != 0.0:
        run(["rubberband", "-q", "--formant", "-p", f"{pitch_semitones}",
             str(pre), str(dst)])
        pre.unlink()
    else:
        pre.rename(dst)


def apply_radio_chain(voice_in: Path, voice_out: Path) -> None:
    """Chest EQ + presence + bandpass + compressor. No bitcrush, no loudnorm
    — those are the per-variant tail filters that get added after this."""
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(voice_in),
        "-af",
        "equalizer=f=160:t=q:w=1.2:g=3.5,"
        "equalizer=f=2200:t=q:w=1.5:g=2.0,"
        "highpass=f=380,lowpass=f=2700,"
        "acompressor=threshold=-20dB:ratio=4:attack=5:release=80",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(voice_out),
    ])


def apply_loudnorm_tail(voice_in: Path, voice_out: Path) -> None:
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(voice_in),
         "-af", "volume=1.3,loudnorm=I=-18:TP=-2:LRA=11",
         "-ar", str(SAMPLE_RATE), "-ac", "1", str(voice_out)])


def apply_bitcrush_tail(voice_in: Path, voice_out: Path) -> None:
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(voice_in),
         "-af", "aeval='floor(val(0)*64)/64':c=same,volume=1.3",
         "-ar", str(SAMPLE_RATE), "-ac", "1", str(voice_out)])


def detect_silences(wav_path: Path) -> list[tuple[float, float]]:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(wav_path),
         "-af", f"silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_DUR}",
         "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    silences: list[tuple[float, float]] = []
    cur_start: float | None = None
    for line in result.stderr.splitlines():
        m = re.search(r"silence_start: ([0-9.]+)", line)
        if m:
            cur_start = float(m.group(1))
        m = re.search(r"silence_end: ([0-9.]+)", line)
        if m and cur_start is not None:
            silences.append((cur_start, float(m.group(1))))
            cur_start = None
    return silences


def extract_phrases(wav_path: Path, total_dur: float, workdir: Path,
                     tag: str) -> list[Path]:
    """Slice the wav into phrase wavs along detected silences."""
    silences = detect_silences(wav_path)
    phrases: list[tuple[float, float]] = []
    prev_end = 0.0
    for s_start, s_end in silences:
        if s_start > prev_end + 0.05:
            phrases.append((prev_end, s_start))
        prev_end = s_end
    if prev_end < total_dur - 0.05:
        phrases.append((prev_end, total_dur))
    phrases = [(a, b) for a, b in phrases if (b - a) >= 0.15]

    print(f"  [{tag}] silence-detected {len(phrases)} phrases:")
    for i, (a, b) in enumerate(phrases):
        print(f"    [{i:02d}] {a:.2f}s -> {b:.2f}s ({b-a:.2f}s)")

    paths: list[Path] = []
    for i, (start, end) in enumerate(phrases):
        out = workdir / f"{tag}_phrase_{i:02d}.wav"
        pad_end = min(0.05, max(0.0, total_dur - end))
        run([
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(wav_path),
            "-ss", f"{max(0, start - 0.02):.3f}",
            "-to", f"{end + pad_end:.3f}",
            "-ar", str(SAMPLE_RATE), "-ac", "1",
            str(out),
        ])
        paths.append(out)
    return paths


def quantize_to_grid(phrase_paths: list[Path], out_path: Path) -> float:
    """Place each phrase at the next free 2.0s downbeat slot. A phrase longer
    than one slot gets the slots it needs, and the next phrase starts one slot
    after the previous one ends. Captain's first phrase starts at t=0."""
    placements: list[tuple[float, Path]] = []
    next_slot_time = 0.0
    for path in phrase_paths:
        dur = probe_duration(path)
        slots_needed = max(1, int((dur + 0.4) // SLOT_SECONDS) + 1)
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


def make_open_static(out_path: Path, duration: float) -> None:
    """Standalone opening 'kssht'. Concatenated onto the front; not mixed."""
    fade_out = min(0.18, duration * 0.6)
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"anoisesrc=color=white:duration={duration}:amplitude=0.45",
        "-af", f"highpass=f=1200,lowpass=f=4500,"
               f"volume=0.30,"
               f"afade=t=in:st=0:d=0.02,"
               f"afade=t=out:st={max(0, duration - fade_out):.3f}:d={fade_out:.3f}",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(out_path),
    ])


def staple_static(voice_wav: Path, static_wav: Path, out_mp3: Path) -> None:
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(static_wav),
        "-i", str(voice_wav),
        "-filter_complex",
        f"[0:a]aformat=sample_rates={SAMPLE_RATE}:channel_layouts=mono[s];"
        f"[1:a]aformat=sample_rates={SAMPLE_RATE}:channel_layouts=mono[v];"
        f"[s][v]concat=n=2:v=0:a=1[out]",
        "-map", "[out]",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        "-c:a", "libmp3lame", "-b:a", "128k",
        str(out_mp3),
    ])


def build_variant(pitched_wav: Path, workdir: Path, tag: str,
                   tail_fn, out_mp3: Path, open_static: Path) -> None:
    """tail_fn applies the per-variant tail filter (loudnorm or bitcrush) to
    the radio-chain wav. Then slot-quantize, then staple static."""
    chain_wav = workdir / f"{tag}_chain.wav"
    apply_radio_chain(pitched_wav, chain_wav)

    tail_wav = workdir / f"{tag}_tail.wav"
    tail_fn(chain_wav, tail_wav)

    total = probe_duration(tail_wav)
    phrase_wavs = extract_phrases(tail_wav, total, workdir, tag)

    quantized = workdir / f"{tag}_quantized.wav"
    quantize_to_grid(phrase_wavs, quantized)

    staple_static(quantized, open_static, out_mp3)
    print(f"  wrote {out_mp3.name} ({probe_duration(out_mp3):.2f}s)")


def main() -> None:
    api_key = load_api_key()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pilot-log-2-oneshot-") as td:
        workdir = Path(td)

        best_raw: Path | None = None
        best_cov = -1.0
        best_attempt = -1
        for attempt in range(MAX_ATTEMPTS):
            print(f"attempt {attempt+1}: one-shot synth")
            raw_mp3 = workdir / f"oneshot_a{attempt}.mp3"
            synth_oneshot(api_key, SCRIPT, raw_mp3)
            transcript = whisper_transcribe(raw_mp3)
            cov, missing = coverage(SCRIPT, transcript)
            dur = probe_duration(raw_mp3)
            print(f"  dur={dur:.2f}s cov={cov:.2f}")
            print(f"  heard: {transcript!r}")
            print(f"  missing: {missing}")

            shutil.copy2(raw_mp3, RAW_DIR / f"oneshot_attempt{attempt+1}_cov{cov:.2f}.mp3")
            if cov > best_cov:
                best_cov = cov
                best_raw = raw_mp3
                best_attempt = attempt
            if cov >= COVERAGE_THRESHOLD:
                print("  -> cleared threshold")
                break
        else:
            print(f"WARN: best cov={best_cov:.2f} after {MAX_ATTEMPTS} attempts")

        assert best_raw is not None
        shutil.copy2(best_raw, RAW_DIR / "oneshot_CHOSEN.mp3")

        pitched = workdir / "pitched.wav"
        to_wav(best_raw, pitched, pitch_semitones=PITCH_SEMITONES)

        open_static = workdir / "open_static.wav"
        make_open_static(open_static, OPEN_STATIC_SECONDS)

        loudnorm_out = OUT_DIR / "pilot-log-2-loudnorm.mp3"
        bitcrush_out = OUT_DIR / "pilot-log-2-bitcrush.mp3"
        build_variant(pitched, workdir, "loudnorm",
                      apply_loudnorm_tail, loudnorm_out, open_static)
        build_variant(pitched, workdir, "bitcrush",
                      apply_bitcrush_tail, bitcrush_out, open_static)

    print(f"\nDone. Audition both:")
    print(f"  loudnorm flavor:  {loudnorm_out}")
    print(f"  bitcrush flavor:  {bitcrush_out}")
    print(f"Tell me which to promote to public/sounds/vocals/pilot-log-2.mp3.")


if __name__ == "__main__":
    main()
