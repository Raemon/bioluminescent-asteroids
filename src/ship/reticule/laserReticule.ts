import type { Game } from "../../Game";
import { reachableBeamLengths, laserDotCount, maxLaserDots, laserBeamEndpointAt } from "../../game/laserShot";
import { BEAT_GRID } from "../../game/rhythmConstants";
import { drawGlow } from "../../glow";

// Laser-mode reticule. The circular aim disc is a bullet sight — it has no
// meaning for the beam, which fires straight down the ship's heading — so under
// the laser upgrade renderShipReticules skips it and we draw this instead.
//
// Each reachable charge tier has a "range gate" at the end of its reach: a pair
// of caliper ticks straddling the firing line with a glowing pip on the centre
// line, so the beam reads as passing THROUGH a distance gate. Crucially the gates
// are CHARGE-AWARE: an idle laser shows only the gate its current (0-dot) shot
// reaches; deeper gates appear one at a time, arming into view, only as the
// player actually holds the charge toward them. So the sight never promises range
// the shot doesn't have.

// Gate hue ramps cyan → warm white-gold as the tier climbs toward max charge,
// mirroring the charge-dot / beam escalation so the sight colour tracks power.
const GATE_HSL_NEAR = { h: 195, s: 100, l: 75 }; // cyan, the resting laser hue
const GATE_HSL_MAX = { h: 45, s: 100, l: 88 };   // white-gold at full charge
// Caliper geometry: each tick sits GATE_OFFSET off the centre line and runs
// GATE_TICK_LEN along the perpendicular; the pip marks the exact reach.
// The whole glyph (both ticks + pip) is rotated 90° as a unit at paint time.
const GATE_OFFSET = 6;
const GATE_TICK_LEN = 9;
const GATE_TICK_WIDTH = 2;
const GATE_PIP_R = 2.4;
const GATE_ROTATION = Math.PI / 2;
// Passed tiers (the shot overshoots them) draw faintly as a charge ladder.
const GATE_PASSED_ALPHA = 0.28;
// gentle on-beat breathe so the gates share the rest of the HUD's pulse.
const PULSE_MIN = 0.45;
const PULSE_MAX = 0.9;
const PULSE_PERIOD_SEC = 2.0;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

// hue between the near (cyan) and max (gold) gate colours by tier fraction.
const gateHsl = (tierFrac: number): string => {
  const t = clamp01(tierFrac);
  const h = GATE_HSL_NEAR.h + (GATE_HSL_MAX.h - GATE_HSL_NEAR.h) * t;
  const s = GATE_HSL_NEAR.s + (GATE_HSL_MAX.s - GATE_HSL_NEAR.s) * t;
  const l = GATE_HSL_NEAR.l + (GATE_HSL_MAX.l - GATE_HSL_NEAR.l) * t;
  return `${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%`;
};

// Paint a range gate with its pip on the beam endpoint. Two caliper ticks rotate
// with the pip as one unit. `scale` (0..1) grows the whole glyph in for arming.
const paintGate = (
  ctx: CanvasRenderingContext2D,
  endX: number, endY: number, dx: number, dy: number,
  alpha: number, hsl: string, scale: number,
) => {
  if (alpha <= 0.001 || scale <= 0.001) return;
  const off = GATE_OFFSET * scale;
  const len = GATE_TICK_LEN * scale;
  ctx.save();
  ctx.translate(endX, endY);
  ctx.rotate(Math.atan2(dy, dx) + GATE_ROTATION);
  ctx.strokeStyle = `hsla(${hsl}, ${alpha})`;
  ctx.lineWidth = GATE_TICK_WIDTH;
  ctx.lineCap = "round";
  // Canonical +x runs toward the beam tip; pip sits on the tip, ticks sweep back.
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(-off, off * sign);
    ctx.lineTo(-off - len, off * sign);
    ctx.stroke();
  }
  // centre pip with a soft glow — the precise endpoint the shot reaches.
  // drawGlow leaves globalAlpha set; reset before the pip fill so it isn't dimmed.
  drawGlow(ctx, 0, 0, GATE_PIP_R * 3 * scale, GATE_HSL_NEAR.h, alpha * 0.5);
  ctx.globalAlpha = 1;
  ctx.fillStyle = `hsla(${hsl}, ${Math.min(1, alpha * 1.2)})`;
  ctx.beginPath();
  ctx.arc(0, 0, GATE_PIP_R * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

export const renderLaserReticule = (
  ctx: CanvasRenderingContext2D, game: Game, beatTime: number,
) => {
  const ship = game.ship;
  if (!ship.alive || !ship.lasershotActive) return;
  const lengths = reachableBeamLengths(game);
  if (lengths.length === 0) return;
  const maxDots = maxLaserDots(game);
  // live charge tier (0 when idle); the gate it reaches is the ACTIVE one.
  const dots = laserDotCount(ship, beatTime, maxDots);
  const charging = ship.laserChargeActive;
  // progress 0..1 toward the next dot — drives the arming gate growing in.
  const nextDotFrac = charging
    ? clamp01((beatTime - (ship.laserChargeStartBeatTime + dots * BEAT_GRID)) / BEAT_GRID)
    : 0;
  const dirX = Math.cos(ship.heading);
  const dirY = Math.sin(ship.heading);
  const pulse = PULSE_MIN + (PULSE_MAX - PULSE_MIN) * (0.5 + 0.5 * Math.cos((beatTime / PULSE_PERIOD_SEC) * Math.PI * 2));
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const maxTier = lengths.length - 1;
  for (let tier = 0; tier < lengths.length; tier++) {
    const end = laserBeamEndpointAt(ship, lengths[tier]);
    const hsl = gateHsl(maxTier > 0 ? tier / maxTier : 0);
    if (tier < dots) {
      // passed tier — the shot overshoots it; draw a dim ladder rung.
      paintGate(ctx, end.x, end.y, dirX, dirY, GATE_PASSED_ALPHA, hsl, 1);
    } else if (tier === dots) {
      // ACTIVE gate — where a release right now lands; full brightness + breathe.
      paintGate(ctx, end.x, end.y, dirX, dirY, pulse, hsl, 1);
    } else if (tier === dots + 1 && charging) {
      // ARMING gate — the next tier locking in as the dot lands; grows from 0.
      paintGate(ctx, end.x, end.y, dirX, dirY, pulse * nextDotFrac, hsl, 0.4 + 0.6 * nextDotFrac);
    }
    // deeper tiers (tier > dots + 1) are not drawn — they only appear once charge
    // reaches them, so the sight never promises range the shot doesn't have.
  }
  ctx.restore();
};
