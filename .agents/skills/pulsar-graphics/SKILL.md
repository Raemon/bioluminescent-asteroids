---
name: pulsar-graphics
description: Render new Pulsar entities (asteroids, enemies, pickups, effects) with the game's stylish-depth Canvas2D house style instead of flat "bad flash animation" shapes. Use whenever you're drawing a NEW visual entity, or a fresh graphic looks cartoony/flat and needs depth — covers the silhouette, lighting, rim, facet, and glow recipes the existing entities use, plus the prebake-sprite and no-shadowBlur performance rules.
---

# Pulsar graphics: stylish depth, not flat flash

New graphics in this game tend to start out as flat tinted polygons — a single
`fillStyle`, a stroke, maybe a glow. That reads as cheap Flash animation. The
existing entities (`Asteroid.ts`, `Alien.ts`, `GoldCrystal.ts`, `shipRender.ts`)
all earn their depth with the same small bag of tricks layered together. This
skill is the checklist for applying them.

**The core principle: depth comes from layering 4–6 cheap passes, not from one
clever fill.** A flat thing has one fill. A thing with depth has a body
gradient + a terminator/shadow + a rim + interior detail (facets/craters/panel
lines) + a highlight + (optionally) an additive glow. Each pass is a few lines;
together they read as a lit, solid object.

## Before you draw: read a sibling first

Open the closest existing entity and copy its *structure*, not just vibes:
- **Rock / planetoid / organic mass** → `Asteroid.ts` `buildSprite` / the stone
  paint method (search `stoneGrad`, around line 1256).
- **Cut crystal / gem / glass** → `Asteroid.ts` solidCrystal & glassPrison
  (search `facet`, `frostGrad`, `rimPath`).
- **Glowing energy / nucleus / bullet** → `glow.ts` + the radiator nucleus
  gradients in `Asteroid.ts` (~line 1032).
- **Faceted small pickup** → `GoldCrystal.ts`.
- **Lit vector hull / ship-like** → `shipRender.ts`.

Match the file's comment density and idiom. Honor the memory rules:
**no `ctx.shadowBlur`** (use a cached glow sprite), **no value-restating comments**.

## The silhouette: never a plain circle or hard-edged polygon

A circle reads as a bubble; a regular polygon reads as a sprite from 2005. Give
the outline character:

- **Harmonic noise outline** (the asteroid trick). Sum a few cosine harmonics of
  random freq/amp/phase to perturb the radius per angle. One source of truth for
  *both* render and collision so the visible edge IS the hitbox:
  ```js
  // r(angle) = base * (1 + Σ amp·cos(freq·angle + phase)), then clamp
  let r = 1;
  for (const h of harmonics) r += h.amp * Math.cos(angle * h.freq + h.phase);
  r = Math.max(0.45, Math.min(1.55, r)); // clamp so a vertex can't collapse
  ```
  Low harmonics + low amp = lumpy rock. High freq + high amp + clamp = jagged
  crystal shards.
- **Faceted polygon** for anything crystalline: a tilted N-gon with per-vertex
  jitter, then triangle-fan it from the center so each facet can take its own
  lightness (see solidCrystal, ~line 1515).
- Trace the outline once into a reusable path closure (`const rimPath = () => {…}`)
  so the body fill, the clip, and the rim stroke all use the exact same edge.

## Lighting: one light, upper-left, every time

Consistency is what makes a scene feel like one world. Across the codebase the
light comes from the **upper-left**. Apply it three ways on the same object:

1. **Body gradient with an offset hot-spot.** Don't center the radial gradient —
   push its origin toward the light so the lit shoulder and the shadowed far side
   fall out for free:
   ```js
   // origin offset up-left; outer radius past the body for a soft terminator
   const body = ctx.createRadialGradient(-R*0.35, -R*0.45, R*0.1, 0, 0, R*1.3);
   body.addColorStop(0, `hsla(${H}, S%, 58%, 1)`);  // lit
   body.addColorStop(0.5, `hsla(${H}, S%, 38%, 1)`);
   body.addColorStop(1, `hsla(${H+6}, S%, 14%, 1)`); // shadow side, hue drifts cooler/darker
   ```
   Drift the hue slightly across the stops (warmer/brighter in light, cooler/darker
   in shadow). A pure-lightness ramp looks plastic; a hue shift looks lit.
