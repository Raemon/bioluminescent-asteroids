# In-Codebase Music Editor — Scoping Plan

*A piano-roll + expression-lane editor that lives in Pulsar, you fully control, and that starts with reasonable bells and whistles by reusing what's already here. Companion to `music-authoring-research.md` and `scripts/music-gen/ir_compile.py`.*

---

## The goal, restated

A GUI music editor, **in this codebase**, that:
- starts with a working **piano roll** (notes, drag-edit, playback) — not a blank canvas;
- adds the thing no off-the-shelf component gives you: **pitch-bend / CC11-swell / CC1-vibrato automation lanes** (the haunting-expression layer the research said must live in control data);
- is **fully yours** to extend;
- **bakes through the existing FluidSynth/sfizz pipeline** for real game audio.

## The key finding that makes this cheap: it's mostly already built

Pulsar already has a **complete, proven pattern for dev-only editor pages**, and every hard infrastructure question has a copyable answer in-repo. This is far less greenfield than it looks. We are *not* designing architecture — we're slotting into an existing one.

| Need | Already solved by | Reuse |
|---|---|---|
| Dev-only editor page (routed, not shipped) | `MusicMixer`, `BeatSyncEditor`, `SoundEditor` | Multi-entry Vite: a `.html` + a `*-editor.tsx` root + a `Page.tsx` |
| Persist edits to a file in the repo | `POST /__music-config__` → Vite plugin writes `public/sounds/*.json` | `makeConfigWriter()` in `vite.config.ts` (lines ~269-271) |
| In-browser note **synthesis** for live preview | `PianoKeyboard.tsx` | Tone.js synths + `soundfont-player` (GM instruments), via `Sound.ts` |
| Bake a clip to MP3 from the browser | `POST /__bake-dump__` → ffmpeg → `public/sounds/baked/*.mp3` | `bakeDumpWriter()` plugin already exists |
| The note→expression→MIDI data model | `scripts/music-gen/ir_compile.py` + `write_midi` | The IR dict *is* the editor's save format |

**So the only genuinely new work is the UI**: a piano-roll grid + expression-lane curve editor, bound to the IR. Everything underneath exists.

---

## Runtime decision (you asked me to advise)

**Recommendation: an in-codebase dev-only page (the `/music`-style pattern), with in-browser synth preview — NOT shipped in the game, NOT a standalone repo.**

Why this and not the alternatives:

- **Why in-codebase, not a standalone app:** the editor's whole value is producing audio for *this* game through *this* pipeline. A separate repo would duplicate the IR, the bake path, and the soundfont setup, and immediately drift. Pulsar's editor pages are already dev-only separate bundles (`music.html`, `sound.html`) — same codebase, zero production weight. You get "lives in the codebase I control" for free.
- **Why dev-only, not in-game:** these are *authoring* tools. The game only ever loads baked MP3s. Shipping a piano-roll editor in the player-facing build adds bundle weight and surface area for no player benefit. The established pattern (`MusicMixer` et al. are dev-only, reached by direct URL) is exactly right.
- **Why in-browser synth preview (not bake-to-hear):** `PianoKeyboard.tsx` proves Pulsar can already synthesize notes live in the browser (Tone.js + `soundfont-player`). For an editor you need a **tight edit→hear loop** — re-baking through Python FluidSynth on every tweak would be unusably slow. So: **preview in-browser live; bake through FluidSynth only for the final committed audio.** This does mean preview-timbre ≠ bake-timbre (see Risks).

```
   You edit in the browser page  ──live preview──►  Tone.js / soundfont-player (instant)
            │
            │ save (POST → Vite plugin writes file)
            ▼
   public/sounds/<name>.ir.json   ← the IR, in the repo, human+LLM editable
            │
            │ (Python, on demand)
            ▼
   ir_compile.py → write_midi → song.mid → FluidSynth/sfizz → MP3   ← real game audio
            ▲
            └── the SAME song.mid also opens in REAPER, if you ever want the heavyweight editor
```

---

## Architecture

### Source of truth: the IR (not a component's internal format)
The editor reads and writes the **IR dict** that `ir_compile.py` already consumes. This is the single most important design choice, and it's what avoids the off-the-shelf trap:

- Off-the-shelf piano-roll components store *notes*, and **none expose pitch-bend/CC lanes**. If we adopted a component's format as the source of truth, we'd be fighting it to bolt expression on.
- Our IR has `bend` / `swell` / `vib` as **first-class `[value, beat]` breakpoint arrays** — which are *natively* a draggable-curve UI. The hard part of the editor (expression lanes) is the easy part of our data model.

So: **the IR is the format; the UI is a view over it.** A note is `{p, dur, vel, bend?, swell?, vib?}`; the piano roll edits `p/dur/vel`, the expression lanes edit the breakpoint arrays. Save = serialize IR to JSON. Bake = hand IR to `ir_compile.py`.

### Three UI regions
1. **Piano roll** (notes): pitch × time grid, drag to add/move/resize, set velocity. This is where an off-the-shelf component gives a head start — *or* a from-scratch canvas grid (Pulsar is already a canvas game; the team has the muscle).
2. **Expression lanes** (the irreplaceable part): a strip under the roll, one lane each for **bend** (semitones, ±range), **swell** (CC11, 0-127), **vib** (CC1, 0-127). Click/drag breakpoints; lines between them = the curve. Editing these arrays directly maps to the IR fields.
3. **Transport + instrument**: play/stop/loop, BPM, GM-program / soundfont picker (so preview roughly matches bake target).

### Build vs. reuse for the piano roll specifically
This is the one real build/buy call left:

