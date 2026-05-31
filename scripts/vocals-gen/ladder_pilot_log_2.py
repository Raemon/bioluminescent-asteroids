"""Generate a fresh Entry 2 take from ElevenLabs, then render a ladder of
variants with progressively riskier filters stapled with the same opening
static. The user A/Bs them to identify where the sound becomes unpleasant.

Variants (each builds on the previous; safest first):
  v0_raw                 : ElevenLabs output untouched
  v1_pitch               : + pitch -1 semitone (rubberband, formant-preserved)
  v2_chestEQ             : + EQ +3.5dB at 160Hz (chest warmth)
  v3_presenceEQ          : + EQ +2.0dB at 2200Hz (presence)
  v4_highpass            : + highpass 380Hz (cuts low rumble — radio-ish)
  v5_lowpass             : + lowpass 2700Hz (cuts air — full radio bandpass)
  v6_compressor          : + acompressor threshold=-20 ratio=4
  v7_loudnorm            : + volume 1.3 + loudnorm I=-18:TP=-2:LRA=11
  v8_bitcrush            : + bitcrush floor(val*64)/64 (KNOWN STATIC SOURCE)

All variants are stapled to the same opening static and written as:
  public/sounds/vocals/pilot-log-2-takes/ladder/pilot-log-2-vN_<name>.mp3
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
SAMPLE_RATE = 44100
COVERAGE_THRESHOLD = 0.85
MAX_ATTEMPTS = 3
OPEN_STATIC_SECONDS = 0.35

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / ".env"
RAW_DIR = REPO_ROOT / "public" / "sounds" / "vocals" / "pilot-log-2-takes" / "raw"
LADDER_DIR = REPO_ROOT / "public" / "sounds" / "vocals" / "pilot-log-2-takes" / "ladder"

TAGS = "[low voice][gravelly][slowly][weary][murmuring]"

SCRIPT = (
    "Couldn't sleep, huh.\n\n"
    "Listen. Close your eyes. "
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


def make_open_static(out_path: Path, duration: float) -> None:
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


def to_wav(src: Path, dst: Path) -> None:
    """Decode mp3 -> mono 44.1k wav. No processing."""
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-ac", "1", "-ar", str(SAMPLE_RATE), str(dst)])


def apply_pitch(src_wav: Path, dst_wav: Path) -> None:
    """Pitch -1 semitone, formant-preserved. No other change."""
    run(["rubberband", "-q", "--formant", "-p", "-1.0", str(src_wav), str(dst_wav)])


def apply_af(src_wav: Path, dst_wav: Path, af: str) -> None:
    """Apply an ffmpeg -af filter chain to src_wav -> dst_wav."""
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src_wav),
         "-af", af, "-ar", str(SAMPLE_RATE), "-ac", "1", str(dst_wav)])


def staple_static(voice_wav: Path, static_wav: Path, out_mp3: Path) -> None:
    """concat[static, voice_wav] -> mp3. Voice is not re-EQ'd here, just glued."""
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


# Each ladder rung is built from the previous rung's wav by applying one new
# filter. The rungs are named and have a short description for the user.
LADDER = [
    ("v0_raw",          None),
    ("v1_pitch",        None),  # pitch step uses rubberband, not -af
    ("v2_chestEQ",      "equalizer=f=160:t=q:w=1.2:g=3.5"),
    ("v3_presenceEQ",   "equalizer=f=2200:t=q:w=1.5:g=2.0"),
    ("v4_highpass",     "highpass=f=380"),
    ("v5_lowpass",      "lowpass=f=2700"),
    ("v6_compressor",   "acompressor=threshold=-20dB:ratio=4:attack=5:release=80"),
    ("v7_loudnorm",     "volume=1.3,loudnorm=I=-18:TP=-2:LRA=11"),
    ("v8_bitcrush",     "aeval='floor(val(0)*64)/64':c=same"),
]


def build_ladder(raw_mp3: Path, workdir: Path) -> list[Path]:
    """Build each rung as a wav by accumulating filters, then staple static
    onto each rung as a final mp3."""
    open_static = workdir / "open_static.wav"
    make_open_static(open_static, OPEN_STATIC_SECONDS)

    # v0: raw mp3 -> wav, no processing
    v0_wav = workdir / "v0_raw.wav"
    to_wav(raw_mp3, v0_wav)

    # v1: pitch -1 (rubberband, formant-preserved)
    v1_wav = workdir / "v1_pitch.wav"
    apply_pitch(v0_wav, v1_wav)

    # v2..v8: each adds one ffmpeg -af step on top of the previous wav
    prev_wav = v1_wav
    rung_wavs = {"v0_raw": v0_wav, "v1_pitch": v1_wav}
    for name, af in LADDER[2:]:
        out_wav = workdir / f"{name}.wav"
        apply_af(prev_wav, out_wav, af)
        rung_wavs[name] = out_wav
        prev_wav = out_wav

    LADDER_DIR.mkdir(parents=True, exist_ok=True)
    finals: list[Path] = []
    for name, _ in LADDER:
        final = LADDER_DIR / f"pilot-log-2-{name}.mp3"
        staple_static(rung_wavs[name], open_static, final)
        finals.append(final)
        print(f"  wrote {final.name} ({probe_duration(final):.2f}s)")
    return finals


def main() -> None:
    api_key = load_api_key()
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    LADDER_DIR.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="pilot-log-2-ladder-") as td:
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

            shutil.copy2(raw_mp3, RAW_DIR / f"ladder_attempt{attempt+1}_cov{cov:.2f}.mp3")
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
        shutil.copy2(best_raw, RAW_DIR / "ladder_CHOSEN.mp3")

        print(f"\nbuilding ladder from attempt {best_attempt+1} (cov={best_cov:.2f}):")
        finals = build_ladder(best_raw, workdir)

    print(f"\nDone. {len(finals)} rungs in {LADDER_DIR}/")
    print("Play in order — tell me at which rung the sound becomes unpleasant.")


if __name__ == "__main__":
    main()