2. **A small specular highlight** — one tiny bright arc or radial blob on the
   lit shoulder so the eye lands on something crisp. This is the single cheapest
   "it's 3D" cue.
3. **Linear gradient across facets** for cut surfaces (`createLinearGradient(-R,-R,R,R)`)
   so each plane catches the light differently.

## The rim: two stacked strokes

A single 1px stroke is the #1 flat-flash tell. Real depth uses a **dark outer
rim + a bright inner rim** (the `rimPath()` pattern, ~line 1196):
```js
ctx.globalCompositeOperation = "source-over";
ctx.lineWidth = 3.5; ctx.strokeStyle = `hsla(${H}, 30%, 6%, 0.9)`;  rimPath(); ctx.stroke(); // dark depth
ctx.lineWidth = 1.4; ctx.strokeStyle = `hsla(${H}, 90%, 80%, 0.95)`; rimPath(); ctx.stroke(); // bright catch
```
The dark stroke separates the object from the background (occlusion contact); the
thin bright stroke is the rim-light catching the edge. For rim light that should
only appear on the lit side, clip to the body and stroke a slightly inset path
offset toward the light.

## Interior detail: clip, then scribble

Surface texture is what separates "lit blob" from "a real material". Always
`ctx.clip()` to the silhouette first so detail can bleed past the edge without
masking math, then add:
- **Craters / pits** — small radial gradients, each with a *bright* up-left edge
  and a *dark* down-right floor (mini terminators), to sell concavity.
- **Facet seams** — hairlines from center to each vertex (crystals/gems).
- **Mottling / grain** — 8–10 deterministic soft splotches, alternating
  darker/lighter, so a textured fill doesn't read as a flat tile (`splotchCount`
  pattern, ~line 1300). Seed positions from a deterministic value (harmonic
  phases) so the bake is stable.
- **Panel lines / plating** — thin bright inner stripe per panel turns a flat
  fill into "plated metal" (~line 1839).

## Glow & energy: cached sprite under `lighter`, never shadowBlur

- Energy, bullets, nuclei, halos: `drawGlow()` from `glow.ts` (cached radial
  sprite blitted with `drawImage`). For a unique hue, build one offscreen sprite
  at construction and cache it — **never** allocate a gradient per frame per
  particle, and **never** `shadowBlur`.
- Composite additive glows with `ctx.globalCompositeOperation = "lighter"`, then
  switch back to `"source-over"` for the solid body and rim. The order in
  `renderShipBody` is the template: halo (lighter) → hull → flames → restore.
- A nucleus = bright white-ish core radial + a wider soft colored halo behind it
  (two gradients), so it has a hot center and a bloom.

## Prebake everything static

If an entity's appearance doesn't change frame to frame (only its position/
rotation does), render the whole thing **once** into an offscreen
`document.createElement("canvas")` in a `buildSprite()`, store `this.sprite` +
`this.spriteHalfSize`, and the per-frame render is one `drawImage` plus a couple
of cheap live overlays (pulse/flash). This is how every complex asteroid stays
cheap. Live-render only the parts that genuinely animate (an eye-glow pulse, a
crack that grows). Pad the sprite canvas past the glow radius so bloom isn't
clipped.

## Final flat-check (run before declaring a graphic done)

If a new graphic looks cartoony, it's almost always missing one of these — walk
the list:

- [ ] Silhouette has character (harmonic noise / facets), not a plain circle/regular polygon
- [ ] Body has a gradient with an **offset, upper-left** hot-spot (not a flat fill, not a centered gradient)
- [ ] Hue drifts across the light→shadow ramp (not pure lightness)
- [ ] There's a visible **terminator / shadow side**
- [ ] Rim is **two stacked strokes** (dark outer + bright inner), not one
- [ ] At least one crisp **specular highlight** on the lit shoulder
- [ ] Interior **texture/detail** clipped to the body (craters/facets/mottle/panels)
- [ ] Glow is a cached additive sprite under `lighter`, **no shadowBlur**
- [ ] Static appearance is **prebaked** to an offscreen sprite

A graphic that checks all nine boxes will not look like Flash.
