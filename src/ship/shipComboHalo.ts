import type { Ship } from "../Ship";
import { haloVertices } from "./shipHitbox";

// combo tier <2 hides halo entirely; 2–3 shows cyan; ≥4 promotes to gold.
export const setComboFromValue = (ship: Ship, combo: number) => {
  if (combo >= 4) ship.comboHaloTier = 2;
  else if (combo >= 2) ship.comboHaloTier = 1;
  else ship.comboHaloTier = 0;
};

// shows the player where the hitbox actually sits even when no combo halo is active.
const paintDullHaloOutline = (ctx: CanvasRenderingContext2D, dullAlpha: number) => {
  if (dullAlpha <= 0.001) return;
  ctx.strokeStyle = `hsla(210, 30%, 70%, ${dullAlpha})`;
  ctx.lineWidth = 1.2;
  ctx.shadowBlur = 0;
  ctx.stroke();
};

// cyan→gold colour shift signals tier crossover; alpha pulses on beat so the rhythm reads at a glance.
const paintActiveHalo = (ctx: CanvasRenderingContext2D, tier1: number, tier2: number, beatPulse: number) => {
  if (tier1 <= 0.001) return;
  const hue = 195 + (45 - 195) * tier2;
  const alpha = (0.45 + 0.35 * beatPulse) * tier1;
  ctx.strokeStyle = `hsla(${hue}, 100%, 78%, ${alpha})`;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = `hsla(${hue}, 100%, 70%, 1)`;
  ctx.shadowBlur = 10 + 6 * beatPulse;
  ctx.stroke();
  ctx.shadowBlur = 0;
};

// red wash exactly where the cyan/gold halo just was, so the loss is felt visually as well as audibly.
const paintComboLossFlash = (ctx: CanvasRenderingContext2D, lossFlash: number) => {
  if (lossFlash <= 0.001) return;
  const alpha = 0.85 * lossFlash;
  ctx.strokeStyle = `hsla(0, 95%, 62%, ${alpha})`;
  ctx.lineWidth = 1.8;
  ctx.shadowColor = `hsla(0, 100%, 55%, 1)`;
  ctx.shadowBlur = 12 * lossFlash;
  ctx.stroke();
  ctx.shadowBlur = 0;
};

// tracing the actual collision silhouette guarantees the halo == hitbox visually and physically.
const traceHaloPath = (ctx: CanvasRenderingContext2D, ship: Ship) => {
  const halo = haloVertices(ship);
  ctx.beginPath();
  ctx.moveTo(halo[0][0], halo[0][1]);
  ctx.lineTo(halo[1][0], halo[1][1]);
  ctx.lineTo(halo[2][0], halo[2][1]);
  ctx.closePath();
};

// single ship-shaped outline that pulses with the beat and shows combo state in one visual.
export const renderComboHalo = (ctx: CanvasRenderingContext2D, ship: Ship, beatPulse: number) => {
  const i = ship.comboHaloIntensity;
  const tier1 = Math.min(1, i);
  const tier2 = Math.max(0, Math.min(1, i - 1));
  traceHaloPath(ctx, ship);
  paintDullHaloOutline(ctx, 0.4 * (1 - tier1));
  paintActiveHalo(ctx, tier1, tier2, beatPulse);
  paintComboLossFlash(ctx, ship.comboLossFlash);
};
