import { Vec, rand } from "../vec";
import { PowerupKind, POWERUP_HUE } from "../Canister";

// one shape powers combo/pickup/debug overlays so all three share the tick + render loop.
export type Popup = {
  pos: Vec;
  vel: Vec;
  life: number;
  maxLife: number;
  text: string;
  font: string;
  fill: string;
  shadowColor: string;
  shadowBlur: number;
  decayX: number;
  decayY: number;
  popPeak: number;
  popDuration: number;
  holdUntil: number;
  fadeGain: number;
  // when set, replaces the default text fill at render time — lets a popup
  // composite its own glyphs (e.g. keycaps for the Side Engines pickup).
  draw?: (ctx: CanvasRenderingContext2D, p: Popup, alpha: number, scale: number) => void;
};

const COMBO_POPUP_LIFE = 0.9;
const PICKUP_POPUP_LIFE = 1.6;
const BEAT_DEBUG_POPUP_LIFE = 1.2;
const SCORE_POPUP_LIFE = 1.0;
const BONUS_LIFE_POPUP_LIFE = 2.2;

const POWERUP_LABEL: Record<PowerupKind, string> = {
  prong: "PRONG",
  rapid: "RAPID FIRE",
  pierce: "PIERCE",
  shield: "SHIELD",
  slow: "SLOW-MO",
  radar: "RADAR",
  longshot: "LONGSHOT",
  sideEngines: "SIDE ENGINES",
};

// anchors the multiplier feedback at the spot the player actually struck, not a corner pulse.
export const popupCombo = (pos: Vec, multiplier: number): Popup => ({
  pos: { x: pos.x, y: pos.y - 6 },
  vel: { x: rand(-12, 12), y: -70 },
  life: COMBO_POPUP_LIFE,
  maxLife: COMBO_POPUP_LIFE,
  text: `x${multiplier % 1 === 0 ? multiplier.toFixed(0) : multiplier.toFixed(1)}`,
  font: "600 22px 'Space Grotesk', system-ui, sans-serif",
  fill: "#ffd86a",
  shadowColor: "rgba(255, 200, 80, 0.85)",
  shadowBlur: 14,
  decayX: 0.94, decayY: 0.94,
  popPeak: 0.375, popDuration: 0.15,
  holdUntil: 0, fadeGain: 1.4,
});

// +1-beat reward for landing an on-beat hit while the first-dot hover ring is locked.
//   Cyan to read distinctly from the gold multiplier popup it follows.
export const popupDriftBonus = (pos: Vec): Popup => ({
  pos: { x: pos.x, y: pos.y - 18 },
  vel: { x: rand(-10, 10), y: -65 },
  life: COMBO_POPUP_LIFE,
  maxLife: COMBO_POPUP_LIFE,
  text: "DRIFT SHOT",
  font: "700 18px 'Space Grotesk', system-ui, sans-serif",
  fill: "#9be8ff",
  shadowColor: "rgba(120, 220, 255, 0.85)",
  shadowBlur: 14,
  decayX: 0.94, decayY: 0.94,
  popPeak: 0.4, popDuration: 0.15,
  holdUntil: 0, fadeGain: 1.4,
});

// surfaces the streak break at the spot that caused it (ship fire / target hit).
export const popupComboLost = (pos: Vec): Popup => ({
  pos: { x: pos.x, y: pos.y - 6 },
  vel: { x: rand(-10, 10), y: -55 },
  life: 1.1,
  maxLife: 1.1,
  text: "RHYTHM LOST",
  font: "700 16px 'Space Grotesk', system-ui, sans-serif",
  fill: "#ff6a6a",
  shadowColor: "rgba(255, 90, 90, 0.85)",
  shadowBlur: 14,
  decayX: 0.94, decayY: 0.94,
  popPeak: 0.4, popDuration: 0.15,
  holdUntil: 0, fadeGain: 1.4,
});

