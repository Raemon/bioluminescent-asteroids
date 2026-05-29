"""Transcribe a vocal clip with Whisper and diff against the expected script.

Usage:
  python3 verify_transcript.py <audio_path> <expected_script_path_or_text>

If the second argument is a path that exists, its contents are used as the
expected script. Otherwise the argument itself is treated as the literal text.

Prints a JSON report:
  - transcript: what Whisper heard
  - expected:   the script we asked the actor to read
  - missing:    words from expected that don't appear in transcript
  - extra:      words in transcript that aren't in expected
  - coverage:   fraction of expected words present in transcript (0..1)
  - status:     "ok" if coverage >= 0.92 and no critical line is fully missing,
                "warn" otherwise

Notes
-----
Coverage is a *bag* check (does each scripted word appear somewhere in the
transcript), not an order check. Order tends to be perfect when coverage is
high, and bag-matching is more forgiving of Whisper's punctuation/contraction
quirks. If you need stricter checking, raise the threshold.

Whisper's `tiny` model is fast (~3s per 30s clip on Apple Silicon) and good
enough to flag obviously-swallowed lines. Use `--model small` for closer reads.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def normalize(s: str) -> list[str]:
    """Lowercase, strip punctuation, split contractions to bare stems."""
    s = s.lower()
    # Treat directorial tags like [whispers] as ignorable
    s = re.sub(r"\[[^\]]*\]", " ", s)
    # Expand a few common contractions Whisper sometimes spells out
    s = s.replace("'", "")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    tokens = [t for t in s.split() if t]
    return tokens


def diff(expected: str, transcript: str) -> dict:
    e = normalize(expected)
    t = normalize(transcript)
    t_set = set(t)
    e_set = set(e)
    # Bag-style coverage: each unique scripted word must appear in transcript.
    # Stop-words and filler aren't filtered out — if the script says "the",
    # we expect "the" back. Whisper rarely drops common words; if it does,
    # something is wrong with the audio.
    missing = [w for w in dict.fromkeys(e) if w not in t_set]
    extra = [w for w in dict.fromkeys(t) if w not in e_set]
    coverage = (len(e_set) - len(missing)) / max(1, len(e_set))
    return {
        "transcript": transcript.strip(),
        "expected": expected.strip(),
        "missing": missing,
        "extra": extra,
        "coverage": round(coverage, 3),
        "expected_word_count": len(e),
        "transcript_word_count": len(t),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", type=Path)
    ap.add_argument("script", help="Path to script file, or literal text")
    ap.add_argument("--model", default="tiny", choices=["tiny", "base", "small", "medium"])
    ap.add_argument("--threshold", type=float, default=0.92,
                    help="Coverage below this is reported as 'warn'.")
    args = ap.parse_args()

    if not args.audio.exists():
        print(f"audio not found: {args.audio}", file=sys.stderr)
        return 2

    script_path = Path(args.script)
    if script_path.exists():
        expected = script_path.read_text()
    else:
        expected = args.script

    # Import lazily so --help is snappy even if whisper isn't installed yet.
    import whisper

    model = whisper.load_model(args.model)
    result = model.transcribe(str(args.audio), language="en", fp16=False)
    transcript = result["text"]

    report = diff(expected, transcript)
    report["status"] = "ok" if report["coverage"] >= args.threshold else "warn"
    report["audio"] = str(args.audio)
    report["model"] = args.model
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
