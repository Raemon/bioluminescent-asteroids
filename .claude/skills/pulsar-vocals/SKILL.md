---
name: pulsar-vocals
description: Record a Pilot's Log vocal clip for the Pulsar game using ElevenLabs + Ralf-deep + the radio-FX post chain. Covers the per-phrase synthesis loop, 2.0s downbeat slot grid, scratchy-radio FX, Whisper-based transcript verification (the script's words MUST be confirmed present before the take is accepted), and the integration patterns in Sound.ts. Use when the user asks to record a new Pilot's Log entry, add a variant take, or replace an existing 6x-takes pool file.
---

# Recording a Pilot's Log vocal clip

You have ears via tools, not directly. **Every take you generate must be verified by Whisper transcript-diff before you declare it done.** The single biggest failure mode is generating a clip, hearing nothing wrong in your prose summary, and shipping a recording where ElevenLabs swallowed half the lines. This has happened. The verification step is not optional.

## Do not playtest the game to audition a take

Same rule as `pulsar-music`: the game is slow to start, requires browser interaction, and routes through unrelated systems. **Do not launch a dev server, open a browser, or use Playwright to "hear" how a take lands in-game.** Use the verifier, report the numbers, let the user listen.

If the user explicitly wants to A/B two takes in-game, *they* run the game and report back — don't try to listen for them.

## Read these first

Always read before recording:

1. **`scripts/vocals-gen/generate_pilot_log_2.py`** — the reference pipeline. Mirror its structure for new entries.
2. **`scripts/vocals-gen/verify_transcript.py`** — the verifier. Required step after every synthesis.
3. **`src/Sound.ts`** lines 195–216 (`PILOT_LOG_1_TAKES` pool, `pilotLogUrlsForIndex`), 2200–2240 (`preloadPilotLog`, `playPilotLog`).
4. **`src/game/pilotLog.ts`** — the trigger. `tryUnlockPilotLog1` snaps to the next 2.0s downbeat.
5. **`docs/design-convos/2026-05-27-pilot-log-and-theme.md`** — character voice, the "loud" / kid / Maggie threads, why entries should shorten as combo climbs.

## Constraints that hold for every Pilot's Log clip

**Voice.** `PL_Ralf_Deep` (`voice_id = A9evEp8yGjv4c3WsIKuY`). Three takes by the same actor live in the 6x random pool. Other voices (design-1, frank-wise, etc.) remain in `public/sounds/vocals/6x-takes/` as audition material but are out of the live pool — adding a new voice means deciding whether the captain's voice identity should drift, and that is a *creative* decision the user should be asked to make explicitly, not a default.

**Model.** `eleven_v3`. v3 supports inline directorial tags (`[low voice][gravelly][slowly][weary][murmuring]`) that v2 doesn't. *Do not* use v2 for these — the acting collapses without the tags.

**Tags caveat.** Tags + short lines + Ralf occasionally cause v3 to return near-silence (0.05–0.10s of nothing where 1–2s of speech was expected). This is the dominant failure mode. The verifier will catch it. When a phrase comes back too short, regenerate that phrase with the same prompt before falling back to changing the tags or splitting the line.

**Beat grid.** Phrases land on the 2.0s downbeat slot grid (`DOWNBEAT_SECONDS = BEAT_GRID * 4`). Each phrase placed at slot `n` starts at `n × 2.0s` in the master timeline. Slot 0 holds the squelch-in pre-roll; the first spoken phrase usually goes at slot 1 (= 2.0s in), so the player gets a 2-second "wait... is something happening?" before the captain speaks. That dramaturgy is load-bearing — preserve it.

**Phrase length.** Keep each scripted phrase at ≤ 1.8 slots of natural delivery so it doesn't bleed into the next slot. Ralf is fast and deep — most short phrases come back at 0.5–1.2s, leaving deliberate space. Long lines (>10 words) can run over a slot; either accept the bleed (if the next slot is short or empty) or split the line across two slots.

**Radio FX (voice).** Bandpass 380–2700Hz, +3.5dB at 160Hz (chest resonance), +2.0dB at 2200Hz (presence), `acompressor=threshold=-20dB:ratio=4`, bitcrush to 64 levels. This is the radio character. Keep it on every take so the pool mixes interchangeably.

**Static layers (the noise bed).** *Brief stacking, not a continuous wash.* The user's standing direction: "there should only be very brief bits of stacking, mostly it should be clear." The current pipeline has:
- Squelch-in (0.22s) and squelch-out (0.32s) bookends — keep these, they define the transmission as a discrete moment
- Pink hiss only ramps in/out around the bookends; silent through the body
- Crackle layer is *off* (the `make_crackle` function returns `anullsrc`)

Do not re-add a continuous hiss or crackle bed without explicit user request. If a take feels "too dry," the fix is usually a faint room-tone bump on the *bookends*, not a layer over the speech.

**Pitch.** Down 1 semitone, formant-preserved, via `rubberband -q --formant -p -1.0`. Ralf is already deep — more than 1 semitone makes him cartoonish.

**Mastering.** `loudnorm=I=-20:TP=-3:LRA=11`. The take routes through `bakedOut` in Sound.ts, which bypasses master comp/reverb so the bake-in FX aren't smeared.

## The pipeline

