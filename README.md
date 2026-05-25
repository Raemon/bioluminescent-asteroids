# Bioluminescent Asteroids

A TypeScript reimagining of the 1979 Atari classic, rendered in the language of deep-sea bioluminescence.

Every asteroid is a soft, drifting organism: an organic outline built from layered sinusoids, an interior of slowly pulsing nuclei, faint filament networks woven across the membrane, and a halo of light that breathes against the void. When you shoot one, it doesn't crack — it dissolves into Voronoi-like shards that spin out and fade. The ship is a glowing constellation; bullets are plasma droplets with motion-blur trails.

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
| `M` | Mute / unmute |
| `enter` | Begin / restart |

## Sound

All sound is procedurally synthesized at runtime via the Web Audio API — no asset files. Fire is a downward-glide triangle with a high shimmer overlay; explosions are filtered noise bursts plus a sub-sine sweep; thrust is a band-passed noise loop with a saw-rumble; hyperspace is a glissando sine plus rising bandpass noise; clearing a wave plays a four-note ascending chord.

## Files

- `src/Game.ts` — main state machine, waves, collisions, HUD wiring
- `src/Ship.ts` — player physics + glowing-triangle rendering with thrust plume
- `src/Asteroid.ts` — organic outline, drifting nuclei, filament weave
- `src/Shard.ts` — Voronoi-style fragmentation when an asteroid dies
- `src/Bullet.ts` — plasma droplets with trail
- `src/Particle.ts` — additive glow particles
- `src/Starfield.ts` — parallax stars + drifting nebulae
- `src/Sound.ts` — Web Audio synthesis (fire / explosion / thrust / death / hyperspace / wave-clear)
- `src/Input.ts` — keyboard polling
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
