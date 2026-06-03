import type { Ship } from "../Ship";
import { wrap } from "../vec";
import { computeBeatPulseBoost, SHOW_SHIP_TRAJECTORY } from "./reticule/trajectoryPreview";

// ship's own forecast path — small forward-pointing chevrons mark where the ship will be at
// successive beats if it keeps its current velocity. Uses the cyan hull hue (195) so it reads
// as "this is YOUR trajectory", and the chevron shape carries direction of motion.
const SHIP_TRAJECTORY_HSL = "195, 100%, 75%";
const SHIP_TRAJECTORY_DOT_RADIUS = 1.6;
const SHIP_TRAJECTORY_DOT_ALPHA = 0.6;
const SHIP_TRAJECTORY_FIRST_DOT_RADIUS = 2.4;
const SHIP_TRAJECTORY_FIRST_DOT_ALPHA = 0.85;
// chevron geometry derived from the dot radius: length along velocity and half-width across it.
const SHIP_TRAJECTORY_CHEVRON_LENGTH_FACTOR = 2.4;
const SHIP_TRAJECTORY_CHEVRON_HALF_WIDTH_FACTOR = 1.8;
const SHIP_TRAJECTORY_CHEVRON_LINE_WIDTH = 1;
// how many upcoming-beat dots to render. 6 beats forward = 3 seconds at BEAT_GRID=0.5 — long
// enough to project meaningfully, short enough that drift doesn't render the further dots noisy.
const SHIP_TRAJECTORY_BEAT_COUNT = 6;
// minimum speed for the preview to render at all. Below this the ship is effectively drifting
// in place and dots would clump on top of each other.
const SHIP_TRAJECTORY_MIN_SPEED = 30;
// ramp the preview in as the ship accelerates from the min-speed threshold — avoids a hard pop.
const SHIP_TRAJECTORY_FADE_IN_SPEED = 80;
// trajectory line is most useful while actively maneuvering — once the player has been
// coasting for a while their heading is set and the preview becomes visual noise. Hold full
// alpha for HOLD beats after the last thrust frame, then fade to invisible over FADE beats.
const SHIP_TRAJECTORY_POST_THRUST_HOLD_BEATS = 1;
const SHIP_TRAJECTORY_POST_THRUST_FADE_BEATS = 2;

export const renderShipTrajectoryPreview = (
  ctx: CanvasRenderingContext2D, ship: Ship, beatGrid: number, beatTime: number, w: number, h: number,
) => {
  if (!SHOW_SHIP_TRAJECTORY) return;
  if (!ship.alive) return;
  const speed = Math.hypot(ship.vel.x, ship.vel.y);
  if (speed < SHIP_TRAJECTORY_MIN_SPEED) return;
  const speedFade = Math.min(1, (speed - SHIP_TRAJECTORY_MIN_SPEED) / (SHIP_TRAJECTORY_FADE_IN_SPEED - SHIP_TRAJECTORY_MIN_SPEED));
  // drop the preview after the hold window so a coasting player isn't staring at a stale line.
  const holdSec = SHIP_TRAJECTORY_POST_THRUST_HOLD_BEATS * beatGrid;
  const fadeSec = SHIP_TRAJECTORY_POST_THRUST_FADE_BEATS * beatGrid;
  const sinceThrust = beatTime - ship.lastThrustActiveAt;
  if (sinceThrust >= holdSec + fadeSec) return;
  const postThrustFade = sinceThrust <= holdSec
    ? 1
    : 1 - (sinceThrust - holdSec) / fadeSec;
  const beatPulseBoost = computeBeatPulseBoost(beatTime, beatGrid);

  const ux = ship.vel.x / speed;
  const uy = ship.vel.y / speed;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.setLineDash([]);
  ctx.lineWidth = SHIP_TRAJECTORY_CHEVRON_LINE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let k = 1; k <= SHIP_TRAJECTORY_BEAT_COUNT; k++) {
    const pos = wrap({
      x: ship.pos.x + ship.vel.x * beatGrid * k,
      y: ship.pos.y + ship.vel.y * beatGrid * k,
    }, w, h);
    const isFirst = k === 1;
    const baseAlpha = isFirst ? SHIP_TRAJECTORY_FIRST_DOT_ALPHA : SHIP_TRAJECTORY_DOT_ALPHA;
    // chevrons further out fade so the eye reads "near future is reliable, far future is a hint".
    const distanceFade = 1 - 0.6 * (k - 1) / SHIP_TRAJECTORY_BEAT_COUNT;
    const pulse = isFirst ? beatPulseBoost : 1;
    const alpha = Math.min(1, baseAlpha * distanceFade * speedFade * pulse * postThrustFade);
    const radius = isFirst ? SHIP_TRAJECTORY_FIRST_DOT_RADIUS : SHIP_TRAJECTORY_DOT_RADIUS;
    const forward = radius * SHIP_TRAJECTORY_CHEVRON_LENGTH_FACTOR * 0.5;
    const back = forward;
    const half = radius * SHIP_TRAJECTORY_CHEVRON_HALF_WIDTH_FACTOR;
    const apexX = pos.x + ux * forward;
    const apexY = pos.y + uy * forward;
    const blX = pos.x - ux * back - (-uy) * half;
    const blY = pos.y - uy * back - ux * half;
    const brX = pos.x - ux * back + (-uy) * half;
    const brY = pos.y - uy * back + ux * half;
    ctx.strokeStyle = `hsla(${SHIP_TRAJECTORY_HSL}, ${alpha})`;
    ctx.beginPath();
    ctx.moveTo(blX, blY);
    ctx.lineTo(apexX, apexY);
    ctx.lineTo(brX, brY);
    ctx.stroke();
  }
  ctx.restore();
};
