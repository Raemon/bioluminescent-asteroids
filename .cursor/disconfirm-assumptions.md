# Disconfirm-Assumptions Ledger — audio stutter on deployed dev branch

## Event: Stutter occurs at run start with no music playing

### Prediction
- Expected: Basic-pulse stutter is caused by the committed `flagship-sb` ambient gain of 1.0 (4x peers) clipping the summed mix — therefore stutters should only occur while halo music plays (combo ≥ 4).
- Observed: User hears stutter at the very beginning of a run, when no halo music is playing at all.
- Why this is disconfirming: The clipping mechanism requires the hot music stem to be audible. At run start the music channel is silent, so the early stutter cannot be explained by it.

### Assumptions behind the prediction
- [ ] A1: The stutter only happens while halo music is audible (combo ≥ 4 reached).
- [ ] A2: The dominant audible artifact is amplitude clipping/distortion, not timing irregularity.
- [ ] A3: The flagship-sb gain anomaly is the only recent change capable of producing pulse artifacts.
- [ ] A4: The bgBeat trigger path (rAF main-thread `src.start()`) was executing on time; only the waveform was being damaged.

### Assumption status update
- `disconfirmed`: A1 (stutter with no music), A3 (something else also produces the artifact).
- `weakened`: A2 — at run start there is nothing hot enough to clip; early stutter is more likely a *timing* artifact (late/skipped thud).
- `still plausible`: The flagship 1.0 gain is still a real, separate bug (stems verified normalized identically; value 4x all peers) — but it is not THE reported bug, or not all of it.
- `not yet tested`: A4 — whether main-thread jank at run start delays the `src.start()` calls.

### Propagated implications
- Because A1/A3 are disconfirmed, "fix the gain and the report is resolved" loses support. The gain fix may still be wanted but cannot close the issue.
- The investigation should pivot from the audio *graph* (gains, compressors) to the *trigger timing* path: bgBeat thuds are fired from the rAF game loop with immediate `src.start()`; any long frame is audible as a late thud on a steady pulse.
- "Very beginning of a run" is exactly when two heavy things happen: (1) `startCalibrationIntro` eagerly fetches+decodes all 6 HALO_MUSIC_POOL variations × 3 stems (18 mp3s, ~10.6 MB decoded each); (2) `unfreezeIntroWorld` kicks the sequential preloader for haunting pool + boss (now 15 stems). The codebase already documents that decode bursts here "starve the audio scheduler and skip beats".
- This means I should stop assuming: the recent music-config tuning commits are the only relevant recent changes. Anything in the deployed delta that adds startup work (more stems to decode, render refactors, input handling) is back in scope.

### Confusion check
- Not confused: the early-stutter evidence doesn't contradict anything I verified; it contradicts only the *scope* I assigned to the gain bug. No assumption that "shouldn't have been violated" was violated.

### Surviving hypotheses
- H1: Startup decode workload (18-stem eager burst + enlarged sequential queue: spectral-toll-sb added 3 stems in a23aed5; vigil/knell added in 629c1b4/720db00) janks the main thread at run start → late bgBeat triggers → stutter. Recency: stem count in the start window grew in the deployed delta.
- H2: A recent change in the per-frame start-of-run path (e.g. 72ffc19 "Refactor Pulsar rendering effects", 38dd07e touch input) added occasional long frames.
- H3: The flagship-sb 1.0 gain remains a second, independent bug for mid-run stutters while that variation plays.

### Rejected next steps
- I will not present the gain fix as the resolution of the reported stutter, because that depends on disconfirmed A1/A3.

### Next discriminating check
- Action: Determine the previous deployed dev commit (origin/dev push reflog) to bound the delta; inspect history of the startup preload placement and what the delta added to the run-start window.
- What result would support H1: the delta adds stems/decodes to the run-start window (it does: spectral-toll-sb, vigil+knell assets) or moved preloads earlier.
- What result would support H2: the delta contains per-frame changes in code that runs from the very first frame (pulsar render, input).

## Resolution of check: H1 strongly confirmed by asset history
- At 0bb7c4d (Jun 8 00:43, last pre-regression push), `public/sounds/halo-music/` contained ONLY the 6-variation pool (18 files). `HAUNTING_MUSIC_POOL` and `BOSS_MUSIC_VARIATION` did not exist in haloMusicConfig.ts at all.
- 825fed2 (Jun 8 23:34) introduced haunting trio + boss track AND preloaded them eagerly at run start; 16 minutes later 52ab8f1 "fix loading" moved them to `preloadHaloMusicSequential` fired from `unfreezeIntroWorld` — i.e. the exact moment play begins. The commit name shows the author hit a loading-induced beat-skip immediately.
- Jun 9 commits grew the deferred queue to 15 stems (spectral-toll-sb + vigil-sb; knell-sb exists but is not preloaded).
- Mechanism: `drain()` chains `loadHaloMusicBuffer().finally(() => idle(drain))` — only one requestIdleCallback (≤ ~1 frame) between serial fetch+decode of 15 × 640KB mp3s (~10.6 MB decoded each). On a fast connection this is near-continuous decode work for the first several seconds of play, exactly when only the basic pulse is audible. bgBeat thuds are triggered with immediate `src.start()` from the rAF loop, so any starvation/jank lands audibly on the pulse.
- H2 (pulsar render refactor 72ffc19) reviewed: changes reduce effect sizes/alphas; adds one 5-bead gradient loop gated to eclipse contact moments. Not run-start specific. Deprioritized.
- H3 (flagship-sb ambient 1.0) still stands as a second independent bug for mid-run stutter while that variation plays (stems verified equally normalized; value 4x peers).

### Discriminating test for the user (per page load, buffers are cached in a Map)
- Same-tab second run should start clean; a fresh page load should stutter again in the first ~10-30s. Stutters should stop once the 15 stems finish decoding.

## Event: "flagship-sb ambient 1.0 is accidental" disconfirmed

### Prediction
- Expected: the 1.0 ambient gain in music-config.json was an accidentally committed /music audition value; fixing it to 0.25 is safe.
- Observed: Sound.ts:2570-2575 documents it explicitly — "Tuned gains live in music-config.json (the ambient there is user-set to 1.0; melodic balances against it)."
- Why this is disconfirming: the value is a deliberate authored mix decision, not a leftover.

### Status update
- `disconfirmed`: "1.0 is accidental"; the planned config edit is withdrawn.
- `still plausible`: flagship-sb runs ~10 dB above its audit point and could clip when stacked with the bass field — but that is the author's choice and not the reported bug. Flagged to user, not changed.

## Fix applied
- `preloadHaloMusicSequential` now waits 8 s before the first stem and 6 s between stems (was: one requestIdleCallback ≈ one frame), so the 15 deferred decodes land as isolated events over ~90 s instead of a continuous serial chain at the moment play begins. Boss (wave 11) / haunting (wave 12) are still warmed minutes early.
