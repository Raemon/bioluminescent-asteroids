---
name: pulsar-vocal-script
description: Write the script for a Pilot's Log vocal clip in the Pulsar game. The captain's voice — half-prose, half-lullaby, with rhymes that *almost* land but never quite. Use when the user asks for a new Pilot's Log entry, a script for a milestone unlock, or a variant of an existing log line.
---

# Writing a Pilot's Log script

The captain is a working-class pilot, alone in a place that doesn't need him, talking to a kid who isn't there. The Pilot's Log entries are the thread that ties the rhythm mechanic to a human story: **the better the pilot plays in time with the world, the more of his interior life leaks out.** Read the design doc once before writing — `docs/design-convos/2026-05-27-pilot-log-and-theme.md`. Most of the character work is there.

## The single craft rule

**Rhymes should be plausibly deniable.**

The captain isn't trying to rhyme. He's tired and he's been talking to no one for a long time, so his speech occasionally falls into a cadence that *resembles* song without ever committing to it. The reader should be able to read the line as prose and not notice the rhyme — but the ear, hearing it, should feel a faint spine underneath, a tug of nursery-rhyme structure being almost-but-not-quite executed.

This is the whole game. If you can identify the rhyme on first read, you've over-leaned. If there's no rhyme at all, you've under-leaned. The target is the blur between *non-musical prose* and *a rap or a lullaby*.

### What counts as plausibly deniable

- **Slant rhyme.** Vowel matches without consonant matches (*home / sleep*), or consonant matches without vowel matches (*dark / road*).
- **Consonant echoes.** The last sound of one line repeats — same family — at the end of another. *huh / works*. *on / watch*. Almost felt, never heard.
- **Vowel shape echoes.** Three line-endings near each other share a vowel without rhyming: *shut / watch / hold* — *uh / ah / oh*. Three colors in a chord, not a triad.
- **Broken triplets.** Three lines with parallel structure, where the third line *breaks* the rhyme on purpose. *One for the dark. One for the long way. One for the porch light.* The first two slant-rhyme; the third lands flat. Weight, not closure.
- **One deliberate rhyme per entry, max.** If you let one rhyme actually land cleanly — *far / bar* — coach the actor to deliver it as a sigh, not a punchline. It should feel like something his mouth did without him noticing.
- **Anaphora.** Repeated phrase openings (*One for the… One for the…*) read as lullaby; read as prose because tired people repeat words. Both jobs at once.

### What is not plausibly deniable

- **Couplets.** *The void don't sleep tonight / I ride the cosmic light.* The captain is not Dr. Seuss. Reject.
- **Rhyme on stressed monosyllables.** *bones / drones / stones.* Too musical. Coach away.
- **Setup/punchline structure.** *You don't count sheep out here. You count the ones that sing back.* Works because the "rhyme" (*sheep / sing back*) is a soft consonant echo, not a payoff. If the rhyme is a payoff, the line is too cute.
- **Internal rhyme that scans.** *Reactor's holding — hands ain't.* Works because the rhythm is broken by the *ain't*. *Reactor's holding — gear's failing* would scan and would be wrong.

## Voice and register

