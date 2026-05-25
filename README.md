# Pulsar

A TypeScript reimagining of the 1979 Atari classic, rendered in the language of deep-sea bioluminescence and built around a 120 BPM rhythm spine — the asteroid field is a generative bass track and your shots are part of the percussion.

## Stack

- TypeScript
- Vite (dev server + build)
- HTML5 Canvas 2D with additive blending for the glow

No game libraries — the engine is hand-rolled in `src/`.

## Run it

```bash
npm install
npm run dev
```

Then open the URL Vite prints.

## Controls

| Key | Action |
| --- | --- |
| `←` / `→` (or `A` / `D`) | Rotate |
| `↑` (or `W`) | Thrust |
| `space` | Fire |
| `H` | Hyperspace (teleport, 2.5s cooldown) |
| `esc` | Pause / resume |
| `M` | Mute / unmute |
| `enter` | Begin / restart |

## Rhythm

The whole game runs against a shared beat clock on a 0.5-second grid (120 BPM quarters). Two things happen on that clock:

- **Bass asteroids play the song.** `bassA` kicks on every whole second; `bassB` plucks on every half-second, so the two interlock into a steady kick-pluck-kick-pluck pattern. When you blow up a large bass asteroid it splits into two medium pieces that loop at *double* the parent's tempo, layering the beat as the wave wears down. Decorator asteroids — `chime`, `bell`, `warble`, and the rare `tink` crystal — sit on top with their own melodic timbres so each wave's soundscape is unique.
- **Your shots count toward combo.** Any shot fired (or any kill that lands) within ±150 ms of a beat center is an "on-beat" event. Consecutive on-beat events build a combo, scaling the score multiplier up to ×5. Miss a beat window and the combo resets. The ship's silhouette pulses *exactly* in the same window — that glow flare is a literal preview of the rhythm gate.

The combo readout pops up on the HUD once you reach ×2, and a small gold sparkle ring fires off any on-beat kill so the bonus reads visually even when the underlying asteroid hue is similar to the explosion.

## Waves

Wave 1 starts at 4 plain asteroids. The total count grows by one every other wave, and starting at wave 2 a special "instrument" asteroid is unlocked in a fixed order — `bassA`, `chime`, `bassB`, `bell`, `warble` — one per pair of waves, capping at 5. From wave 3 onward there's a 1-in-3 chance per wave that a single small `tink` crystal will appear as a bonus. The result is that the audio bed layers up smoothly as you climb: a quiet field at wave 1, a full ensemble by the time you're 10 waves in.

## Powerup canisters

Roughly one in three waves a glowing canister drifts in somewhere mid-level (8–24s into the wave). Only one can appear per wave, the timing is randomised, and the kind is rolled fresh. Fly over it to absorb — read the letter on the capsule to know what you grabbed:

| Letter | Powerup | Effect |
| --- | --- | --- |
| `T` | Trident | Fires a 3-bullet spread for 10s |
| `R` | Rapid Pulse | Fires ~2.5× faster for 10s |
| `P` | Piercing Plasma | Bullets punch through asteroids for 10s |
| `S` | Shield Bloom | Absorbs one collision, then pops |
| `Z` | Slow Tide | Asteroids crawl at ~half speed for 8s (you keep full speed — it's bullet-time, not pause) |

## Sound

All sound is procedurally synthesized at runtime via the Web Audio API — no asset files.

- **Fire** is a downward-glide triangle with a high shimmer overlay.
- **Explosions** are filtered noise bursts plus a sub-sine sweep, scaled by asteroid size.
- **Thrust** is a band-passed noise loop with a saw-rumble, gated by the thrust key.
- **Hyperspace** is a glissando sine plus rising bandpass noise.
- **Wave-clear** is a four-note ascending chord.
- **Bass kick / pluck** are the C2 sine-thump and G2 saw+triangle plucked-bass that drive the rhythm bed.
- **Bass hit** is the bitcrushed downward sweep that announces a doubled-tempo split.
- **Chime / bell / warble / tink** are the decorator hit sounds — wind-chime partials, inharmonic temple bell, vibrato'd vocal "ooo", and a high glassy fifth respectively.
- **Combo tick** is a tiny high-passed noise click confirming an on-beat shot; **combo sparkle** is a warm mid-range fifth that rings out on an on-beat kill.
- **Powerup** is an ascending C-major arpeggio with a sparkle overlay; **shield pop** is a glassy ting with a noise wash.

Everything is routed through a soft compressor so layered hits don't clip.

## Design notes

A few principles the code keeps coming back to:

- **The wave is the music.** Every special asteroid kind is first a sound and second a sprite — the audio bed is the reward for surviving long enough to unlock it. New types unlock by *adding* a layer, not replacing one.
- **No assets, ever.** Every pixel and every sample is generated at runtime: asteroid silhouettes from summed cosine harmonics, particle glow from cached radial gradients, music from raw `OscillatorNode`s. The repo has no `assets/` folder and there is no plan to add one.
- **Feel is tuned in comments, not docs.** The beat window is ±150 ms because the dt cap is 50 ms plus normal human slop, but narrow enough that spam-firing only catches ~half of beats. The `tink` crystal is rare on purpose ("if you start seeing tink asteroids every wave, lower the per-wave spawn chance"). Slow-mo affects asteroid `dt` only because a global slow would feel like a pause instead of a power. These tradeoffs live next to the constants that encode them.
- **Bioluminescent palette, organic shapes.** HSL hue rotation, additive blending, soft halos, and Fourier-sampled outlines instead of the classic Atari polygon. The asteroid field reads more like jellyfish drifting than rocks tumbling.
- **Aggressive sprite caching.** `glow.ts` caches per-hue radial gradients in 15° buckets, asteroids pre-render their static body to an offscreen canvas at construction time, and the nebula bakes once and translates per frame. The single biggest Canvas2D perf lever in the codebase is "don't allocate a gradient inside a render loop."
- **Small, named vocabularies.** Five powerups, seven asteroid kinds, one hue palette — kept short on purpose so each member stays recognizable instead of disappearing into a long list.

## Files

- `src/Game.ts` — main state machine, waves, collisions, beat clock, HUD wiring
- `src/Ship.ts` — player physics + glowing-triangle rendering with thrust plume and beat-pulse halo
- `src/Asteroid.ts` — organic outline, drifting nuclei, filament weave, bass-tempo bookkeeping
- `src/Shard.ts` — Voronoi-style fragmentation when an asteroid dies
- `src/Bullet.ts` — plasma droplets with trail; carries the on-beat flag from the firing frame
- `src/Canister.ts` — drifting powerup canisters + pickup helpers
- `src/Particle.ts` — additive glow particles
- `src/Starfield.ts` — parallax stars + pre-rendered drifting nebulae
- `src/Sound.ts` — Web Audio synthesis (fire / explosion / thrust / death / hyperspace / wave-clear / bass / decorator / combo / powerup / shield)
- `src/Input.ts` — keyboard polling
- `src/glow.ts` — per-hue radial-gradient sprite cache used by particles, bullets, and canisters
- `src/vec.ts` — vector math + random helpers

## Deploy

This is a static Vite app, so it deploys to Vercel as-is — Vercel auto-detects the Vite framework, runs `npm run build`, and serves `dist/`. No `vercel.json` is required.

To deploy manually:

```bash
npx vercel       # first time, links the project
npx vercel --prod
```

Or push to a GitHub repo connected to Vercel and every push to `main` will redeploy.

## License

MIT
