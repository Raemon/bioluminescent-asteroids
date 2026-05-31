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

1. **`scripts/vocals-gen/generate_pilot_log_3_oneshot.py`** — the reference pipeline. Modern no-post (concat-static-onto-raw) flow. Mirror its structure for new entries.
2. **`scripts/vocals-gen/verify_transcript.py`** — the verifier. Required step after every synthesis.
3. **`src/Sound.ts`** lines 195–216 (`PILOT_LOG_1_TAKES` pool, `pilotLogUrlsForIndex`), 2200–2240 (`preloadPilotLog`, `playPilotLog`).
4. **`src/game/pilotLog.ts`** — the trigger. `tryUnlockPilotLog1` snaps to the next 2.0s downbeat.
5. **`docs/design-convos/2026-05-27-pilot-log-and-theme.md`** — character voice, the "loud" / kid / Maggie threads, why entries should shorten as combo climbs.

## Constraints that hold for every Pilot's Log clip

**Voice.** `PL_Ralf_Deep` (`voice_id = A9evEp8yGjv4c3WsIKuY`). Three takes by the same actor live in the 6x random pool. Other voices (design-1, frank-wise, etc.) remain in `public/sounds/vocals/6x-takes/` as audition material but are out of the live pool — adding a new voice means deciding whether the captain's voice identity should drift, and that is a *creative* decision the user should be asked to make explicitly, not a default.

**Model.** `eleven_v3`. v3 supports inline directorial tags (`[low voice][gravelly][slowly][weary][murmuring]`) that v2 doesn't. *Do not* use v2 for these — the acting collapses without the tags.

**Tags caveat.** Tags + short lines + Ralf occasionally cause v3 to return near-silence (0.05–0.10s of nothing where 1–2s of speech was expected). This is the dominant failure mode. The verifier will catch it. When a phrase comes back too short, regenerate that phrase with the same prompt before falling back to changing the tags or splitting the line.

**Beat grid: not enforced anymore.** Earlier pipelines slot-quantized phrases onto a 2.0s downbeat grid. That was part of the post-processing layer we removed. The take starts on the downbeat (because `playPilotLog` is fired on a downbeat by `pilotLog.ts`), and from there the captain talks at whatever pacing ElevenLabs delivered. The dramaturgy of the original slot-0 squelch + slot-1 voice is preserved organically: ~0.35s of static, then the captain comes in.

**Synthesis strategy: one-shot, not per-phrase.** Send the entire script as one ElevenLabs call, with the directorial tag block at the top once. v3 conditions each line on the previous one, the captain's natural pauses are organic, and coverage scores reliably hit ~0.85–0.92. Per-phrase synthesis was attempted for Entries 2 and 3 and failed badly — Ralf+v3 + tags + short fragments triggers a swallowed-line failure mode where the model returns 1s of audio for a 6-word phrase containing only the first 2-3 words. One-shot avoids this.

**Vocal post-processing: NONE.** The current rule is the vocal mp3 from ElevenLabs is passed through to the final master *untouched*. No pitch shift, no bandpass, no EQ, no compression, no slot/grid quantization, no loudnorm, no silence-trimming. Whatever ElevenLabs delivers — pacing, breath, EQ, level — is what plays in-game. This rule supersedes the older "radio FX chain" entirely (the bandpass + chest/presence EQ + comp + bitcrush stack was producing audible distortion the user heard as static). If a take sounds wrong, regenerate it (different stability/style settings, different tags, or another attempt for the dice roll) — do not try to fix it in post. The only post-synthesis step is the opening static staple (next bullet).

