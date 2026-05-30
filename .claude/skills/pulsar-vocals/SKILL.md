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

**Synthesis strategy: one-shot, not per-phrase.** Entries 2 and 3 first attempted per-phrase synthesis (one ElevenLabs call per scripted line, with directorial tags repeated each time, then slot-quantized in post). This failed badly — Ralf+v3 + tags + short fragments triggers the swallowed-line failure mode on most calls, and even when phrases came back at plausible duration they were often garbled or only contained the first 2-3 words. Per-phrase coverage routinely scored 0.00–0.50 against the script. **The fix is to send the entire script as one ElevenLabs call**, with the directorial tag block at the top once. v3 then conditions each line on the previous one, the captain's natural pauses are organic, and coverage scores match Entry 1 (~0.92). Slot alignment is recovered in post by silence-detect + phrase quantization (see `generate_pilot_log_3_oneshot.py` for the reference pipeline). The trade-off — losing precise control over which downbeat a specific word lands on — is worth it because the *words actually come out*.

**Radio FX (voice).** Bandpass 380–2700Hz, +3.5dB at 160Hz (chest resonance), +2.0dB at 2200Hz (presence), `acompressor=threshold=-20dB:ratio=4`, bitcrush to 64 levels. This is the radio character. Keep it on every take so the pool mixes interchangeably.

**Static layers (the noise bed).** *No static. None.* The user's standing direction has tightened over time, and the current rule is **no static of any kind**:
- **No squelch-in.** Earlier pipelines opened with a 0.22s "kssht" white-noise burst. Remove it. The transmission starts with the captain's voice, dry.
- **No squelch-out tail.** Same reason.
- **No hiss bed during the body.** No pink noise, no continuous wash, no fade-in/fade-out halo.
- **No crackle layer.** Leave `make_crackle` returning `anullsrc` or remove the call entirely.

If a take feels "too dry," the fix is *not* adding noise. Either ship it dry or adjust the radio EQ (bandpass + chest boost + presence) on the voice. The radio character comes from the EQ + compression + bitcrush — not from layered noise. Reintroducing any noise layer is a regression.

**No clipping. Ever.** The user has been burned by takes where phrases clipped — the early-mid words audible but the final words cut off or distorted because the assembly assumed a phrase fit a slot and it didn't. The fixes that must be in place every time:

- **Per-phrase Whisper verification during synth.** Duration alone does not catch the dominant failure mode (Ralf+v3 returning audio that *sounds* full-length but only speaks the first 2-3 words of the line). After every TTS call: trim silence, run Whisper-tiny on the trimmed wav, require ≥ 0.75 word-coverage against the scripted phrase. Below that → regenerate. This is the single most important quality gate; without it the verifier at the end catches it but you've already wasted both takes.
- **Slot layout must accommodate the *actual* phrase duration.** When a phrase comes back at 2.4s for a 2.0s slot, either give it two slots, or move the next phrase one slot later. The fade-in/fade-out from `adelay` + `amix` will not clip — what clips is the *next* phrase starting on top of the previous one's tail. Watch for slot collisions before assembly.
- **No tail-cutting silenceremove on long phrases.** The `silenceremove` stop_threshold at -50dB can clip a softly-fading word ending. For phrases ending in -s/-th/-f (fricatives that fade gently), raise the stop_threshold to -58dB or skip the tail trim entirely.
- **`loudnorm` is not a clip-fix.** `loudnorm=I=-20:TP=-3:LRA=11` mastering is fine as a final pass, but it will not save a take whose voice track already lost words. Verify content before mastering.

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

### One-shot synthesis (the loop)

1. POST to `https://api.elevenlabs.io/v1/text-to-speech/A9evEp8yGjv4c3WsIKuY` with `model_id=eleven_v3`, text = `[low voice][gravelly][slowly][weary][murmuring]\n\n<full_script>`, voice settings `stability=0.55, similarity_boost=0.75, style=0.35, use_speaker_boost=true`. The tag block appears **once** at the top; the rest of the body is the unannotated script. Returns one mp3 for the whole take.
2. Decode mp3 → mono 44.1k wav via ffmpeg.
3. Pitch shift -1 semitone via rubberband (formant-preserved).
4. Run Whisper-tiny on the pitched wav, compute word coverage against the full script. If < 0.85, retry the whole one-shot synth (up to 3 attempts). Save every attempt's raw mp3 to `pilot-log-N-takes/raw/<variant>/oneshot_attempt<N>_cov<C>.mp3` so the user can audition.

### Slot-quantize assembly

1. `ffmpeg silencedetect` on the chosen pitched wav with `noise=-38dB:d=0.30` to find phrase boundaries.
2. Slice the wav into per-phrase wavs along those boundaries (pad ends ~50ms so trailing consonants don't clip).
3. Place each phrase at the next free 2.0s downbeat slot. If a phrase's duration would exceed one slot, give it the slots it needs and start the next phrase one slot after this one ends.
4. Apply radio FX (`apply_radio_fx`) to the combined voice track — bandpass 380–2700, chest EQ at 160Hz, presence boost at 2.2kHz, comp, bitcrush. **No noise layers mixed in.**
5. Master with `loudnorm=I=-18:TP=-2:LRA=11` and encode to mp3. The output is voice-only — no squelch, no hiss, no crackle.

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
- **v3 partially swallowing longer lines.** Worse failure than full swallow: Ralf returns ~1.0s of audio for a 6-word phrase, passes the duration heuristic, but only speaks the first 2-3 words. Discovered on pilot-log-3: "Hands went cold around hour four" came back at 1.02s and final coverage was 34%. Duration checks alone do *not* catch this. Per-phrase Whisper verification is the mandatory gate.
- **Static creep.** The original pipeline shipped with a squelch-in pre-roll, squelch-out tail, continuous pink hiss, and brown-noise crackle. The user has progressively removed all of these: first the crackle, then the hiss bed, then the squelch-out, then the squelch-in. The current rule is **no static at all** — the take starts with the captain's voice, dry, and ends with it. The radio character must come entirely from the voice's EQ + compression + bitcrush chain. Reintroducing any noise layer is a regression even if the spec docs or older scripts reference them.
- **Phrases clipping into the next slot.** When a 2.4s phrase lands in a 2.0s slot, its tail bleeds under the next phrase's start. The user calls this "clipping." Either route the long phrase across two slots, or move the next phrase one slot later. Don't trust the slot grid blindly.
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