// "+N" readout at the kill site so the player sees exactly what their hit was worth.
export const popupScore = (pos: Vec, points: number): Popup => ({
  pos: { x: pos.x, y: pos.y - 22 },
  vel: { x: rand(-10, 10), y: -60 },
  life: SCORE_POPUP_LIFE,
  maxLife: SCORE_POPUP_LIFE,
  text: `+${points}`,
  font: "600 18px 'Space Grotesk', system-ui, sans-serif",
  fill: "#e6f4ff",
  shadowColor: "rgba(200, 230, 255, 0.85)",
  shadowBlur: 12,
  decayX: 0.94, decayY: 0.94,
  popPeak: 0.3, popDuration: 0.15,
  holdUntil: 0, fadeGain: 1.4,
});

// "Bonus Life" floats off the ship every 50k points — white so it reads as a
// bright milestone against the cyan/gold of the combat HUD.
export const popupBonusLife = (pos: Vec): Popup => ({
  pos: { x: pos.x + 26, y: pos.y - 4 },
  vel: { x: 18, y: -28 },
  life: BONUS_LIFE_POPUP_LIFE,
  maxLife: BONUS_LIFE_POPUP_LIFE,
  text: "Bonus Life",
  font: "700 18px 'Space Grotesk', system-ui, sans-serif",
  fill: "#ffffff",
  shadowColor: "rgba(255, 255, 255, 0.9)",
  shadowBlur: 16,
  decayX: 0.96, decayY: 0.96,
  popPeak: 0.5, popDuration: 0.2,
  holdUntil: 0.5, fadeGain: 1,
});

// name-tag lets the player read what they grabbed even after the pickup burst clears.
export const popupPickup = (pos: Vec, kind: PowerupKind): Popup => {
  const hue = POWERUP_HUE[kind];
  return {
    pos: { x: pos.x, y: pos.y - 24 },
    vel: { x: 0, y: -18 },
    life: PICKUP_POPUP_LIFE,
    maxLife: PICKUP_POPUP_LIFE,
    text: POWERUP_LABEL[kind],
    font: "700 18px 'Space Grotesk', system-ui, sans-serif",
    fill: `hsl(${hue}, 90%, 70%)`,
    shadowColor: `hsla(${hue}, 95%, 65%, 0.9)`,
    shadowBlur: 14,
    decayX: 1, decayY: 0.96,
    popPeak: 0.3, popDuration: 0.15,
    holdUntil: 0.3, fadeGain: 1,
  };
};

// dev-only readout to diagnose drift between the rhythm gate and what the player hears.
export const popupBeatDebug = (pos: Vec, prefix: string, onBeat: boolean, offsetMs: string): Popup => ({
  pos: { x: pos.x, y: pos.y - 10 },
  vel: { x: rand(-8, 8), y: -40 },
  life: BEAT_DEBUG_POPUP_LIFE,
  maxLife: BEAT_DEBUG_POPUP_LIFE,
  text: `${prefix} ${onBeat ? "ON" : "OFF"} ${offsetMs}ms`,
  font: "600 14px 'Space Grotesk', system-ui, sans-serif",
  fill: onBeat ? "#7cffb0" : "#ff6a6a",
  shadowColor: onBeat ? "rgba(100, 255, 160, 0.7)" : "rgba(255, 100, 100, 0.7)",
  shadowBlur: 8,
  decayX: 0.94, decayY: 0.94,
  popPeak: 0, popDuration: 0,
  holdUntil: 0, fadeGain: 1.4,
});

// returns surviving array so callers can reassign (matches the codebase filter pattern).
export const updatePopups = (popups: Popup[], dt: number): Popup[] => {
  for (const p of popups) {
    p.life -= dt;
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.vel.x *= p.decayX;
    p.vel.y *= p.decayY;
  }
  return popups.filter((p) => p.life > 0);
};

// pickup holds full alpha then fades; combo/debug fade proportionally — one branch covers both.
const popupAlpha = (p: Popup, t: number): number => {
  if (p.holdUntil > 0) return t < p.holdUntil ? t / p.holdUntil : 1;
  return Math.min(1, t * p.fadeGain);
};

