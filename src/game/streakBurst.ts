import type { Game } from "../Game";
import type { Vec } from "../vec";
import { drawGlow } from "../glow";
import { popupStreakShots } from "./popups";
import { BEAT_GRID } from "./rhythmConstants";

// Rhythm-streak orbs. Landing successive combo-shots within STREAK_MAX_GAP beats
// of each other grows a ring of glowing orbs orbiting the reticule. The whole
// ring fades linearly over the extension window and reaches zero exactly when
// the window closes — orbs still visible means the streak can still be extended.
// Breaking the interval (or a combo loss) ends the streak and flares every
// orb outward — the "N STREAK SHOTS" reward.
//
// Orbit phase is a pure function of beatTime; the fade + window are pure
// functions of perceivedBeatTime (the clock hits are judged on), and the
// end-flourish is a fully deterministic tween — no RNG anywhere here, so
// replays reproduce it exactly.

const TAU = Math.PI * 2;

// Orbs are the reticule's own cyan (hsl 195), just much brighter — full-alpha
//   glow + a hot white core against the reticule's faint dashes.
const STREAK_HUE = 195;

// Orbit radius + orb size. Large and bright so the ring reads clearly against a
//   chaotic field; radius is padded so the bigger orbs still sit outside the
//   crosshair rather than smothering it.
const ORBIT_RADIUS = 38;
const ORB_RADIUS = 11;

