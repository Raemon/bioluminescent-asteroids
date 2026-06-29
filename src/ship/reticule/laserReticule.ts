import type { Game } from "../../Game";
import { fromAngle } from "../../vec";
import { reachableBeamLengths } from "../../game/laserShot";

// Laser-mode reticule. The circular aim disc is a bullet sight — it has no
// meaning for the beam, which fires straight down the ship's heading — so under
// the laser upgrade renderShipReticules skips it and we draw this instead: a
// short three-dash segment lying ALONG the firing line at the end of each
// reachable charge tier's reach. Each new dashed segment marks a farther reach,
// so the marks push outward (and a new one appears) as Farshot / combo-superboost
// / a deeper reachable charge tier extends the beam.

// matches the bullet reticule's dash hue so the sight still reads as "yours".
const LASER_RETICULE_HSL = "195, 100%, 75%";
// three dashes: dash length + gap, repeated 3x, centred on each tier's reach.
const DASH_LEN = 7;
const DASH_GAP = 5;
const DASH_COUNT = 3;
const LASER_RETICULE_LINE_WIDTH = 2;
// gentle on-beat breathe so the marks share the rest of the HUD's pulse.
const PULSE_MIN = 0.4;
const PULSE_MAX = 0.85;
const PULSE_PERIOD_SEC = 2.0;

// Paint a three-dash segment centred at world distance `dist` along `(dx,dy)`
// from the muzzle, with the dashes oriented along the beam.
const paintDashRun = (
  ctx: CanvasRenderingContext2D,
  muzzleX: number, muzzleY: number, dx: number, dy: number,
  dist: number, alpha: number,
) => {
  const runLen = DASH_COUNT * DASH_LEN + (DASH_COUNT - 1) * DASH_GAP;
  // centre the run on the tier's reach so the middle dash marks the actual end.
  let s = dist - runLen / 2;
  ctx.strokeStyle = `hsla(${LASER_RETICULE_HSL}, ${alpha})`;
  ctx.lineWidth = LASER_RETICULE_LINE_WIDTH;
  ctx.lineCap = "round";
  for (let i = 0; i < DASH_COUNT; i++) {
    const a = s;
    const b = s + DASH_LEN;
    ctx.beginPath();
    ctx.moveTo(muzzleX + dx * a, muzzleY + dy * a);
    ctx.lineTo(muzzleX + dx * b, muzzleY + dy * b);
    ctx.stroke();
    s = b + DASH_GAP;
  }
};

export const renderLaserReticule = (
  ctx: CanvasRenderingContext2D, game: Game, beatTime: number,
) => {
  const ship = game.ship;
  if (!ship.alive || !ship.lasershotActive) return;
  const lengths = reachableBeamLengths(game);
  if (lengths.length === 0) return;
  const dir = fromAngle(ship.heading, 1);
  const muzzleX = ship.pos.x + dir.x * (ship.radius + 4);
  const muzzleY = ship.pos.y + dir.y * (ship.radius + 4);
  const pulse = PULSE_MIN + (PULSE_MAX - PULSE_MIN) * (0.5 + 0.5 * Math.cos((beatTime / PULSE_PERIOD_SEC) * Math.PI * 2));
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  // farther tiers are dimmer so the eye reads the marks as "near reach is sure,
  // far reach needs more charge" rather than a wall of equal-weight dashes.
  for (let i = 0; i < lengths.length; i++) {
    const fade = 1 - (i / lengths.length) * 0.45;
    paintDashRun(ctx, muzzleX, muzzleY, dir.x, dir.y, lengths[i], pulse * fade);
  }
  ctx.restore();
};