- **Mic-close, talking to himself.** Not announcing, not broadcasting. The radio is on, but he's mostly forgotten about it. Half-thoughts. Breath catches.
- **The kid is the listener.** Every entry should be addressed to the kid in some form — "Hey, kid" is the established hook from Entry 1. The kid is a child the captain knows; we never see her, we never need to. "Maggie" is the only other name allowed (the kid's mother, possibly the captain's wife, possibly dead — unspecified is correct).
- **The captain hears what the player hears.** The game's pad melody (G–F–G–C, four-phrase loop) is a *thing in the world* that the captain notices. Entry 1 named it "loud." Entry 2 named it "three notes — low, lower, home." Subsequent entries can keep building on this. The diegetic frame collapses when the captain describes the soundtrack to the kid; that's the trick the whole system runs on.
- **No fourth-wall breaks.** Never "combo," never "wave," never "score." The captain doesn't know he's in a game. Lines like "Pilot's Log Entry One" are *narrator-meta* — the captain wouldn't call his own log "Entry One"; he'd just talk. (Entry 1's recorded take wisely dropped that opener.)
- **Don't explain the loudness.** The mystery of what the loudness *is* is a thread that pays off at higher entries. Don't blow it early. The captain knows; he just hasn't said.

## Structural rules

- **Entries get shorter as they fray.** Entry 1 is ~5 lines. Entry 2 (the lullaby high-water mark) can run longer because the captain is murmuring himself toward sleep. Entry 3 onward should *contract*. By a late entry the captain attempts to log something and can't — squelch, silence, nothing said. The Pilot's Log unlock goes from reward to bad omen.
- **Land on the 2.0s downbeat grid.** Each phrase becomes one "slot" in the recording. A phrase of natural delivery should fit in ≤ 1.8s (Ralf is fast, so most short phrases come back well under that). Long lines can span two slots — but then the next slot must be empty, and the captain reads as out of breath, which is character-positive.
- **Pause structure carries weight.** Empty slots between phrases are not dead time — they're the captain breathing, gathering, almost saying something else. Leave gaps where you'd actually leave gaps if you were talking to a sleeping child.
- **End on a polite lie or a quiet gut-punch.** Entry 1 ended on *"I'll be home soon"* — the lie a parent tells. Entry 2 ended on *"I got the watch"* — the bridge-watch keeping him from sleep, doubling as the parent-reassurance. Each entry's last line should do two jobs at once: comfort the kid, reveal the captain.

## How to draft

1. **Read the design doc** (`docs/design-convos/2026-05-27-pilot-log-and-theme.md`) sections on character and theme. Re-read both prior entries' final shipped scripts. Notice what threads are already running.
2. **Pick a single concrete detail.** Real astronaut logs are full of specifics — *the coffee's gone*, *the relay's drifting*, *I can't feel my left hand*. Pick one new detail per entry. It's the hook. The kid is the why.
3. **Draft prose first.** Write the entry as plain unmetered prose. No rhyme, no rhythm. Just what the captain is saying.
4. **Now soften toward cadence.** Read it aloud (mentally). Find the spots where the prose almost falls into rhyme on its own, and lean *slightly* in that direction. Substitute a word that adds a vowel echo. Break a line where breath would naturally break it.
5. **Cut one rhyme that's working too hard.** There's always one. Find it. Soften the consonant. Move the rhyming word away from the line-end so the echo arrives a beat early.
6. **Save the draft to `public/sounds/vocals/scripts/pilot-log-N.md`** in the format used by `pilot-log-2.md`:
    - Header with triggered-at + register + voice notes
    - The line as a blockquote
    - A "Why these words" section calling out every off-rhyme by name, explaining what each one is doing — this is how you (and the user) audit whether the rhymes are too clean or too absent
    - A cadence/beat layout table showing which phrase lands on which 2.0s slot
    - Direction notes for the take (mic distance, tempo, where to sigh, what to avoid)

The "Why these words" section is the artifact that proves you wrote with the rule in mind. Without it, the script is a draft, not a brief.

## Two variants per request

The user has consistently asked for two takes per entry: one that leans further into prose (rhymes barely audible), one that leans further into rap (rhymes audible but never landing clean). Default to producing both unless told otherwise. They get auditioned against each other in `pulsar-vocals` and one (or both) gets pooled.

Label them **Variant A** (subtler) and **Variant B** (more deliberate). The variant labels are load-bearing in the file naming and in the `PILOT_LOG_N_TAKES` pool — keep them consistent.

## Things that have burned us before

- **First draft was a Captain's-log-as-rap with end-stop couplets.** *"Combo six and climbing, my heartbeat finds the bass / Old bones, young engine — burn this empty space."* The user's reaction: "it should feel more like something someone _might_ have said organically." Couplets are the failure mode. Reject them on sight.
- **"Pilot's Log, Entry One — …" opener.** Narrator-meta. The captain doesn't number his own logs. Drop the opener and start on the second line ("Hey, kid").
- **Over-explaining the world.** Drafts that named *what* the loudness is, *who* Maggie is, *why* the captain is out there — all weakened the entry. The captain doesn't explain because he doesn't need to (he knows) and the kid doesn't need to know (she's asleep). Restraint is the move.
- **Rhyming on the wrong syllable.** Putting the rhyme word in the middle of a line where stress doesn't fall makes the rhyme inaudible *and* clumsy. If you want a rhyme to be heard, it goes at the end. If you want it not to be heard, move it inside and make it slant.