| Option | Pro | Con |
|---|---|---|
| **Embed `webaudio-pianoroll`** (Apache-2.0, web-audio-oriented) or `@midi-editor/react` (hook API, undo/redo) | Note grid + edit modes + MIDI I/O free | No CC/bend lanes (build anyway); must adapt its note format ↔ our IR; external dep to own |
| **From-scratch canvas grid over the IR** | Zero impedance mismatch; expression lanes and grid share one render/data model; fully owned | Must build the grid (notes, drag, zoom) — the part components give free |

**Lean:** given (a) the team already writes canvas UIs, (b) the IR is the source of truth either way, and (c) you want to *fully control* it, a **from-scratch canvas grid bound to the IR** is likely cleaner than adapting a component whose format omits exactly what we need. But a quick spike with one component first (one afternoon) is a cheap way to validate before committing. **This is the one open decision worth a deliberate choice — see Open Questions.**

---

## Files to add (following the established pattern exactly)

```
piano-roll.html                          # entry, mirrors music.html
src/music/page/piano-roll-editor.tsx     # React root, mirrors editor.tsx
src/music/page/PianoRollEditor.tsx       # the editor component (NEW UI work)
src/music/page/expressionLanes.tsx       # bend/swell/vib lane components (NEW, the core)
src/music/irConfig.ts                    # load/save IR JSON, mirrors musicConfig.ts
public/sounds/ir/<name>.ir.json          # saved IRs (the editable artifacts)
```

Plus small edits to existing infra:
```
vite.config.ts                           # add "piano-roll" rollup entry + /__ir-config__ writer plugin + clean-URL rewrite
scripts/music-gen/bake_ir.py             # NEW: read <name>.ir.json → ir_compile → write_midi → fluidsynth → MP3 (wraps existing pieces)
```

Nothing here invents infrastructure; each line has a sibling to copy from.

---

## Data flow, end to end

1. Open `localhost:5173/piano-roll` (dev server, like `/music` today).
2. Editor loads an `.ir.json` (or starts blank), renders piano roll + expression lanes.
3. You edit; **live preview** plays via Tone.js/`soundfont-player` (instant, from `PianoKeyboard`'s path).
4. Save → `POST /__ir-config__` → Vite plugin writes `public/sounds/ir/<name>.ir.json` (dev-only; the `makeConfigWriter` pattern).
5. When ready for real audio: run `python scripts/music-gen/bake_ir.py <name>` → `ir_compile.py` → `write_midi` → FluidSynth/sfizz → MP3 in `public/sounds/...`.
6. The game loads that MP3 as it does today. (Optional later: a "bake" button using the existing `/__bake-dump__` ffmpeg path.)
7. **Anytime you want heavyweight hand-editing**, the same `song.mid` opens in REAPER — the IR/MIDI boundary from the research holds.

---

## Risks & honest caveats

1. **Preview timbre ≠ bake timbre.** In-browser preview (Tone.js/soundfont-player) won't sound identical to the FluidSynth+VSCO/sfizz bake. Preview is for *phrasing and timing*; final judgment is on the bake. Mitigation: make the bake fast/one-button so the loop stays tight. This is inherent to "edit fast in browser, render rich in Python" and is an acceptable trade.
2. **Expression-lane UI is the real engineering.** It's bounded (the data is just `[value, beat]` points) but it's the part with no off-the-shelf shortcut. Budget the bulk of effort here, not on the note grid.
3. **Round-trip asymmetry persists.** As with REAPER: if you hand-edit a baked `.mid` and *also* regenerate the IR, IR wins and your `.mid` tweaks are lost. The IR is the master; treat `.mid`/REAPER as a downstream finishing pass. (Carried over from the research findings.)
4. **The component-adapter tax (if we embed one).** Any off-the-shelf piano roll stores notes in *its* shape; we'd maintain a two-way map to the IR. The from-scratch grid avoids this. Decide before building (Open Questions).
5. **Scope creep toward "a real DAW."** Multi-track, FX, mixing, audio clips — Pulsar's existing `MusicMixer`/`BeatSyncEditor` already cover mixing/alignment of baked stems. Keep *this* editor focused on **note + expression authoring of one line/stem**; let the existing tools and REAPER handle the rest. Resist rebuilding a DAW.

---

## Suggested build order (each step independently useful)

1. **Spike (½–1 day):** drop one off-the-shelf piano-roll component into a `piano-roll.html` page, click notes, hear them via the `PianoKeyboard` synth path. Decision input only — answers "is a component good enough or do we go from-scratch?"
2. **Expression-lane prototype (the core):** a canvas strip editing one note's `bend`/`swell`/`vib` breakpoint arrays, with live re-preview. This is the irreplaceable piece; prove it early.
3. **Bind to IR + persistence:** `irConfig.ts` load/save + the `/__ir-config__` Vite writer; round-trip an `.ir.json`.
4. **`bake_ir.py`:** wire IR JSON → existing `ir_compile`/`write_midi`/FluidSynth → MP3. Closes the loop to real game audio.
5. **Polish:** transport, zoom, multi-note expression, instrument picker, REAPER-export button.

---

## Open questions for you

1. **Piano-roll grid: embed a component or build from-scratch over the IR?** (My lean: from-scratch, given the IR mismatch and your "fully control" goal — but a 1-day spike de-risks it.) This is the main open decision.
2. **Preview fidelity:** is Tone.js/`soundfont-player` preview good enough for phrasing decisions, or do you want a fast FluidSynth bake-to-audition button early (slower loop, truer sound)?
3. **Scope of one document:** edit a *single line/stem* per IR file (simplest, composes with existing mixer), or multi-track from the start? (My lean: single line first.)
4. **Naming/placement:** `src/music/page/PianoRollEditor.tsx` and route `/piano-roll` — fine, or do you want it folded into the existing `/music` page as another panel (like `BeatSyncEditor` sits inside `MusicMixer`)?
