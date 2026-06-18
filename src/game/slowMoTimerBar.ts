import type { Game } from "../Game";
import { SLOW_MO_DURATION } from "./slowMo";
import { BEAT_GRID } from "./rhythmConstants";
import { drawGlow } from "../glow";

// Horizontal countdown rail along the bottom of the screen that appears while
// slow-mo is active. It shrinks symmetrically from both ends toward center as
// the timer runs down — when the two ends meet, slow-mo expires. Beat markers
// ride the rail at the screen-time positions of the upcoming quarter notes, so
// each tick sweeps into the closing edge exactly when its beat lands. Slow-mo
// stretches the beat grid, which is hard to anticipate by ear alone, so the
// rail gives the eye a read on where the next beats actually fall.

const RAIL_Y_FROM_BOTTOM = 26;
const RAIL_HALF_WIDTH_FRAC = 0.46;
const RAIL_THICKNESS = 2;
const TICK_HALF_HEIGHT = 7;
const CYAN_HUE = 190;

// Fade the whole rail in/out near the edges of the slow-mo window so it doesn't
// pop on at full brightness — mirrors the SLOW_MO_RAMP audio glide visually.
const edgeFade = (timer: number): number => {
  const inFrac = Math.min(1, (SLOW_MO_DURATION - timer) / 0.4);
  const outFrac = Math.min(1, timer / 0.6);
  return Math.max(0, Math.min(inFrac, outFrac));
};

export const renderSlowMoTimerBar = (game: Game) => {
  if (game.slowMoTimer <= 0) return;
  const { ctx, w, h } = game;
  const remaining = game.slowMoTimer;
  const fade = edgeFade(remaining);
  if (fade <= 0) return;

  const cx = w / 2;
  const y = h - RAIL_Y_FROM_BOTTOM;
  // Full half-width represents the full slow-mo duration; the live rail is that
  // scaled by how much of the duration is left, so the ends close toward center.
  const fullHalf = w * RAIL_HALF_WIDTH_FRAC;
  const liveHalf = fullHalf * (remaining / SLOW_MO_DURATION);
  // Seconds-per-pixel along the rail, fixed across the effect so beats stay put
  // on the time axis while the shrinking edge sweeps over them.
  const pxPerSec = fullHalf / SLOW_MO_DURATION;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // The closing rail itself.
  drawGlow(ctx, cx, y, liveHalf, CYAN_HUE, 0.18 * fade);
  ctx.globalAlpha = 0.85 * fade;
  ctx.fillStyle = `hsl(${CYAN_HUE}, 90%, 70%)`;
  ctx.fillRect(cx - liveHalf, y - RAIL_THICKNESS / 2, liveHalf * 2, RAIL_THICKNESS);

  // Bright caps at the two closing ends — the "playhead" the beats sweep into.
  drawGlow(ctx, cx - liveHalf, y, 6, CYAN_HUE, 0.7 * fade, true);
  drawGlow(ctx, cx + liveHalf, y, 6, CYAN_HUE, 0.7 * fade, true);

  // Beat ticks: each upcoming quarter note placed at its screen-time offset from
  // center, mirrored on both sides so the symmetric rail reads as one clock.
  // perceivedBeatTime so the ticks line up with the beats the player hears.
  const beatTime = game.perceivedBeatTime;
  const firstBeat = Math.ceil(beatTime / BEAT_GRID) * BEAT_GRID;
  for (let bt = firstBeat; ; bt += BEAT_GRID) {
    const delta = bt - beatTime;
    if (delta > remaining) break;
    const off = delta * pxPerSec;
    ctx.globalAlpha = 0.9 * fade;
    ctx.fillStyle = `hsl(${CYAN_HUE}, 95%, 82%)`;
    ctx.fillRect(cx - off - 1, y - TICK_HALF_HEIGHT, 2, TICK_HALF_HEIGHT * 2);
    ctx.fillRect(cx + off - 1, y - TICK_HALF_HEIGHT, 2, TICK_HALF_HEIGHT * 2);
    drawGlow(ctx, cx - off, y, 5, CYAN_HUE, 0.4 * fade, true);
    drawGlow(ctx, cx + off, y, 5, CYAN_HUE, 0.4 * fade, true);
  }

  ctx.restore();
};
