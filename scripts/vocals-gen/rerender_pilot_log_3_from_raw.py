"""Re-render pilot-log-3 from the chosen raw ElevenLabs mp3 — no API calls.

The vocal is passed through *untouched*. The pipeline only:
  1. Generates a 0.35s opening static clip.
  2. Concats [static] + [raw ElevenLabs mp3] into the final master.

No pitch shift, no EQ, no compression, no slot quantization, no loudnorm.
Whatever ElevenLabs sent us is what plays in-game (with the static stapled on).

Reads:  public/sounds/vocals/pilot-log-3-takes/raw/variant-a/oneshot_CHOSEN.mp3
Writes: public/sounds/vocals/pilot-log-3.mp3   (the file Sound.ts loads for entry 3)
"""

import subprocess
import tempfile
from pathlib import Path

SAMPLE_RATE = 44100
OPEN_STATIC_SECONDS = 0.35

REPO_ROOT = Path(__file__).resolve().parents[2]
RAW_IN = REPO_ROOT / "public" / "sounds" / "vocals" / "pilot-log-3-takes" / "raw" / "variant-a" / "oneshot_CHOSEN.mp3"
FINAL_OUT = REPO_ROOT / "public" / "sounds" / "vocals" / "pilot-log-3.mp3"


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def probe_duration(path: Path) -> float:
    out = subprocess.check_output([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]).decode().strip()
    return float(out)


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
    """Concat [static] + [untouched ElevenLabs mp3] -> final mp3. The vocal is
    not pitched, EQ'd, compressed, normalized, sliced, or re-mastered."""
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
    if not RAW_IN.exists():
        raise FileNotFoundError(f"missing chosen raw: {RAW_IN}")

    with tempfile.TemporaryDirectory(prefix="pl3-rerender-") as td:
        workdir = Path(td)
        open_static = workdir / "open_static.wav"
        make_open_static(open_static, OPEN_STATIC_SECONDS)

        FINAL_OUT.parent.mkdir(parents=True, exist_ok=True)
        staple_static_to_raw(RAW_IN, open_static, FINAL_OUT)
        print(f"wrote {FINAL_OUT} ({probe_duration(FINAL_OUT):.2f}s, "
              f"static {OPEN_STATIC_SECONDS}s + untouched ElevenLabs vocal)")


if __name__ == "__main__":
    main()
