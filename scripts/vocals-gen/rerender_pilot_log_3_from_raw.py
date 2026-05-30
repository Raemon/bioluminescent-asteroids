"""Re-render pilot-log-3 variant A from the chosen raw ElevenLabs mp3 —
no new API calls, no static, captain starts at t=0.

Reads:  public/sounds/vocals/pilot-log-3-takes/raw/variant-a/oneshot_CHOSEN.mp3
Writes: public/sounds/vocals/pilot-log-3.mp3   (the file Sound.ts loads for entry 3)
"""

import re
import subprocess
import tempfile
from pathlib import Path

SAMPLE_RATE = 44100
PITCH_SEMITONES = -1.0
SLOT_SECONDS = 2.0
SILENCE_NOISE_DB = -38
SILENCE_MIN_DUR = 0.30

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


def to_wav(src: Path, dst: Path) -> None:
    pre = dst.with_suffix(".pre.wav")
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", str(SAMPLE_RATE), str(pre)])
    run(["rubberband", "-q", "--formant", "-p", f"{PITCH_SEMITONES}", str(pre), str(dst)])
    pre.unlink()


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


def extract_phrases(wav_path: Path, total_dur: float, workdir: Path) -> list[Path]:
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

    print(f"silence-detected {len(phrases)} phrases:")
    for i, (a, b) in enumerate(phrases):
        print(f"  [{i:02d}] {a:.2f}s -> {b:.2f}s ({b-a:.2f}s)")

    paths: list[Path] = []
    for i, (start, end) in enumerate(phrases):
        out = workdir / f"phrase_{i:02d}.wav"
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
    """Phrase 0 starts at t=0 (no squelch pre-roll). Subsequent phrases land on
    the next free 2.0s downbeat after the previous one's tail."""
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
    print(f"placed {len(placements)} phrases over {total_seconds:.1f}s")
    return total_seconds


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


def voice_only_master(voice_in: Path, total_seconds: float, out_mp3: Path) -> None:
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(voice_in),
        "-af", f"atrim=duration={total_seconds},"
               "loudnorm=I=-18:TP=-2:LRA=11",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        "-c:a", "libmp3lame", "-b:a", "128k",
        str(out_mp3),
    ])


def main() -> None:
    if not RAW_IN.exists():
        raise FileNotFoundError(f"missing chosen raw: {RAW_IN}")

    with tempfile.TemporaryDirectory(prefix="pl3-rerender-") as td:
        workdir = Path(td)
        pitched = workdir / "pitched.wav"
        to_wav(RAW_IN, pitched)
        total = probe_duration(pitched)
        phrase_wavs = extract_phrases(pitched, total, workdir)

        quantized = workdir / "quantized.wav"
        total_seconds = quantize_to_grid(phrase_wavs, quantized)

        fx = workdir / "fx.wav"
        apply_radio_fx(quantized, fx)

        FINAL_OUT.parent.mkdir(parents=True, exist_ok=True)
        voice_only_master(fx, total_seconds, FINAL_OUT)
        print(f"\nwrote {FINAL_OUT} ({probe_duration(FINAL_OUT):.2f}s)")


if __name__ == "__main__":
    main()