```
scripts/vocals-gen/
├── generate_pilot_log_2.py    The reference. Copy + adapt for new entries.
└── verify_transcript.py        Whisper transcript-diff. Required after every gen.

public/sounds/vocals/
├── 6x-takes/                   Live pool. Files listed in PILOT_LOG_1_TAKES are played.
├── pilot-log-1.mp3             Legacy single-file entry 1 (still referenced).
└── pilot-log-N-takes/          Auditioning material for entry N (kept on disk).
```

### Per-phrase synthesis (the loop)

For each phrase in the script:

1. POST to `https://api.elevenlabs.io/v1/text-to-speech/A9evEp8yGjv4c3WsIKuY` with `model_id=eleven_v3`, text = `[low voice][gravelly][slowly][weary][murmuring] <phrase>`, voice settings `stability=0.55, similarity_boost=0.75, style=0.35, use_speaker_boost=true`. Returns mp3.
2. Decode mp3 → mono 44.1k wav via ffmpeg.
3. Pitch shift -1 semitone via rubberband (formant-preserved).
4. Silence-trim head/tail at -50dB threshold via ffmpeg `silenceremove`.
5. Probe duration. If > 1.8 × slot_seconds, warn. If < 0.3s for a phrase that should be longer, treat as a silent-return and **regenerate** that phrase before moving on.

### Assembly

1. Place each trimmed phrase wav at its 2.0s slot via `adelay` + `amix`.
2. Apply radio FX (`apply_radio_fx`) to the combined voice track.
3. Generate squelch-in, squelch-out, faded hiss halo (silent through body), null crackle.
4. Mix voice + hiss + crackle, with squelch-out delayed to land just after the last spoken phrase, into final mp3.

### Verification — REQUIRED

After writing the final mp3, run:

```bash
./scripts/music-gen/venv/bin/python3 scripts/vocals-gen/verify_transcript.py \
    public/sounds/vocals/pilot-log-N-takes/pilot-log-N-variant-X.mp3 \
    "<full expected script as a single string>"
```

Read the JSON report. The take is **not done** until:

- `coverage >= 0.92` (at least 92% of unique scripted words present in transcript)
- `status: "ok"`
- No critical-mass words missing (e.g. if the line is "porch we left on" and Whisper missed "porch" and "left," the emotional payload is gone — re-synth)

If coverage is low:

1. Look at `transcript` in the report. Compare to expected. Identify which phrases were swallowed.
2. Regenerate only those phrases (don't re-do the whole take).
3. Re-assemble. Re-verify.

If a specific phrase fails synthesis twice in a row, the prompt may be the problem. Try:
- Removing the `[murmuring]` tag (it sometimes makes v3 skip very short lines entirely).
- Splitting a 3-word phrase into a 5-word phrase (more for the model to latch onto).
- Adding a leading "..." or "Hmm." that gives the model a syllable to start on.

Never ship a take with `status: "warn"` without telling the user explicitly that words were swallowed and which ones. The user cannot hear what isn't there.

### Integration into the live pool

If the take is meant for the 6x random pool:

1. Copy the final mp3 to `public/sounds/vocals/6x-takes/ralf-deep-<name>.mp3`.
2. Add the filename to `PILOT_LOG_1_TAKES` in `src/Sound.ts` (around line 198).
3. The voice character must match the rest of the pool (same actor, same FX chain) or the random pick will sound like a different person mid-game.

If the take is a new entry (entry 2, entry 3, etc.):

1. Leave it in `public/sounds/vocals/pilot-log-N-takes/`.
2. The fallback path in `pilotLogUrlsForIndex` already handles `pilot-log-N.mp3` — name the chosen variant accordingly and copy it to `public/sounds/vocals/pilot-log-N.mp3`.
3. Wire a new `tryUnlockPilotLogN` in `src/game/pilotLog.ts` modeled after `tryUnlockPilotLog1`. Add a flag on Game, reset it on `startGame`, gate the trigger on the combo milestone, snap to next downbeat, preload via `preloadPilotLog(N)`.

## Things that have burned us before

- **v3 swallowing short lines.** "Yeah. Me too." came back as 0.08s of audio with Ralf + murmuring tags. The verifier caught it (coverage 0.29). Without the verifier this would have shipped. Always verify.
- **Static piled up.** Continuous pink hiss + brown crackle + squelch bookends all stacked = too much noise. The user's standard: brief stacking only, body of the take stays clear. The current pipeline reflects this; don't regress it.
- **Trimming the wrong end.** `silenceremove` at -50dB can clip the trailing breath off a phrase that fades into nothing. If a trimmed phrase ends abruptly, raise the threshold (-55dB) for that phrase.
- **Voice identity drift.** The original 6x pool had 10 different voices — felt random and broke the captain's character. The pool was narrowed to 3 Ralf takes for a reason. Don't reintroduce other voices without explicit user buy-in.
- **Single-shot generation.** Synthesizing the whole script as one long ElevenLabs call lets the model decide pacing and ignores the 2s beat grid. Always synth phrase-by-phrase so each one can be placed on its slot.

## What "done" looks like in your report

After a successful take, your report to the user should include:

- Path to the final mp3
- Total duration
- Whisper coverage score and the diff (any missing/extra words, named)
- Where it landed in the live pool (if applicable)
- Any words that came back questionable but passed threshold, so the user knows what to listen for
