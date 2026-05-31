"""Generate the combo-x12 Pilot's Log — Entry Two lullaby content, simple raw audio.

Per user request (2026-05-30): unlike the previous slot-quantized assembly, this
take is *not* fit to the beat. Combo x12 plays playPilotLog(3), which loads
pilot-log-3.mp3, so this script writes the new take to that path. The pipeline:

1. One-shot ElevenLabs synth of the full script (Ralf-deep, v3, tag block).
2. Decode to wav, pitch-shift -1 semitone via rubberband (keeps Ralf's voice
   identity — same -1 as every other Pilot's Log).
3. Apply the radio FX chain (bandpass + chest EQ + presence + comp + bitcrush)
   so it still sounds like a captain on a radio.
4. Prepend a brief squelch-in white-noise burst (the "kssht" on PTT release).
   No hiss bed, no crackle layer, no squelch-out — just the head crackle and
   then the captain's voice playing straight through.
5. Master with loudnorm and encode to mp3.
6. Whisper-verify coverage against the script before declaring done.

Output: public/sounds/vocals/pilot-log-3.mp3
        (overwrites the file loaded by playPilotLog(3) — the combo-x12 trigger)
"""

import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

import requests

VOICE_ID = "A9evEp8yGjv4c3WsIKuY"  # PL_Ralf_Deep
MODEL = "eleven_v3"
PITCH_SEMITONES = -1.0
SAMPLE_RATE = 44100
SQUELCH_IN = 0.22  # brief "kssht" at the head — the only static in the take
COVERAGE_THRESHOLD = 0.85
MAX_ATTEMPTS = 3

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / ".env"
OUT_DIR = REPO_ROOT / "public" / "sounds" / "vocals"
RAW_DIR = OUT_DIR / "pilot-log-3-takes" / "raw_simple"
FINAL_PATH = OUT_DIR / "pilot-log-3.mp3"

TAGS = "[low voice][gravelly][slowly][weary][murmuring]"

SCRIPT = (
    "Hey, kid.\n"
    "Couldn't sleep, huh.\n"
    "Fair enough.\n\n"
    "Listen. Close your eyes.\n"
    "Here's three notes out here.\n"
    "They go… low, rising, home.\n"
    "Same three, every time. Counted 'em.\n\n"
    "That's the trick, see.\n"
    "You don't count sheep out here.\n"
    "You count the ones that sing back."
)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print("$", " ".join(shlex.quote(c) for c in cmd))
    return subprocess.run(cmd, check=True, **kwargs)


def load_api_key() -> str:
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith("ELEVENLABS_API_KEY"):
            _, _, val = line.partition("=")
            return val.strip().strip('"').strip("'")
    raise RuntimeError("ELEVENLABS_API_KEY not found in .env")


def synth_oneshot(api_key: str, text: str, out_path: Path) -> None:
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {"xi-api-key": api_key, "accept": "audio/mpeg", "content-type": "application/json"}
    body = {
        "text": f"{TAGS}\n\n{text}",
        "model_id": MODEL,
        "voice_settings": {
            "stability": 0.55,
            "similarity_boost": 0.75,
            "style": 0.35,
            "use_speaker_boost": True,
        },
    }
    r = requests.post(url, headers=headers, json=body, timeout=180)
    if r.status_code != 200:
        raise RuntimeError(f"TTS failed ({r.status_code}): {r.text[:400]}")
    out_path.write_bytes(r.content)


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


def make_squelch(out_path: Path, duration: float) -> None:
    """Brief bandpassed white-noise burst — the 'kssht' on PTT release."""
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"anoisesrc=color=white:duration={duration}:amplitude=0.45",
        "-af", f"highpass=f=1200,lowpass=f=4500,"
               f"volume=0.30,"
               f"afade=t=in:st=0:d=0.02,"
               f"afade=t=out:st={max(0, duration - 0.08):.3f}:d={min(0.08, duration):.3f}",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(out_path),
    ])


def concat_squelch_voice(squelch: Path, voice: Path, out_mp3: Path) -> None:
    """Squelch first, then voice — no overlap, no mix. Master to mp3."""
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(squelch),
        "-i", str(voice),
        "-filter_complex",
        "[0][1]concat=n=2:v=0:a=1[c];"
        "[c]loudnorm=I=-20:TP=-3:LRA=11[final]",
        "-map", "[final]",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        "-c:a", "libmp3lame", "-b:a", "128k",
        str(out_mp3),
    ])


def verify(mp3: Path, script: str) -> float:
    """Run the existing verify_transcript.py and return coverage."""
    venv_py = REPO_ROOT / "scripts" / "music-gen" / "venv" / "bin" / "python3"
    verifier = REPO_ROOT / "scripts" / "vocals-gen" / "verify_transcript.py"
    proc = subprocess.run(
        [str(venv_py), str(verifier), str(mp3), script],
        capture_output=True, text=True,
    )
    print(proc.stdout)
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
    import json, re
    # The verifier prints a JSON report; extract the last JSON object.
    m = re.search(r"\{[\s\S]*\}\s*$", proc.stdout)
    if not m:
        return 0.0
    try:
        return float(json.loads(m.group(0)).get("coverage", 0.0))
    except Exception:
        return 0.0


def main() -> None:
    api_key = load_api_key()
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    best_mp3: Path | None = None
    best_cov = -1.0

    for attempt in range(1, MAX_ATTEMPTS + 1):
        print(f"\n=== Attempt {attempt}/{MAX_ATTEMPTS} ===")
        raw_mp3 = RAW_DIR / f"oneshot_attempt{attempt}.mp3"
        synth_oneshot(api_key, SCRIPT, raw_mp3)
        print(f"  raw mp3: {raw_mp3} ({probe_duration(raw_mp3):.2f}s)")

        with tempfile.TemporaryDirectory(prefix="pl2-simple-") as td:
            tdp = Path(td)
            shifted = tdp / "voice_shifted.wav"
            fx = tdp / "voice_fx.wav"
            squelch = tdp / "squelch.wav"
            attempt_mp3 = RAW_DIR / f"oneshot_attempt{attempt}_final.mp3"

            to_wav(raw_mp3, shifted, pitch_semitones=PITCH_SEMITONES)
            apply_radio_fx(shifted, fx)
            make_squelch(squelch, SQUELCH_IN)
            concat_squelch_voice(squelch, fx, attempt_mp3)
            print(f"  assembled: {attempt_mp3} ({probe_duration(attempt_mp3):.2f}s)")

        cov = verify(attempt_mp3, SCRIPT)
        print(f"  coverage: {cov:.3f}")
        if cov > best_cov:
            best_cov = cov
            best_mp3 = attempt_mp3
        if cov >= COVERAGE_THRESHOLD:
            break

    if best_mp3 is None:
        raise RuntimeError("No attempts produced a usable take.")
    if best_cov < COVERAGE_THRESHOLD:
        print(f"\nWARN: best coverage {best_cov:.3f} < {COVERAGE_THRESHOLD}. "
              f"Shipping anyway — inspect {best_mp3} and re-run if needed.")

    # Promote best attempt to the live file.
    import shutil
    shutil.copy2(best_mp3, FINAL_PATH)
    print(f"\nDone. Wrote {FINAL_PATH} ({probe_duration(FINAL_PATH):.2f}s)")
    print(f"  best coverage: {best_cov:.3f}")
    print(f"  source attempt: {best_mp3}")


if __name__ == "__main__":
    main()