// birth-time pop-in scale draws the eye to the popup before settling to baseline size.
const popupScale = (p: Popup, age: number): number => {
  if (p.popPeak <= 0 || age >= p.popDuration) return 1;
  return 1 + (p.popDuration - age) * (p.popPeak / p.popDuration);
};

export const renderPopups = (ctx: CanvasRenderingContext2D, popups: Popup[]) => {
  if (popups.length === 0) return;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const p of popups) {
    const t = p.life / p.maxLife;
    const alpha = popupAlpha(p, t);
    const scale = popupScale(p, 1 - t);
    ctx.globalAlpha = alpha;
    ctx.font = p.font;
    ctx.fillStyle = p.fill;
    ctx.shadowColor = p.shadowColor;
    ctx.shadowBlur = p.shadowBlur;
    ctx.save();
    ctx.translate(p.pos.x, p.pos.y);
    ctx.scale(scale, scale);
    if (p.draw) p.draw(ctx, p, alpha, scale);
    else ctx.fillText(p.text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
};

// rounded-square keycap glyph rendered at the popup's local origin.
// x is the cap's center; returns the cap's full width (so the caller can
// advance the cursor).
const drawKeyCap = (
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  label: string,
  color: string, shadow: string,
): number => {
  const w = 22, h = 22, r = 5;
  const x = cx - w / 2, y = cy - h / 2;
  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = color;
  ctx.shadowColor = shadow;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.font = "700 14px 'Space Grotesk', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, cy + 1);
  ctx.restore();
  return w;
};

// "SIDE ENGINES (Z X)" — label text, then a parens-wrapped pair of keycaps
// for the Z and X bindings so the player learns the controls at pickup time.
export const popupSideEnginesPickup = (pos: Vec): Popup => {
  const hue = POWERUP_HUE.sideEngines;
  const fill = `hsl(${hue}, 95%, 72%)`;
  const shadow = `hsla(${hue}, 95%, 65%, 0.9)`;
  const labelFont = "700 18px 'Space Grotesk', system-ui, sans-serif";
  const parenFont = "700 20px 'Space Grotesk', system-ui, sans-serif";
  return {
    pos: { x: pos.x, y: pos.y - 24 },
    vel: { x: 0, y: -18 },
    life: PICKUP_POPUP_LIFE,
    maxLife: PICKUP_POPUP_LIFE,
    text: "SIDE ENGINES (Z X)",
    font: labelFont,
    fill,
    shadowColor: shadow,
    shadowBlur: 14,
    decayX: 1, decayY: 0.96,
    popPeak: 0.3, popDuration: 0.15,
    holdUntil: 0.3, fadeGain: 1,
    draw: (ctx) => {
      // measure piece widths so the whole row centers around the popup origin.
      ctx.save();
      ctx.font = labelFont;
      const labelW = ctx.measureText("SIDE ENGINES ").width;
      ctx.font = parenFont;
      const parenLW = ctx.measureText("(").width;
      const parenRW = ctx.measureText(")").width;
      const capW = 22;
      const capGap = 6;
      const groupW = parenLW + capW + capGap + capW + parenRW;
      const total = labelW + groupW;
      let cursor = -total / 2;

      // label
      ctx.font = labelFont;
      ctx.fillStyle = fill;
      ctx.shadowColor = shadow;
      ctx.shadowBlur = 14;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("SIDE ENGINES ", cursor, 0);
      cursor += labelW;

      // "("
      ctx.font = parenFont;
      ctx.fillText("(", cursor, 0);
      cursor += parenLW;

      // [Z]
      drawKeyCap(ctx, cursor + capW / 2, 0, "Z", fill, shadow);
      cursor += capW + capGap;

      // [X]
      drawKeyCap(ctx, cursor + capW / 2, 0, "X", fill, shadow);
      cursor += capW;

      // ")"
      ctx.font = parenFont;
      ctx.fillStyle = fill;
      ctx.shadowColor = shadow;
      ctx.shadowBlur = 14;
      ctx.fillText(")", cursor, 0);
      ctx.restore();
    },
  };
};