**Static: opening only, stapled — never under the voice.**
- **Opening static: a short standalone clip concatenated onto the front of the raw vocal.** ~0.35s of bandpassed (1200–4500 Hz) white noise with a fast attack and a tail fade, generated with `anoisesrc`. The final mp3 is `ffmpeg -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1"` of [static] + [raw ElevenLabs mp3]. Nothing else. AIs (including past me) reliably drift toward `amix` + `adelay` so the static overlaps the voice — do not. Use `concat`. See `staple_static_to_raw` in `rerender_pilot_log_3_from_raw.py` for the reference implementation.
- **No squelch-out tail.** The transmission ends when the ElevenLabs mp3 ends.
- **No hiss bed during the body.** No pink noise, no continuous wash, no fade-in/fade-out halo.
- **No crackle layer.** Remove all `make_crackle`/`make_hiss` calls; old scripts may reference them.

If a take feels "too dry" or "too clean," the fix is not to add noise or run the voice through more FX — it is to regenerate or to change the directorial tags. The opening static is the only noise that touches the master; the vocal itself is delivered as ElevenLabs returned it.

**Coverage gate.** Whisper-tiny on the raw ElevenLabs mp3 after every synth call. Require coverage ≥ 0.85 against the full script. Below that → retry the whole one-shot (up to 3 attempts). This catches the v3-swallowed-line failure mode where the audio sounds plausible but only the first few words of a phrase are present. Save every attempt's raw mp3 so the user can audition.

**Pitch.** None applied in post. Earlier pipelines pitched down 1 semitone via rubberband; the current rule of "vocal untouched" supersedes that. Ralf at native pitch is what plays.

**Mastering.** None applied in post. No `loudnorm`, no comp, no limiter. The ElevenLabs mp3 level is whatever ElevenLabs returns. The take routes through `bakedOut` in Sound.ts, which bypasses master comp/reverb so nothing further is applied at playback time either.

## The pipeline

```
scripts/vocals-gen/
├── generate_pilot_log_2_oneshot.py    Entry 2 reference. Modern no-post pipeline.
├── generate_pilot_log_3_oneshot.py    Entry 3 reference. Modern no-post pipeline.
├── rerender_pilot_log_3_from_raw.py   Re-staple static onto an existing raw take.
├── verify_transcript.py               Whisper transcript-diff. Required after every gen.
└── *.legacy.py                        Old per-phrase + radio-FX pipelines. Reference only.

public/sounds/vocals/
├── in-use/                     **Canonical live folder.** One subfolder per combo milestone.
│   ├── 6x/                        random pool fired when player hits combo x6
│   │   └── ralf-deep.mp3
│   └── 12x/                       random pool fired when player hits combo x12
│       └── lullaby.mp3
├── 6x-takes/                   Audition material for the 6x pool. Not loaded.
└── pilot-log-N-takes/          Audition material + raw/ + ladder/ for past entries. Not loaded.
```

Sound.ts loads everything from `/sounds/vocals/in-use/<milestone>x/`. `playPilotLog(milestone)` picks one file at random from that folder's pool (defined by `PILOT_LOG_POOLS` in Sound.ts). To add a new take to a milestone: drop the mp3 in the folder, add its filename to the pool entry. To add a new milestone: create the folder, add an entry to `PILOT_LOG_POOLS`, wire a `tryUnlockPilotLogN` in `src/game/pilotLog.ts`, preload it from `lifecycle.ts`.

### One-shot synthesis (the loop)

1. POST to `https://api.elevenlabs.io/v1/text-to-speech/A9evEp8yGjv4c3WsIKuY` with `model_id=eleven_v3`, text = `[low voice][gravelly][slowly][weary][murmuring]\n\n<full_script>`, voice settings `stability=0.55, similarity_boost=0.75, style=0.35, use_speaker_boost=true`. The tag block appears **once** at the top; the rest of the body is the unannotated script. Returns one mp3 for the whole take.
2. Run Whisper-tiny **on the raw mp3** (no decode, no pitch shift, no re-encode). Compute word coverage against the full script. If < 0.85, retry the whole one-shot synth (up to 3 attempts). Save every attempt's raw mp3 to `pilot-log-N-takes/raw/oneshot_attempt<N>_cov<C>.mp3` so the user can audition.

### Final assembly — concat, nothing else