// Sharp orb sprite: unlike the soft radial drawGlow, this holds a bright white-hot
//   core, snaps to the reticule cyan by mid-radius, then cuts to nothing with only a
//   thin soft rim — reads as a hard bright pip, not a blurry smudge. Cached once (no
//   per-frame gradient; no shadowBlur — house rules).
const ORB_SPRITE_SIZE = 128;
let sharpOrbSprite: HTMLCanvasElement | null = null;
const getSharpOrbSprite = (): HTMLCanvasElement => {
  if (sharpOrbSprite) return sharpOrbSprite;
  const canvas = document.createElement("canvas");
  canvas.width = ORB_SPRITE_SIZE;
  canvas.height = ORB_SPRITE_SIZE;
  const ctx = canvas.getContext("2d")!;
  const c = ORB_SPRITE_SIZE / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, "hsla(0, 0%, 100%, 1)");
  grad.addColorStop(0.22, `hsla(${STREAK_HUE}, 100%, 92%, 1)`);
  grad.addColorStop(0.42, `hsla(${STREAK_HUE}, 100%, 62%, 0.95)`);
  grad.addColorStop(0.7, `hsla(${STREAK_HUE}, 100%, 55%, 0.35)`);
  grad.addColorStop(1, `hsla(${STREAK_HUE}, 100%, 55%, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, ORB_SPRITE_SIZE, ORB_SPRITE_SIZE);
  sharpOrbSprite = canvas;
  return sharpOrbSprite;
};

// Blit the sharp orb sprite at radius r. Caller sets additive composite + alpha handling.
const drawSharpOrb = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number) => {
  ctx.globalAlpha = alpha;
  ctx.drawImage(getSharpOrbSprite(), x - r, y - r, r * 2, r * 2);
};
// A shot extends the streak while its hit still rounds to a beat within this
//   many grid units of the last one (see trackStreak in rhythmBonus.ts).
export const STREAK_MAX_GAP = 4;
// only render up to this many orbs so a very long streak stays cheap; N still
//   counts in full for the metric + flare label.
const MAX_ORBS = 16;

// The extension window, measured from the last shot's beat center in the
//   streak's own grid units. Hits round perceivedBeatTime to the nearest grid
//   beat, so extension is possible until half a grid past the last legal beat —
//   the window closes at exactly the point where no future hit can qualify.
export const streakWindowLength = (game: Game): number =>
  (STREAK_MAX_GAP + 0.5) * game.streakGrid;

// True once no shot can extend the streak anymore. Judged on perceivedBeatTime —
//   the same clock hit qualification uses — so the cutoff can't race a legal
//   max-gap shot the way the old raw-beatTime timeout did.
export const streakWindowClosed = (game: Game): boolean =>
  game.perceivedBeatTime - game.streakLastBeatCenter >= streakWindowLength(game);

// Shared 0..1 fade for the whole ring: 1 at the last hit's beat center, linear
//   to 0 at window close — the visual dies exactly when extension becomes
//   impossible, in every grid tier.
const streakFade = (game: Game): number => {
  if (game.streakShots < 1 || game.streakGrid <= 0) return 0;
  const elapsed = game.perceivedBeatTime - game.streakLastBeatCenter;
  return Math.max(0, Math.min(1, 1 - elapsed / streakWindowLength(game)));
};

// Beat-synced pulse: brightest right on each beat, easing down between beats.
const beatPulse = (game: Game): number => {
  const phase = game.beatTime / BEAT_GRID;
  const sinceBeat = phase - Math.floor(phase); // 0 at the beat
  return 1 - sinceBeat;
};

// Live orbs orbiting the reticule at `center`. Caller sets additive composite.
export const renderStreakOrbs = (ctx: CanvasRenderingContext2D, game: Game, center: Vec) => {
  const n = game.streakShots;
  if (n < 1) return;
  const fade = streakFade(game);
  if (fade <= 0) return;
  // one revolution per streakInterval beats; phase derives from beatTime so it's
  //   continuous and deterministic. beatTime/BEAT_GRID = beats elapsed.
  const revBeats = game.streakInterval > 0 ? game.streakInterval : 4;
  const orbitPhase = (game.beatTime / BEAT_GRID / revBeats) * TAU;
  const shown = Math.min(n, MAX_ORBS);
  const pulse = 0.85 + 0.15 * beatPulse(game);
  for (let i = 0; i < shown; i++) {
    const ang = orbitPhase + (i / shown) * TAU;
    const x = center.x + Math.cos(ang) * ORBIT_RADIUS;
    const y = center.y + Math.sin(ang) * ORBIT_RADIUS;
    const a = fade * pulse;
    // a faint wide halo keeps the orb legible against a busy field, then the sharp
    //   sprite lands the hard white-cored cyan pip on top.
    drawGlow(ctx, x, y, ORB_RADIUS * 1.4, STREAK_HUE, a * 0.28);
    drawSharpOrb(ctx, x, y, ORB_RADIUS, a);
  }
  ctx.globalAlpha = 1;
};

// ---- End-of-streak flourish: the orbs gather, then streak off together in a
//   straight horizontal line to where the "N STREAK SHOTS" label blooms. ----
//
// Applies the animation principles that make a reward read on a chaotic field:
//   Anticipation — the orbs pull inward + brighten (a wind-up) before launch.
//   Slow-in/slow-out — an ease-in-out S-curve, so they accelerate out of the
//     wind-up and settle into the line rather than snapping.
//   Squash & stretch — orbs stretch along X at peak velocity (a motion smear),
//     round back out as they arrive.
//   Secondary motion / follow-through — a fading trail smear lags behind each orb
//     along the travel axis, then the orbs dissolve into the label as it blooms.
//   Staging — bright white cores + wide halos + staggered arrival so the line
//     reads as assembling in the flight direction, not popping in at once.

type FlareOrb = {
  startX: number; // orbit position it launches FROM
  startY: number;
  slot: number; // 0-based index in the assembled horizontal row
};
export type StreakBurst = {
  originX: number;
  originY: number;
  dir: number; // +1 fly right, -1 fly left (whichever has more screen room)
  travel: number; // px the line travels horizontally
  gap: number; // spacing between orbs in the assembled row
  count: number;
  life: number;
  maxLife: number;
  orbs: FlareOrb[];
};

const FLARE_LIFE = 0.85;
const FLARE_TRAVEL = 150; // px the assembled line slides toward the label
const FLARE_GAP = 26; // spacing between orbs in the row
const ANTICIPATION = 0.18; // fraction of life spent winding inward before launch

// distance the label + line settle from the reticule, matching FLARE_TRAVEL so
//   the popup blooms exactly where the orbs arrive.
export const streakLabelOffset = (game: Game, center: Vec): { x: number; y: number; dir: number } => {
  const dir = center.x > game.w / 2 ? -1 : 1; // fly toward the roomier side
  return { x: center.x + dir * FLARE_TRAVEL, y: center.y, dir };
};

export const spawnStreakBurst = (game: Game, center: Vec) => {
  const n = Math.min(game.streakShots, MAX_ORBS);
  const revBeats = game.streakInterval > 0 ? game.streakInterval : 4;
  const startPhase = (game.beatTime / BEAT_GRID / revBeats) * TAU;
  const dir = center.x > game.w / 2 ? -1 : 1;
  const orbs: FlareOrb[] = [];
  for (let i = 0; i < n; i++) {
    const ang = startPhase + (i / n) * TAU;
    orbs.push({
      startX: center.x + Math.cos(ang) * ORBIT_RADIUS,
      startY: center.y + Math.sin(ang) * ORBIT_RADIUS,
      slot: i,
    });
  }
  game.streakBursts.push({
    originX: center.x,
    originY: center.y,
    dir,
    travel: FLARE_TRAVEL,
    gap: FLARE_GAP,
    count: n,
    life: FLARE_LIFE,
    maxLife: FLARE_LIFE,
    orbs,
  });
};

export const updateStreakBursts = (bursts: StreakBurst[], dt: number): StreakBurst[] => {
  for (const b of bursts) b.life -= dt;
  return bursts.filter((b) => b.life > 0);
};

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

// A horizontally-stretched glow: draw the sprite wider than tall to smear the orb
//   along its travel — squash & stretch without a separate sprite.
const drawStretched = (
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number, stretch: number,
  hue: number, alpha: number, white = false,
) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(stretch, 1 / Math.sqrt(stretch));
  drawGlow(ctx, 0, 0, r, hue, alpha, white);
  ctx.restore();
};

// Caller does NOT need to set composite mode — handled here (additive).
export const renderStreakBursts = (ctx: CanvasRenderingContext2D, bursts: StreakBurst[]) => {
  if (bursts.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const b of bursts) {
    const t = 1 - b.life / b.maxLife; // 0 → 1 over the flourish
    // row is centred on the origin so the label (also centred on the target) reads
    //   with the line: total width (count-1)*gap, first slot at -half.
    const rowHalf = ((b.count - 1) * b.gap) / 2;
    for (const o of b.orbs) {
      // assembled-row target for this orb.
      const targetX = b.originX + b.dir * b.travel - rowHalf + o.slot * b.gap;
      const targetY = b.originY;

      let x: number, y: number, stretch: number, alpha: number, r: number;
      if (t < ANTICIPATION) {
        // Anticipation: ease inward toward the origin and brighten — the wind-up.
        const at = t / ANTICIPATION;
        const pull = easeOut(at) * 0.4; // pull 40% of the way in
        x = o.startX + (b.originX - o.startX) * pull;
        y = o.startY + (b.originY - o.startY) * pull;
        stretch = 1;
        alpha = 0.85 + 0.15 * at;
        r = ORB_RADIUS * (1 + 0.25 * at); // swell slightly as it charges
      } else {
        // Flight: ease-in-out from the wound-up cluster to the row slot, staggered
        //   per slot so the line assembles left-to-right (in flight direction).
        const ft = (t - ANTICIPATION) / (1 - ANTICIPATION);
        const stagger = (o.slot / Math.max(1, b.count)) * 0.18;
        const local = Math.max(0, Math.min(1, (ft - stagger) / (1 - stagger)));
        const e = easeInOut(local);
        // launch FROM the wound-up position (40% pulled in).
        const fromX = o.startX + (b.originX - o.startX) * 0.4;
        const fromY = o.startY + (b.originY - o.startY) * 0.4;
        x = fromX + (targetX - fromX) * e;
        y = fromY + (targetY - fromY) * e;
        // speed peaks mid-flight (derivative of ease-in-out) → stretch there.
        const speed = Math.sin(Math.min(1, local) * Math.PI); // 0→1→0
        stretch = 1 + 2.2 * speed;
        // fade out over the last stretch so it dissolves into the settled label.
        alpha = 1 - easeOut(Math.max(0, (t - 0.6) / 0.4));
        r = ORB_RADIUS * (1 + 0.25);
      }

      // trailing smear (secondary motion): a dimmer, longer-stretched ghost lagging
      //   behind along the travel axis.
      if (stretch > 1.05) {
        drawStretched(ctx, x - b.dir * r * 0.8, y, r * 0.9, stretch * 1.4, STREAK_HUE, alpha * 0.35);
      }
      drawStretched(ctx, x, y, r * 1.4, stretch, STREAK_HUE, alpha * 0.45);
      drawStretched(ctx, x, y, r, stretch, STREAK_HUE, alpha);
      drawStretched(ctx, x, y, r * 0.5, stretch, STREAK_HUE, alpha, true);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
};

// ---- Streak lifecycle (shared by rhythmBonus + rhythmGate/loseCombo). ----

// Zero the run-streak state. Keeps the per-wave total. Kept here so both
//   rhythmBonus and rhythmGate (loseCombo) can call it without an import cycle
//   through comboGrid.
export const resetStreak = (game: Game) => {
  game.streakInterval = 0;
  game.streakGrid = 0;
  game.streakShots = 0;
  game.streakEstablished = false;
  game.streakLastBeatCenter = -1;
};

// End an active streak: flare the orbs + flash "N STREAK SHOTS", then clear the
//   run-streak state. Only an ESTABLISHED streak (2+ matching shots) flares and
//   labels; a lone unconfirmed first orb just clears silently.
export const endStreak = (game: Game) => {
  if (game.streakEstablished && game.streakShots >= 1) {
    const center = game.streakOrbCenter ?? game.ship.pos;
    spawnStreakBurst(game, center);
    // Label blooms at the flight destination — the orbs stream into it, so the
    //   number reads as being delivered by the streak that earned it.
    const label = streakLabelOffset(game, center);
    game.popups.push(popupStreakShots({ x: label.x, y: label.y }, game.streakShots));
    game.sound.play("comboSparkle", 1, center);
    game.sound.play("crystalShatterSmall", 1, center);
  }
  resetStreak(game);
};
