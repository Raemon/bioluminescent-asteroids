import type { Ship } from "../Ship";
import { TAU, wrap } from "../vec";
import { computeBeatPulseBoost, SHOW_SHIP_TRAJECTORY } from "./reticule/trajectoryPreview";

// Why: ship's own forecast path — dots mark where the ship will be at successive beats if it keeps
// its current velocity. Mirrors the asteroid beat-dot language so the player reads "rhythm = position"
// for their own motion too. Uses the cyan hull hue (195) so it reads as "this is YOUR trajectory".
const SHIP_TRAJECTORY_HSL = "195, 100%, 75%";
const SHIP_TRAJECTORY_DOT_RADIUS = 1.6;
const SHIP_TRAJECTORY_DOT_ALPHA = 0.6;
const SHIP_TRAJECTORY_FIRST_DOT_RADIUS = 2.4;
const SHIP_TRAJECTORY_FIRST_DOT_ALPHA = 0.85;
// Why: how many upcoming-beat dots to render. 6 beats forward = 3 seconds at BEAT_GRID=0.5 — long
// enough to project meaningfully, short enough that drift doesn't render the further dots noisy.
const SHIP_TRAJECTORY_BEAT_COUNT = 6;
// Why: minimum speed for the preview to render at all. Below this the ship is effectively drifting
// in place and dots would clump on top of each other.
const SHIP_TRAJECTORY_MIN_SPEED = 30;
// Why: ramp the preview in as the ship accelerates from the min-speed threshold — avoids a hard pop.
const SHIP_TRAJECTORY_FADE_IN_SPEED = 80;

export const renderShipTrajectoryPreview = (
  ctx: CanvasRenderingContext2D, ship: Ship, beatGrid: number, beatTime: number, w: number, h: number,
) => {
  if (!SHOW_SHIP_TRAJECTORY) return;
  if (!ship.alive) return;
  const speed = Math.hypot(ship.vel.x, ship.vel.y);
  if (speed < SHIP_TRAJECTORY_MIN_SPEED) return;
  const speedFade = Math.min(1, (speed - SHIP_TRAJECTORY_MIN_SPEED) / (SHIP_TRAJECTORY_FADE_IN_SPEED - SHIP_TRAJECTORY_MIN_SPEED));
  const beatPulseBoost = computeBeatPulseBoost(beatTime, beatGrid);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.setLineDash([]);
  for (let k = 1; k <= SHIP_TRAJECTORY_BEAT_COUNT; k++) {
    const pos = wrap({
      x: ship.pos.x + ship.vel.x * beatGrid * k,
      y: ship.pos.y + ship.vel.y * beatGrid * k,
    }, w, h);
    const isFirst = k === 1;
    const baseAlpha = isFirst ? SHIP_TRAJECTORY_FIRST_DOT_ALPHA : SHIP_TRAJECTORY_DOT_ALPHA;
    // Why: dots further out fade so the eye reads "near future is reliable, far future is a hint".
    // Floors at 0.4 so the last dot is still clearly visible, not nearly transparent.
    const distanceFade = 1 - 0.6 * (k - 1) / SHIP_TRAJECTORY_BEAT_COUNT;
    const pulse = isFirst ? beatPulseBoost : 1;
    const alpha = Math.min(1, baseAlpha * distanceFade * speedFade * pulse);
    ctx.fillStyle = `hsla(${SHIP_TRAJECTORY_HSL}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, isFirst ? SHIP_TRAJECTORY_FIRST_DOT_RADIUS : SHIP_TRAJECTORY_DOT_RADIUS, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
};
