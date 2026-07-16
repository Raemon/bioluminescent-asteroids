"""Generate wraith sound effects with the ElevenLabs sound-generation API.

Wraiths are the ghostly captives freed from a shattered glass prison. All four
of their sounds are getting replaced with ElevenLabs-generated audio that reads
as "subtly haunting" — airy, cold, choral-whisper textures that still sit inside
the game's C-root music bed. The generations are non-deterministic, so we make N
candidates per sound; tune_wraith_sfx.py picks the best, pitch-corrects it toward
a C-scale target, and installs it into public/sounds/baked/.

Each sound writes N takes to raw/<sound>_take<k>.mp3 plus a generation.json
sidecar recording the prompt/params for repro.

Usage:
    scripts/music-gen/venv/bin/python scripts/sfx-gen/generate_wraith_sfx.py
    # ...or a subset / different take count:
    scripts/music-gen/venv/bin/python scripts/sfx-gen/generate_wraith_sfx.py \
        --sounds wraithHit --takes 5
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

API = "https://api.elevenlabs.io/v1/sound-generation"
SUB_API = "https://api.elevenlabs.io/v1/user/subscription"
API_KEY_ENV = "ELEVENLABS_API_KEY"

HERE = Path(__file__).resolve().parent
RAW_DIR = HERE / "raw"

# One recipe per wraith sound. Prompts use affirmative phrasing only — the EL
# content filter silently drops negations ("no drums") and artist names, so we
# describe what IS present (see the pulsar-music skill). prompt_influence ~0.4
# keeps the model close to the prompt without over-constraining the texture.
#
# Character intents (kept consonant with the C-root / C-minor / Eb-major bed):
#   scream — the release cry as the prison shatters; a cold choral exhale.
#   hit    — the unique per-bullet flinch; short, breathy/wet, NOT a rock thud.
#   lunge  — a quick haunted inhale sweeping toward the player.
#   death  — the soul let go; a glassy angelic swell resolving into light.
RECIPES: dict[str, dict] = {
    "wraithScream": {
        "prompt": (
            "cold ghostly choir of trapped voices exhaling a soft airy minor chord, "
            "breathy and distant, spectral reverberant hall, slow swell then fade, "
            "unsettling but calm and musical, pure vocal tones only"
        ),
        "duration_seconds": 2.4,
        "prompt_influence": 0.4,
    },
    # hit + lunge revised to share the scream's ghostly-VOICE character (the pure
    # air/noise first pass didn't read as the same creature). "In between" the
    # breathy whoosh and the full choir: a short, single spectral vocal flinch /
    # gasp — a haunted voice, not just breath — still brief and consonant with C.
    "wraithHit": {
        "prompt": (
            "a single short ghostly vocal flinch, one soft haunted voice gasping a "
            "quick pained hushed note, cold and spectral, brief and close, reverberant, "
            "pure vocal tone"
        ),
        "duration_seconds": 0.55,
        "prompt_influence": 0.45,
    },
    "wraithLunge": {
        "prompt": (
            "a short low haunted moan, a cold ghostly voice surging closer with a soft "
            "swelling groan in a low chest register, brief and breathy, reverberant, "
            "dark vocal tone"
        ),
        "duration_seconds": 0.65,
        "prompt_influence": 0.45,
    },
    "wraithDeath": {
        "prompt": (
            "a soul releasing upward, soft glassy angelic choral swell rising and "
            "resolving into light, warm and reverberant, gentle major-key sigh of "
            "relief fading into silence, pure vocal and bell tones"
        ),
        "duration_seconds": 2.2,
        "prompt_influence": 0.4,
    },
}


def check_credits(key: str) -> None:
    try:
        r = requests.get(SUB_API, headers={"xi-api-key": key}, timeout=30)
        d = r.json()
        used, limit = d.get("character_count"), d.get("character_limit")
        print(f"[credits] {used}/{limit} characters used  (tier {d.get('tier')})")
    except Exception as e:  # non-fatal — just an FYI before spending
        print(f"[credits] could not read balance: {e}")


def generate_one(key: str, prompt: str, duration_s: float, influence: float,
                 out_path: Path) -> dict:
    payload = {
        "text": prompt,
        "duration_seconds": duration_s,
        "prompt_influence": influence,
    }
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
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(r.content)
    return {
        "prompt": prompt,
        "duration_seconds": duration_s,
        "prompt_influence": influence,
        "bytes": len(r.content),
        "elapsed_s": round(elapsed, 2),
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "out_path": str(out_path.relative_to(HERE)),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--sounds", nargs="*", default=list(RECIPES.keys()),
                   help="subset of sound names to generate (default: all four)")
    p.add_argument("--takes", type=int, default=3,
                   help="candidates per sound (default 3)")
    args = p.parse_args()

    key = os.environ.get(API_KEY_ENV)
    if not key:
        raise SystemExit(f"missing {API_KEY_ENV} env var (source .env first)")

    unknown = [s for s in args.sounds if s not in RECIPES]
    if unknown:
        raise SystemExit(f"unknown sound(s): {unknown}. known: {list(RECIPES)}")

    check_credits(key)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    sidecar = {}

    for name in args.sounds:
        recipe = RECIPES[name]
        takes = []
        for k in range(1, args.takes + 1):
            out = RAW_DIR / f"{name}_take{k}.mp3"
            print(f"[gen] {name} take {k}/{args.takes} …", flush=True)
            meta = generate_one(
                key, recipe["prompt"], recipe["duration_seconds"],
                recipe["prompt_influence"], out,
            )
            print(f"      -> {out.name}  {meta['bytes']} bytes  {meta['elapsed_s']}s")
            takes.append(meta)
        sidecar[name] = {"recipe": recipe, "takes": takes}

    (RAW_DIR / "generation.json").write_text(json.dumps(sidecar, indent=2))
    total = sum(len(v["takes"]) for v in sidecar.values())
    print(f"\n[done] {total} candidates written to {RAW_DIR}")
    print("       next: scripts/sfx-gen/tune_wraith_sfx.py")


if __name__ == "__main__":
    main()
