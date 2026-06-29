import type { Game } from "../Game";
import type { Vec } from "../vec";
import { BEAT_GRID } from "./rhythmConstants";
import { currentBeatPulse, currentBeatFlash, comboGrid } from "./rhythmGate";
import { renderTrails } from "./trailsRender";
import { renderPopups } from "./popups";
import { renderBassLightnings } from "./bassLightning";
import { renderDriftBursts } from "./driftBurst";
import { renderWormholes } from "./wormhole";
import { computeConeFrame, toroidalDelta } from "../ship/reticule/coneGeometry";
import { pickCenterMostTargetForFocus, ReticuleTarget, setReticuleWrapAnchor } from "../ship/reticule/trajectoryPreview";
import { renderShipTrajectoryPreview } from "../ship/shipTrajectoryPreview";
import { renderLasers, renderLaserChargeDots, renderLaserAmbientFlash } from "./laserShot";
import { renderLaserReticule } from "../ship/reticule/laserReticule";
import { renderBossBeams } from "./bossBeam";
import { renderSlowMoTimerBar } from "./slowMoTimerBar";
import { renderSpectrumVisualizer, updateSpectrumVisualizer, paintSpectrumVisualizer } from "./spectrumVisualizer";
import { renderEdgeAidsTiled } from "./edgeAids";
import { cosmeticRng } from "./rng";

// shake is purely cosmetic; isolate its math so render() reads top-down.
// Uses the cosmetic RNG stream — render runs every animation frame live but NOT
//   during the muted replay re-sim sweep, so drawing the gameplay stream here
//   shifts its draw count and desyncs replays (rngState drifts ~first hit).
const applyScreenShake = (game: Game): { shakeX: number; shakeY: number } => {
  if (game.shake <= 0) return { shakeX: 0, shakeY: 0 };
  game.shakeSeed += 1;
  return {
    shakeX: (cosmeticRng() - 0.5) * game.shake * 10,
    shakeY: (cosmeticRng() - 0.5) * game.shake * 10,
  };
};

// deep-space backdrop has to repaint every frame or shake/clearRect leaves trails.
const paintBackdrop = (game: Game) => {
  const { ctx, w, h } = game;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#02030a";
  ctx.fillRect(0, 0, w, h);
};

// The starfield is the deepest layer — it must sit behind every other object and
// effect. The pulsar used to ride here too, but it's a world-positioned landmark
// (it wraps with the torus in scroll mode), so it now lives in the world layer.
// The starfield reads the pulsar's camera view so its parallax + roll stay locked
// to the pulsar's dolly — the whole background reads as one coherent camera move.
// scrollX/scrollY shift the whole field 1:1 with the world (scroll mode), so the
// stars feel anchored to the torus the ship moves across, not pinned to the glass.
const paintBackground = (game: Game, scrollX = 0, scrollY = 0) => {
  game.starfield.render(game.ctx, game.time, game.pulsar.cameraView(), scrollX, scrollY);
};

