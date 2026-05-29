"""Thin wrapper around the ElevenLabs Music API.

We generate stems (ambient pad, melodic lead) separately so the game can
layer-control them in real time. The "compose" detailed plan endpoint
(`/v1/music/detailed`) gives finer control by accepting a structured
composition plan; the simple `/v1/music` endpoint takes a prompt string.

We use the simple endpoint with very-specific prompts that include BPM,
key, and arrangement notes. The 120-BPM lock is enforced *after* generation
by analyze.py's lock_to_120 step.

Generations are ~10–30 seconds long by default; we ask for 24s which gives
the post-stretch pipeline ~12 measures of headroom for trimming to 8 measures.

Each generation writes both:
  - {name}.raw.mp3  — direct from ElevenLabs
  - generation.json — sidecar with the prompt/duration/timestamp for repro
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import requests


API = "https://api.elevenlabs.io/v1/music"
API_KEY_ENV = "ELEVENLABS_API_KEY"


def generate(prompt: str, out_path: str, music_length_ms: int = 24000) -> dict:
    key = os.environ.get(API_KEY_ENV)
    if not key:
        raise SystemExit(f"missing {API_KEY_ENV} env var")
    payload = {"prompt": prompt, "music_length_ms": music_length_ms}
    t0 = time.time()
    r = requests.post(
        API,
        headers={"xi-api-key": key, "Content-Type": "application/json"},
        json=payload,
        timeout=240,
    )
    elapsed = time.time() - t0
    if r.status_code != 200:
        raise SystemExit(f"ElevenLabs error {r.status_code}: {r.text[:400]}")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_bytes(r.content)
    meta = {
        "prompt": prompt,
        "music_length_ms": music_length_ms,
        "bytes": len(r.content),
        "elapsed_s": elapsed,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "out_path": out_path,
    }
    sidecar = Path(out_path).with_suffix(".json")
    sidecar.write_text(json.dumps(meta, indent=2))
    return meta


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prompt", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--length-ms", type=int, default=24000)
    args = p.parse_args()
    meta = generate(args.prompt, args.out, args.length_ms)
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
