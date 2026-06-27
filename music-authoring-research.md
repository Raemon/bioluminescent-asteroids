# Authoring Expressive, Haunting, LLM-Editable Game Music — Research Report

*Deep-research synthesis. 105 agents, 23 sources fetched, 108 claims extracted, 25 adversarially verified (all confirmed 3-0, 0 refuted). Generated 2026-06-27.*

---

## TL;DR — the one decision that matters

**Split the problem into two layers, and do NOT try to make the LLM-authoring format carry the expression.**

1. **Notes & structure** → a compact, LLM-native symbolic format (**ABC notation**, or a small custom JSON IR). This is what the LLM writes by hand. It's token-efficient *precisely because* it omits continuous expression.
2. **Continuous expression** (pitchbend, glissando, swells, vibrato) → explicit **MIDI control data** (pitch-bend, CC11 expression, CC1 mod-wheel, CC5/CC65 portamento) generated into the renderable layer, **plus timbre/note-choice**. The renderer (FluidSynth — which you already use) honors all of these out of the box.

> **Direct answer to "should glides/swells be carried by the format or by timbre/note-choice?"**
> Neither by a *notation symbol* (those are decorative and don't render) **nor** purely by note-choice. Carry them as **explicit control-stream data** (pitch-bend / CC11 / CC1 / portamento) in the layer between your IR and the synth, reinforced by timbre. The LLM authors a terse IR; a deterministic compiler (or the LLM, when you want surgical control) emits the bend/CC curves.

This also preserves your **pre-bake-everything** preference: FluidSynth renders MIDI → audio file headlessly via `--fast-render`.

---

## The core finding: notation formats can't carry continuous expression — by design

This is the load-bearing, fully-verified insight, and it kills the most tempting-looking option (just write LilyPond/ABC glissandos and render them).

### Compact LLM formats omit expression on purpose
- **ABC notation** is the LLM-native choice: ChatMusician trained LLaMA2 on ABC as "a second language" with a **pure text tokenizer, no multimodal machinery**. It's **~38% the token count of MIDI text representations** (288 tokens/song vs. 728–753 for REMI / MIDI-like). *(Source: ChatMusician, arXiv:2402.16153 — verified 3-0.)*
- **But** the same paper concedes ABC "primarily supports monophonic melodies, lacking nuanced harmonic representation and **expressive dynamics**."
- **HNote/YNote** (minimal LLM formats) encode **only** discrete pitch (hex `00`–`7F` = 128 MIDI semitones) + duration (`80`–`FF`). Pitchbend, glissando, vibrato, dynamics, chords are explicitly **deferred to "future work."** *(arXiv:2509.25694 — verified 3-0.)*

The structural reason: these formats are token-efficient *because* they throw away the continuous dimensions. You cannot have "maximally terse" and "carries haunting swells" in the *same* format token.

### Notation-symbol expression is decorative, not renderable
- **LilyPond's `\glissando` produces NO MIDI pitch slide.** It appends a *printed line* between two notes. It's absent from both the default-supported and articulate-enhanced MIDI lists, and is **explicitly on LilyPond's "unsupported for MIDI" list.** *(lilypond.org docs — verified 3-0.)*
- LilyPond's *only* sub-semitone MIDI mechanism is microtones-via-pitchbend, and it emits **one static per-note pitch-bend offset, reset at note end** — a fixed tuning, not a swept glide. *(verified 3-0.)*

**Implication:** if you author in LilyPond and render to MIDI, your haunting glides silently vanish. The glissando is for the printed page, not the ear.

---

## The renderer DOES honor expression — as control data

Everything the notation format can't express, **FluidSynth renders out-of-the-box** via SF2 default modulators (no custom soundfont needed). All verified 3-0:

| Expression | Mechanism in FluidSynth | Use for |
|---|---|---|
| **Pitch bend** | SF2 default modulator (pitch wheel → fine tune); RPN pitch-bend-range; `pitch_bend` command | Glides, microtonal inflection, the haunting "bend" |
| **Continuous swell** | **CC11 Expression** — SF2 default modulator (concave dB attenuation curve) | Violin crescendo/diminuendo, slow breathing dynamics |
| **Vibrato** | **CC1 mod-wheel** → vibrato LFO depth | Expressive sustained strings |
| **True pitch glide between notes** | **Portamento**: CC5 time (14-bit), CC65 switch, per-channel `setportamentomode`/`setlegatomode`, `fromkey` start pitch | Legato slides, not discrete steps |
| **Pre-bake** | `--fast-render` / `-F` → WAV/FLAC/AIFF, headless, no audio device | Your render-once-play-back model |

**Caveat (from the verified evidence):** a CC only sounds if a default or soundfont modulator exists. CC11/CC1/pitch-bend/portamento have defaults and work immediately; others (e.g. CC2 breath) need the soundfont to define them. **Real-world glide/legato *quality* depends heavily on the soundfont's articulation, which SF2/MIDI underspecify.** This is the seam where "evocative" and "photorealistic" diverge (see gaps below).

### Renderer alternatives (verified)
- **sfizz** (`sfizz-render` / `sfizz_render`): headless CLI rendering a MIDI file through an **SFZ** instrument to WAV. SFZ supports richer per-articulation control than basic GM soundfonts. *(Note: standalone repo archived Nov 2021, merged into main sfizz as `sfizz_render` — same syntax.)*
- **Csound**: highest ceiling for *surgical* continuous control. The `portk` opcode applies time-varying portamento smoothing to step-valued control signals (half-time variable at control rate) — route its output to pitch (= glissando) or amplitude (= swell). Renders offline to WAV headlessly. *(One sub-claim was 2-1: the WAV-output line ships commented-out — trivial to enable.)*

---

## Sound library (verified)

- **VSCO 2 Community Edition** — free **~3 GB chamber-orchestra** library under **CC0 (public domain)**. "No rules, no royalties, no limits" — **unrestricted commercial use in an indie game.** Available as **SFZ** (for sfizz) and convertible to soundfont. *(versilian-studios.com + github.com/sgossner/VSCO-2-CE — verified 3-0.)*

This is the license-safe, automatable orchestral/string source. *(Its specific string-legato quality vs. plucky-GM was NOT benchmarked — see gaps.)*

Other sources that surfaced but weren't independently verified to the same bar: Virtual Playing Orchestra, Sonatina Symphonic Orchestra (github.com/peastman/sso), Decent Samples "Slinky Violin" free.

---

## Recommendation matrix

| Format (authoring) | Token efficiency | LLM knows it | Continuous pitch/dynamics in the format | Verdict |
|---|---|---|---|---|
| **ABC notation** | ★★★ best (~38% of MIDI) | ★★★ strong (training-native) | ✗ omitted by design | **Use for notes/structure** |
| **Custom JSON/DSL IR** | ★★ (you tune it) | ✗ must teach it | ✓ *if you design bend/CC/envelope into the vocabulary* | **Use if glides are load-bearing** |
| **LilyPond** | ★★ good | ★★ strong | ✗ `\glissando` is print-only; no MIDI slide | Avoid for sound; it's an engraving tool |
| **MusicXML** | ✗ verbose | ★★ | notation-only | Avoid |
| **Raw MIDI-as-text** | ✗ ~2.6× ABC | ★ | ✓ but unreadable/unwriteable | Avoid as authoring surface |

| Renderer | Headless pre-bake | Honors continuous expression | Ceiling |
|---|---|---|---|
| **FluidSynth** (you have it) | ✓ `--fast-render` | ✓ bend/CC11/CC1/portamento by default | Good; gated by soundfont articulation |
| **sfizz** | ✓ `sfizz_render` | ✓ richer SFZ articulation | Higher (per-articulation SFZ control) |
| **Csound** | ✓ | ✓✓ programmable curves (`portk`) | Highest for surgical control; steeper |

---

## Recommended workflow

1. **Author** a compact, hand-editable IR — ABC-like for plain notes/structure, **or** a small custom JSON IR if the glides are load-bearing (put `bend`, `swell`/CC11-envelope, `vibrato`/CC1, `portamento` as first-class, terse fields so plain notes stay cheap and you only spend tokens where expression lives).
2. **Compile** the IR to MIDI **with explicit pitch-bend / CC11 / CC1 / portamento lanes** — this is the deterministic step that turns "intent" into renderable control data. (The notation symbol approach is what fails here; explicit control data is what works.)
3. **Render** headlessly via **FluidSynth** (`--fast-render`) against an expressive string library (VSCO 2 CE), or via **sfizz**/**Csound** when you want a higher expressive ceiling.
4. **Reserve generative audio** (ElevenLabs Music / Suno-style) for **lush full-texture stems** — matching your existing hybrid pipeline. Use the symbolic IR for the surgically-controlled lines (the haunting violin you want to *edit*), and generation for the bed you just want to *sound rich*.

---

## Honest gaps — where this report is NOT backed by verified evidence

The research was rigorous on the core (format vs. renderer division), but several parts of the original question got **no verified primary claims** and are addressed only inferentially. Treat these at **lower confidence**:

1. **The solo-violin photorealism ceiling.** No verified claim pins down where "evocative/haunting" (achievable with sample + bend + CC11 + vibrato) ends and "photorealistic" (needs a human or generative model) begins. My standing prior — *evocative is reachable, photorealistic-solo-violin is hard with samples+bend alone* — is **plausible but not evidenced here.**
2. **Livecoding DSLs** (Strudel, TidalCycles, Sonic Pi, SuperCollider) and **Tone.js** were in the question but **absent from the verified set.** No confident comparison on their expressiveness-vs-writeability or headless pre-bake.
3. **Hybrid blending mechanics** — *how* people actually combine a symbolic IR with ElevenLabs/Suno stems (layering vs. stem-separation vs. IR-as-conditioning vs. sidechaining) lacks primary-source evidence.
4. **String-library quality** — VSCO 2 CE's license is confirmed CC0, but its **legato/sustained-string quality** (vs. plucky-GM) and the **sfizz/SFZ vs. FluidSynth/SF2 expressive ceiling** were **not benchmarked.**
5. **Token-efficiency numbers** are tokenizer- and corpus-specific (LLaMA BPE, one 1000-song set). Direction is robust; **don't over-cite the exact 38%.**

If any of these gaps is decision-critical, the right next step is a **targeted second research pass** on that specific sub-question, or an **empirical A/B prototype** (render a few haunting bars via FluidSynth+bend/CC vs. a generated stem, and listen).

---

## Sources (primary, verified)

- ChatMusician (ABC as LLM language, token efficiency) — https://arxiv.org/abs/2402.16153
- HNote/YNote minimal format (pitch+duration only) — https://arxiv.org/pdf/2509.25694
- LilyPond glissando (print-only) — https://lilypond.org/doc/v2.25/Documentation/notation/glissando
- LilyPond supported/unsupported MIDI notation — https://lilypond.org/doc/v2.24/Documentation/notation/supported-notation-for-midi
- FluidSynth feature matrix (modulators, CCs, portamento) — https://github.com/FluidSynth/fluidsynth/wiki/FluidFeatures
- FluidSynth user manual (commands, fast-render) — https://www.fluidsynth.org/wiki/UserManual/
- FluidSynth default pitch-wheel modulator — https://github.com/FluidSynth/fluidsynth/issues/154
- sfizz-render (headless SFZ→WAV) — https://github.com/sfztools/sfizz-render
- Csound `portk` (programmable continuous control) — https://csound.com/docs/manual/portk.html
- VSCO 2 Community Edition (CC0 orchestra) — https://versilian-studios.com/vsco-community/ · https://github.com/sgossner/VSCO-2-CE