1. Generate the opening static clip with `anoisesrc` → bandpass 1200–4500 Hz → volume 0.30 → 0.02s fade-in, ~0.18s fade-out. ~0.35s total.
2. `ffmpeg -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1"` of [static.wav, chosen_raw.mp3] → `pilot-log-N.mp3` (libmp3lame 128k). That is the entire final-assembly step. No `amix`, no `adelay`, no pitch shift, no `loudnorm`, no `silenceremove`, no slot quantization, no `apply_radio_fx`. The vocal mp3 ElevenLabs returned is in the final master byte-for-byte equivalent (re-encoded once by libmp3lame as a side effect of the concat).

If a take needs different pacing, EQ, level, or pitch — that is an ElevenLabs settings/tags problem, not a post-processing problem. Regenerate; do not fix in post.

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

`pilotLogUrlsForIndex(milestone)` loads from `public/sounds/vocals/in-use/<milestone>x/`. Audition takes stay in `*-takes/` folders; only finalized files get promoted.

To add a new take to an existing milestone (e.g. another 6x option):

1. Move the final mp3 to `public/sounds/vocals/in-use/<milestone>x/<name>.mp3`.
2. Add the filename to the milestone's array in `PILOT_LOG_POOLS` in `src/Sound.ts` (around line 205).
3. The voice character must match the rest of the pool (same actor, same FX chain) or the random pick will sound like a different person mid-game.

To add a new milestone (e.g. x18):

1. Create `public/sounds/vocals/in-use/<milestone>x/` and drop the first take inside.
2. Add an entry to `PILOT_LOG_POOLS` keyed by the milestone integer.
3. Wire a `tryUnlockPilotLogN` in `src/game/pilotLog.ts` modeled after `tryUnlockPilotLog1` — add a flag on Game, reset it on `startGame`, gate the trigger on the combo threshold, snap to next downbeat. Call `playPilotLog(<milestone>)` and `preloadPilotLog(<milestone>)` in `lifecycle.ts`.

## Things that have burned us before

- **v3 swallowing short lines.** "Yeah. Me too." came back as 0.08s of audio with Ralf + murmuring tags. The verifier caught it (coverage 0.29). Without the verifier this would have shipped. Always verify.
- **v3 partially swallowing longer lines.** Worse failure than full swallow: Ralf returns ~1.0s of audio for a 6-word phrase, passes the duration heuristic, but only speaks the first 2-3 words. Discovered on pilot-log-3: "Hands went cold around hour four" came back at 1.02s and final coverage was 34%. Duration checks alone do *not* catch this. Per-phrase Whisper verification is the mandatory gate.
- **Vocal post-processing is a regression magnet.** Over many iterations the pipeline grew a pitch shift, bandpass, chest/presence EQ, compressor, bitcrush, slot quantization, and loudnorm. Every step added some artifact the user eventually heard as "static" or "wrong." The current rule — *zero post on the vocal, just staple static on the front* — is the resting state. Do not add a pitch shift back. Do not add an EQ back. Do not "just normalize the level." If something sounds wrong, regenerate the take.
- **Static creep.** Same story: hiss bed, brown crackle, squelch bookends, then bitcrush as a covert static layer disguised as "radio character." All removed. Opening static only, separate clip, concatenated. No `amix`, no `adelay`, no overlap.
- **Voice identity drift.** The original 6x pool had 10 different voices — felt random and broke the captain's character. The pool was narrowed to 3 Ralf takes for a reason. Don't reintroduce other voices without explicit user buy-in.
- **v3 swallowing short lines is a TTS-side problem, not a post problem.** When a phrase fails synthesis, retry with different stability/style settings, change tags, or split/expand the phrase wording. Do not try to compensate in post.

## What "done" looks like in your report

After a successful take, your report to the user should include:

- Path to the final mp3
- Total duration
- Whisper coverage score and the diff (any missing/extra words, named)
- Where it landed in the live pool (if applicable)
- Any words that came back questionable but passed threshold, so the user knows what to listen for