// ctx.filter = brightness(...) is implemented as a full-canvas pixel pass on most browsers
// and caused noticeable per-frame lag when several focusable bodies were on screen. Replace it
// with a single additive radial-gradient disc painted on top of the focused target — every other
// entity already uses globalCompositeOperation = "lighter", so an extra additive splash reads
// as "this one is glowing brighter" without touching any sprite pipeline.
const FOCUS_GLOW_RADIUS_MULT = 1.35;
const FOCUS_GLOW_ALPHA = 0.22;
const FOCUS_GLOW_MIN_RADIUS = 8;
const paintFocusGlow = (ctx: CanvasRenderingContext2D, t: ReticuleTarget) => {
  const r = Math.max(FOCUS_GLOW_MIN_RADIUS, (t.radius ?? FOCUS_GLOW_MIN_RADIUS) * FOCUS_GLOW_RADIUS_MULT);
  const g = ctx.createRadialGradient(t.pos.x, t.pos.y, 0, t.pos.x, t.pos.y, r);
  g.addColorStop(0, `rgba(255, 255, 255, ${FOCUS_GLOW_ALPHA})`);
  g.addColorStop(0.5, `rgba(255, 255, 255, ${(FOCUS_GLOW_ALPHA * 0.3).toFixed(3)})`);
  g.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(t.pos.x, t.pos.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

// On-beat brightening for every wave body. Same additive-disc trick as paintFocusGlow
// (ctx.filter=brightness is a slow full-canvas pass — see that note), so the flash reads as
// "this lit up" on top of the sprite without touching each entity's own draw pipeline.
const BEAT_FLASH_RADIUS_MULT = 1.15;
const BEAT_FLASH_ALPHA = 0.35;
const paintBeatFlash = (
  ctx: CanvasRenderingContext2D, pos: Vec, radius: number, flash: number,
) => {
  const r = Math.max(6, radius) * BEAT_FLASH_RADIUS_MULT;
  const a = BEAT_FLASH_ALPHA * flash;
  const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r);
  g.addColorStop(0, `rgba(255, 255, 255, ${a.toFixed(3)})`);
  g.addColorStop(0.6, `rgba(255, 255, 255, ${(a * 0.4).toFixed(3)})`);
  g.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

// Wrapping bodies pop across the seam: their pos teleports edge-to-edge in one
// frame (wrapMut). To make a body slide across instead, draw it a second time
// at the wrapped-across offset whenever it straddles an edge — as it leaves the
// right, its twin is already entering from the left. `reach` is the body's
// visible extent (silhouette + glow), so the twin enters the moment the glow
// touches the seam, not when the centre does; off the seam nothing extra draws.
const drawWrapped = (
  ctx: CanvasRenderingContext2D,
  pos: Vec, reach: number, w: number, h: number,
  draw: () => void,
) => {
  draw();
  const dx = pos.x < reach ? w : pos.x > w - reach ? -w : 0;
  const dy = pos.y < reach ? h : pos.y > h - reach ? -h : 0;
  if (dx === 0 && dy === 0) return;
  const twin = (ox: number, oy: number) => {
    ctx.save();
    ctx.translate(ox, oy);
    draw();
    ctx.restore();
  };
  if (dx !== 0) twin(dx, 0);
  if (dy !== 0) twin(0, dy);
  if (dx !== 0 && dy !== 0) twin(dx, dy);
};

// Visible reach past each body's hitbox radius: the glow halo extends well
// beyond the bullet/plasma core, so the twin must appear while the halo is
// still mid-seam. Asteroids/gems are silhouette-dominant; a small pad covers
// their rim glow.
const BODY_GLOW_REACH = 1.5;
const BULLET_GLOW_REACH = 12;
const ALIEN_BULLET_GLOW_REACH = 6;

// How this layer handles the world wrap, set by the caller's camera:
//   "gameplay" — wrap only the bodies that wrap in play (the straight "off" cam)
//   "all"      — wrap EVERY body (even comets/aliens/canisters/parked gems) so a
//                snapshot is seam-complete for the tiled 2x2/3x3 modes
//   "none"     — draw each body once; the SCROLL camera replicates the whole
//                layer at the wrap offsets, so an internal twin would double-draw
//                the body at the seam (additive over-brightening)
type WrapMode = "gameplay" | "all" | "none";

// bodies must sit ON their own trails, so trails pass before any per-entity render call.
// pulsar: draw the pulsar + its shockwave ring inline (behind/above the
// entities). The scroll camera draws the pulsar on its OWN parallax layer (it's
// a distant body that should slide slower than gameplay entities), so it passes
// pulsar=false and paints paintPulsarLayer separately.
const paintEntityLayers = (
  game: Game, focusedTarget: ReticuleTarget | null, wrapMode: WrapMode = "gameplay", pulsar = true,
) => {
  const { ctx, w, h } = game;
  // Wrap a body per the camera's wrap mode (see WrapMode).
  const maybeWrap = (pos: Vec, reach: number, wraps: boolean, draw: () => void) => {
    if (wrapMode === "none") draw();
    else if (wraps || wrapMode === "all") drawWrapped(ctx, pos, reach, w, h, draw);
    else draw();
  };
  // Bodies that always wrap in gameplay (asteroids, bullets) still skip the
  // internal twin when the layer is externally replicated.
  const wrapBody = (pos: Vec, reach: number, draw: () => void) =>
    wrapMode === "none" ? draw() : drawWrapped(ctx, pos, reach, w, h, draw);
  // The pulsar sits behind the entities (it used to ride with the starfield as
  // the second background layer) but in front of the starfield.
  if (pulsar) game.pulsar.render(ctx);
  renderTrails(game, ctx);
  // Departure portals sit behind the comet/alien bodies so a warping-out body
  // dives into the visible mouth and shrinks down the throat in front of it.
  renderWormholes(ctx, game.wormholes, game.time * 0.001);
  for (const c of game.comets) maybeWrap(c.pos, c.radius * BODY_GLOW_REACH, false, () => c.render(ctx));
  // shards are tiny, brief explosion debris — not worth a seam twin.
  for (const s of game.shards) s.render(ctx);
  // bassteroids wear the ship's 4+/12+ combo halo — share the ship's eased
  // intensity + the live beat pulse so every halo on the field rides one rhythm.
  const comboHalo = { intensity: game.ship.comboHaloIntensity, beatPulse: currentBeatPulse(game) };
  for (const a of game.asteroids) wrapBody(a.pos, a.radius * BODY_GLOW_REACH, () => a.render(ctx, game.time, comboHalo));
  for (const c of game.canisters) maybeWrap(c.pos, c.radius * BODY_GLOW_REACH, false, () => c.render(ctx, game.time));
  // only flung blades wrap in gameplay; parked/drifting gems settle in place.
  for (const g of game.gems) maybeWrap(g.pos, g.radius * BODY_GLOW_REACH, g.fast, () => g.render(ctx, game.time));
  for (const al of game.aliens) maybeWrap(al.pos, al.radius * BODY_GLOW_REACH, false, () => al.render(ctx, game.time));
  for (const ab of game.alienBullets) wrapBody(ab.pos, ab.radius * ALIEN_BULLET_GLOW_REACH, () => ab.render(ctx));
  renderBossBeams(ctx, game.bossBeams);
  for (const b of game.bullets) wrapBody(b.pos, b.radius * BULLET_GLOW_REACH, () => b.render(ctx));
  renderLasers(ctx, game.lasers);
  // every wave body brightens on the beat then tapers over ~100ms (paints over the sprites above).
  const beatFlash = currentBeatFlash(game);
  if (beatFlash > 0) {
    // flash rides each body; wrap it alongside the body so the glow doesn't get
    // cropped from a twin at the seam in the tiled snapshot.
    const flash = (pos: Vec, r: number) =>
      maybeWrap(pos, r * BODY_GLOW_REACH, false, () => paintBeatFlash(ctx, pos, r, beatFlash));
    for (const a of game.asteroids) flash(a.pos, a.radius);
    // warping-out comets/aliens skip the beat-flash — a full-size flash disc
    // would detach from the shrinking body diving down the portal throat.
    for (const c of game.comets) if (c.warpT === null) flash(c.pos, c.radius);
    for (const al of game.aliens) if (al.warpT === null) flash(al.pos, al.radius);
    for (const c of game.canisters) flash(c.pos, c.radius);
    for (const g of game.gems) flash(g.pos, g.radius);
  }
  if (focusedTarget) paintFocusGlow(ctx, focusedTarget);
  renderBassLightnings(ctx, game.bassLightnings, game.time * 0.001);
  renderDriftBursts(ctx, game.driftBursts, game.time * 0.001);
  game.particles.render(ctx);
  // The bass-drop shockwave ring radiates from the pulsar, so it rides the
  // pulsar (inline here for non-scroll modes; the scroll camera draws it on the
  // pulsar's parallax layer via paintPulsarLayer).
  if (pulsar) game.pulsar.renderShockwaveOverlay(ctx);
  // Popups (combo / pickup / score) anchor at the world spot they describe (a hit
  // location, the ship), so they scroll + wrap with the world, not the glass.
  renderPopups(ctx, game.popups);
};

// The pulsar's own layer: the planet + shockwave ring + spectrum halo, drawn
// together so they share one parallax depth. The scroll camera replicates this
// at the pulsar-parallax offsets (slower than the 1.0 entity layer) so the
// pulsar reads as a distant body the closer field slides past.
const paintPulsarLayer = (game: Game) => {
  const { ctx } = game;
  game.pulsar.render(ctx);
  game.pulsar.renderShockwaveOverlay(ctx);
  paintSpectrumVisualizer(game);
};

// reticule reads every visible target on the field; gather them once not repeatedly.
// Exported so the ship-rotation snap (gameUpdate) can use the same target set as the reticule.
// Alien bullets are deliberately excluded — they're incoming threats, not things you shoot,
// and painting trajectories for them clutters the field with predictions the player can't act on.
// The dormant boss is excluded too — during its approach it's meant to read as part of the
// background planet, so the reticule must not light it up or treat it as a lockable target.
export const targetsForReticule = (game: Game) => [
  // Skip intangible rocks — a dormant boss and a phased-out warble both pass
  // bullets through, so the reticule shouldn't promise a hit on them.
  ...game.asteroids.filter((a) => !(a.isBoss() && a.bossPhase === "dormant") && !a.isPhasedOut()),
  // Warping-out comets/aliens are intangible and leaving — don't lock them.
  ...game.comets.filter((c) => c.warpT === null),
  ...game.aliens.filter((a) => a.warpT === null),
  ...game.canisters,
  // Moving gems (the fan a burst gold asteroid throws off) are real rhythm
  // targets, so give them trajectory lines + a first-beat dot like any rock.
  // Parked/near-still drops self-skip in the trajectory walk (speed<1).
  ...game.gems.filter((g) => Math.hypot(g.vel.x, g.vel.y) >= 1),
];

// Ship + reticule + trajectory are the screen-pinned foreground: in scroll mode
// the ship is locked dead-center and the reticule/preview are drawn relative to
// it, so this layer is painted ONCE at the camera centre, never wrap-replicated.
// (Popups moved to the world layer — they anchor at world positions, not glass.)
const paintForeground = (game: Game, targets: ReadonlyArray<ReticuleTarget>) => {
  const { ctx } = game;
  const doubletime = comboGrid(game) < BEAT_GRID;
  // highlight the reticule + first-beat dot while the tutorial wants the player on a
  //   target: the drift/hover gate (3), the fire-and-hit sub-line (4), and build-to-4x (5).
  const tutorialHighlight =
    game.firstWaveHintStage === 3 ||
    (game.firstWaveHintStage === 4 && game.firstWaveHintSubVisible) ||
    game.firstWaveHintStage === 5;
  // perceivedBeatTime: the reticule pulse + first-beat dots cue when to fire, so they
  //   ride the latency-shifted clock and peak on the beat the player hears.
  // superBoosted (combo ≥ 12) doubles bullet range the same way longshot does — pass it
  //   through so the reticule renderer paints the matching 2-beat slot.
  const superBoosted = game.beatCombo >= 12;
  // gold crystals are stationary (or near-stationary) "First Dot" probes — they need a direct
  // proximity pass since the trajectory walk skips speed<1 targets.
  game.ship.renderReticules(ctx, BEAT_GRID, game.w, game.h, targets, game.perceivedBeatTime, doubletime, tutorialHighlight, game.sound, game.beatTime, superBoosted, game.gems);
  // ship.lastThrustActiveAt is recorded in game.time/1000 units; pass the same clock so
  // the post-thrust fade doesn't get stuck after intro overlays (which advance beatTime
  // without advancing game.time).
  renderShipTrajectoryPreview(ctx, game.ship, BEAT_GRID, game.time / 1000, game.w, game.h);
  game.ship.render(ctx, game.time, currentBeatPulse(game));
  renderLaserReticule(ctx, game, game.beatTime);
  renderLaserChargeDots(ctx, game, game.beatTime);
};

// Paint the full world scene (backdrop + background + entities + foreground +
// world-space overlays) into the current ctx at the current transform. Factored
// out of renderGame so the tiled edge-aid modes can paint it once to an
// offscreen canvas and composite that snapshot into tiles. `shakeX/shakeY` are
// passed in so a tiled snapshot can be taken without shake (tiles add their own
// transforms) while the normal path keeps the shake.
const paintScene = (game: Game, shakeX: number, shakeY: number, forSnapshot = false) => {
  const { ctx } = game;
  // Non-scroll cameras draw the reticule at folded [0,w) canvas coords, so make
  // sure no stale scroll-mode wrap anchor is left set from a prior frame.
  setReticuleWrapAnchor(null);
  ctx.save();
  paintBackdrop(game);
  ctx.translate(shakeX, shakeY);
  paintBackground(game);
  // pick the same focused target the reticule will draw the on-rhythm spot on, so the
  // brightness boost on the sprite and the reticule overlay agree on which target is "the one".
  // One target gather per frame, reused by the focus pick and the reticule pass.
  const targets = targetsForReticule(game);
  const focusedTarget = pickCenterMostTargetForFocus(
    game.ship.pos, computeConeFrame(game.ship), game.w, game.h, targets,
  );
  paintEntityLayers(game, focusedTarget, forSnapshot ? "all" : "gameplay");
  paintForeground(game, targets);
  // slow-mo countdown rail sits above the field so its beat ticks read clearly.
  renderSlowMoTimerBar(game);
  // laser ambient wash sits above entities; the bass-drop white flash sits above
  // even that so a bass drop still wins.
  renderLaserAmbientFlash(ctx, game);
  // For a tiled snapshot the visualizer halo must live in the snapshot so it
  // scrolls + tiles with the pulsar it rings; the straight (off) path draws it
  // after the scene as a screen-pinned overlay instead.
  if (forSnapshot) renderSpectrumVisualizer(game);
  ctx.restore();
};

// ── Scroll mode (locked-center): live wrap-replicated paint ───────────────────
// The default camera. The ship is pinned to screen centre and the torus scrolls
// around it. Rather than snapshot-then-tile (which clips anything drawn past the
// 1920x1080 buffer at the seam — every effect would have to opt into a wrap
// twin), we paint the LIVE world directly at each of the <=4 wrap offsets that
// intersect the viewport. Every entity, particle, and effect is captured whole;
// clipping is structurally impossible and no per-effect bookkeeping is needed.
//
// Layering (deepest first):
//   • backdrop + background — painted ONCE, scrolled with per-layer parallax so
//     the starfield stays behind everything and never tiles in front of an effect
//   • pulsar layer (pulsar + shockwave ring + spectrum halo) — replicated at its
//     OWN parallax (slower than entities), so it reads as a distant body
//   • world layer (entities, effects, popups) — replicated at the 1.0 wrap
//     offsets so bodies straddling the seam appear whole on both sides
//   • screen-pinned foreground (ship at centre, reticule, slow-mo bar)
// The pulsar slides slower than gameplay entities — a distant body, not at the
// ship's depth (but nearer than the twinkling star layers at STARFIELD_PARALLAX).
// The nearest foreground accents (ecliptic stars) ride the pulsar's own focal
// transform, orbiting the shared ecliptic alongside the planets.
const PULSAR_PARALLAX = 0.62;

// Advance the render-only continuous camera (Game.camScroll*). The ship's
// gameplay position wraps each frame, so we can't difference it directly — we
// take the step toroidally (a wrap reads as a small move, not a ±w jump) and
// integrate it. Seeded to the exact `w/2 - ship.pos` on the first frame (and
// after a resize/teleport, detected by an out-of-torus jump) so the camera is
// pixel-identical to the old math except that it never snaps.
const updateCamScroll = (game: Game) => {
  const { w, h, ship } = game;
  const seed = () => {
    game.camScrollX = w / 2 - ship.pos.x;
    game.camScrollY = h / 2 - ship.pos.y;
  };
  if (game.lastShipPosX === null || game.lastShipPosY === null) {
    seed();
  } else {
    const [dx, dy] = toroidalDelta(ship.pos.x - game.lastShipPosX, ship.pos.y - game.lastShipPosY, w, h);
    // A step larger than a wrapped frame's worth means a respawn/teleport, not
    // motion — reseed rather than smear a huge slide across the field.
    if (Math.hypot(dx, dy) > Math.min(w, h) * 0.25) seed();
    else {
      game.camScrollX -= dx;
      game.camScrollY -= dy;
    }
  }
  game.lastShipPosX = ship.pos.x;
  game.lastShipPosY = ship.pos.y;
};

const paintScrollScene = (game: Game, shakeX: number, shakeY: number) => {
  const { ctx, w, h } = game;
  // Exact camera offset that maps the ship's world position to screen centre.
  // The world layer (`% w` inside tileCopies) and the foreground translate both
  // need this exact so the pinned ship lands pixel-dead-centre.
  const camX = w / 2 - game.ship.pos.x;
  const camY = h / 2 - game.ship.pos.y;
  // Continuous version for the SUB-1 parallax layers (pulsar + starfield). Those
  // scale the offset by a fraction <1, so the per-frame ±w snap `camX` takes at a
  // seam crossing becomes a `parallax·w` jolt that `% w` can't hide. camScroll
  // integrates the ship's toroidal step instead, so it never snaps; it equals
  // camX modulo w, so the layers land in the same place — just without the jump.
  updateCamScroll(game);
  const parallaxX = game.camScrollX;
  const parallaxY = game.camScrollY;

  // Replicate `paint` at the <=4 wrap copies of a layer scrolled by (sx,sy) that
  // intersect the viewport. The torus is one screen wide/tall, so two copies per
  // axis cover it; skip any copy fully off-screen (ship exactly on a seam).
  const tileCopies = (sx: number, sy: number, paint: () => void) => {
    let ox = sx % w;
    if (ox > 0) ox -= w;
    let oy = sy % h;
    if (oy > 0) oy -= h;
    for (let i = 0; i < 2; i++) {
      const cx = ox + i * w;
      if (cx >= w || cx + w <= 0) continue;
      for (let j = 0; j < 2; j++) {
        const cy = oy + j * h;
        if (cy >= h || cy + h <= 0) continue;
        ctx.save();
        ctx.translate(cx, cy);
        paint();
        ctx.restore();
      }
    }
  };

  ctx.save();
  paintBackdrop(game);
  ctx.translate(shakeX, shakeY);

  // Background once; it applies its own per-layer parallax to the camera offset.
  paintBackground(game, parallaxX, parallaxY);

  const targets = targetsForReticule(game);
  const focusedTarget = pickCenterMostTargetForFocus(
    game.ship.pos, computeConeFrame(game.ship), game.w, game.h, targets,
  );

  // Spectrum band state advances exactly once, before any copy paints it.
  updateSpectrumVisualizer(game);

  // Pulsar layer at its own (slower) parallax, behind the entities.
  tileCopies(parallaxX * PULSAR_PARALLAX, parallaxY * PULSAR_PARALLAX, () => paintPulsarLayer(game));

  // World layer at the 1.0 wrap offsets. wrapMode "none": every copy is a live
  // full paint, so a body near the seam is drawn whole by the neighbouring copy
  // (the per-body twin would double-draw it).
  tileCopies(camX, camY, () => paintEntityLayers(game, focusedTarget, "none", false));

  // Screen-pinned foreground: ship is locked dead-centre, so translate the world
  // by the camera offset and the reticule/preview (drawn relative to ship.pos)
  // land centred. These are painted once — no wrap copies. The reticule's dot
  // draw-positions must wrap to the ship's nearest toroidal copy (not fold into
  // [0,w)) so they stay put across a seam under this translate, hence the anchor.
  ctx.save();
  ctx.translate(camX, camY);
  setReticuleWrapAnchor(game.ship.pos);
  paintForeground(game, targets);
  setReticuleWrapAnchor(null);
  ctx.restore();

  // Glass overlays (slow-mo rail, laser wash) sit on the screen, not the world,
  // so they're drawn once in screen space. The spectrum halo already rode the
  // pulsar layer above (it rings the wrapped pulsar).
  renderSlowMoTimerBar(game);
  renderLaserAmbientFlash(ctx, game);
  ctx.restore();
};

// The ship has no wrap-twin, so the tiled snapshot crops it at the world edge.
// Redraw it whole on top at a caller-chosen offset/scale. The reticule is left
// to the snapshot — it's gameplay UI tied to the live field, not a landmark.
const paintShipOverlay = (game: Game, ox: number, oy: number, scale: number) => {
  const { ctx } = game;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  game.ship.render(ctx, game.time, currentBeatPulse(game));
  ctx.restore();
};

// one entry point so main.ts doesn't see the layer ordering, and shake wraps the whole scene.
export const renderGame = (game: Game) => {
  const { shakeX, shakeY } = applyScreenShake(game);
  // Scroll (locked-center) is the default camera: it paints the live world
  // wrap-replicated, so it owns the whole render and never snapshots.
  if (game.edgeAidMode === "scroll") {
    paintScrollScene(game, shakeX, shakeY);
    return;
  }
  // The snapshot-tiled edge-aid modes (2x2 / 3x3) take over the whole scene
  // render; for those renderEdgeAidsTiled paints the scene to an offscreen and
  // composites the tiles. "off" and every other state paint the scene straight.
  const landmarks = { paintShip: paintShipOverlay };
  const tiled = renderEdgeAidsTiled(game, paintScene, landmarks);
  if (!tiled) {
    paintScene(game, shakeX, shakeY);
    // Master-bus spectrum halo — drawn after the scene as a screen-pinned
    // overlay. Tiled modes draw it inside the snapshot instead (see paintScene)
    // so it scrolls with the pulsar, so skip the pinned copy here.
    renderSpectrumVisualizer(game);
  }
};
