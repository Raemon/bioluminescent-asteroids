"""Generate pilot-log-2 — one-shot ElevenLabs synthesis, zero post on the vocal.

The vocal file ElevenLabs returns is passed through *exactly as received*.
No pitch shift, no EQ, no compression, no slot quantization, no loudnorm.
The only thing the pipeline does after synthesis is staple a short opening
static burst onto the front of the mp3.

Pipeline:
  1. One ElevenLabs v3 call with directorial tags at top.
  2. Whisper-tiny coverage check on the raw response (no re-encoding).
     Retry on low score, up to 3 attempts. Save every attempt.
  3. Generate a 0.35s opening static clip (bandpassed white noise).
  4. Concat [static] + [raw ElevenLabs mp3] -> final pilot-log-2.mp3.

Outputs:
  raw/oneshot_attempt<N>_cov<C>.mp3   each attempt's raw response
  raw/oneshot_CHOSEN.mp3              the chosen raw
  pilot-log-2.mp3                     static + raw, no other processing
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
OUT_DIR = REPO_ROOT / "public" / "sounds" / "vocals" / "pilot-log-2-takes"
RAW_DIR = OUT_DIR / "raw"
FINAL_OUT = REPO_ROOT / "public" / "sounds" / "vocals" / "pilot-log-2.mp3"

TAGS = "[low voice][gravelly][slowly][weary][murmuring]"

SCRIPT = (
    "Couldn't sleep, huh. "
    "Fair enough.\n\n"
    "Listen. Close your eyes. "
    "Here's three notes out here. "
    "Same three, every time. Counted 'em.\n\n"
    "One coming low, that you feel in your bones. "
    "One swelling up, like it's calling you home. "
    "One droning on till it tickles your throat.\n\n"
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
    """Standalone opening 'kssht'. Concatenated onto the front of the master;
    NEVER mixed under the voice."""
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


def staple_static_to_raw(raw_mp3: Path, static_wav: Path, out_mp3: Path) -> None:
    """Concat [static] + [untouched ElevenLabs mp3] -> final mp3. The vocal
    is not pitched, EQ'd, compressed, normalized, sliced, or re-mastered. The
    only ffmpeg touch on the vocal is the concat filter glue, which re-encodes
    once at 128k mp3. Everything ElevenLabs sent us about delivery — pacing,
    breath, EQ, level — is preserved."""
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(static_wav),
        "-i", str(raw_mp3),
        "-filter_complex",
        f"[0:a]aformat=sample_rates={SAMPLE_RATE}:channel_layouts=mono[s];"
        f"[1:a]aformat=sample_rates={SAMPLE_RATE}:channel_layouts=mono[v];"
        f"[s][v]concat=n=2:v=0:a=1[out]",
        "-map", "[out]",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        "-c:a", "libmp3lame", "-b:a", "128k",
        str(out_mp3),
    ])


def main() -> None:
    api_key = load_api_key()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pilot-log-2-oneshot-") as td:
        workdir = Path(td)

        best_raw_mp3: Path | None = None
        best_cov = -1.0
        best_attempt = -1
        for attempt in range(MAX_ATTEMPTS):
            print(f"attempt {attempt+1}: one-shot synth")
            raw_mp3 = workdir / f"oneshot_a{attempt}.mp3"
            synth_oneshot(api_key, SCRIPT, raw_mp3)
            dur = probe_duration(raw_mp3)
            transcript = whisper_transcribe(raw_mp3)
            cov, missing = coverage(SCRIPT, transcript)
            print(f"  dur={dur:.2f}s cov={cov:.2f}")
            print(f"  heard: {transcript!r}")
            print(f"  missing: {missing}")

            shutil.copy2(raw_mp3, RAW_DIR / f"oneshot_attempt{attempt+1}_cov{cov:.2f}.mp3")

            if cov > best_cov:
                best_cov = cov
                best_raw_mp3 = raw_mp3
                best_attempt = attempt
            if cov >= COVERAGE_THRESHOLD:
                print("  -> cleared threshold")
                break
        else:
            print(f"WARN: best cov={best_cov:.2f} after {MAX_ATTEMPTS} attempts")

        assert best_raw_mp3 is not None
        shutil.copy2(best_raw_mp3, RAW_DIR / "oneshot_CHOSEN.mp3")

        open_static = workdir / "open_static.wav"
        make_open_static(open_static, OPEN_STATIC_SECONDS)

        FINAL_OUT.parent.mkdir(parents=True, exist_ok=True)
        staple_static_to_raw(best_raw_mp3, open_static, FINAL_OUT)
        print(f"\nwrote {FINAL_OUT} ({probe_duration(FINAL_OUT):.2f}s, "
              f"static {OPEN_STATIC_SECONDS}s + untouched ElevenLabs vocal, "
              f"best cov={best_cov:.2f})")


if __name__ == "__main__":
    main()
