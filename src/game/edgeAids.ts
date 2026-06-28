import type { Game } from "../Game";

// Edge-of-map legibility prototypes, A/B-switched live with number keys 1-4.
//
// The arena is a 1920x1080 torus: the ship and most threats wrap. Near a
// boundary it's hard to tell where you are and what's about to wrap in. These
// prototypes re-frame the WHOLE scene to make the edges legible. They're
// mutually exclusive so we can feel which one is best.
//
//   1  off       baseline — the scene paints straight, no tiling
//   2  tiled2x2  the whole screen shown 4 times (2x2 grid at half scale), so
//                you always see yourself mid-quadrant in an adjacent copy
//   3  scroll    the ship is locked to screen center; the world (stars + wrapped
//                entities) scrolls around it, so you're never at a hard edge
//   4  tiled3x3  a 3x3 grid where the center fills ~95% of the screen and the
//                surrounding 8 copies peek in as thin, darkened silhouette
//                slivers at the edges — context without competing with the field
//
// Architecture: all three tiled modes share one primitive — snapshot the full
// scene once to an offscreen canvas (so background parallax is captured for
// free and we pay ~1 extra full draw, not 4x/9x), then composite that snapshot
// into tiles. The torus wraps exactly at the screen edge, so the snapshot tiled
// edge-to-edge is seamless. renderEdgeAidsTiled() owns the scene render for
// these modes and returns true; for "off" it returns false and renderGame
// paints the scene the normal way.

export type EdgeAidMode = "off" | "tiled2x2" | "scroll" | "tiled3x3";

// Index order matches number keys 1..4.
export const EDGE_AID_MODES: EdgeAidMode[] = ["off", "tiled2x2", "scroll", "tiled3x3"];

// renderGame hands us its scene painter so we can run it into an offscreen
// canvas. It paints the full world at the current transform; shakeX/shakeY are
// the cosmetic shake offsets (we snapshot WITHOUT shake — tiles add their own
// transforms — by passing 0,0).
export type PaintScene = (game: Game, shakeX: number, shakeY: number, forSnapshot?: boolean) => void;

// Redraw the ship on top of the composited tiles: the snapshot bakes it in
// cropped at the world edge. paintShip draws it whole at (ox,oy) + scale*ship.pos.
export type LandmarkPainters = {
  paintShip: (game: Game, ox: number, oy: number, scale: number) => void;
};

// Offscreen scene buffer, sized to the canvas backing store and reused frame to
// frame. Its context is dpr-scaled so paintScene draws in the same logical
// 1920x1080 space as the main context.
let sceneCanvas: HTMLCanvasElement | null = null;
let sceneCtx: CanvasRenderingContext2D | null = null;
let sceneDpr = 0;
let sceneW = 0;
let sceneH = 0;

// Render the scene once into the offscreen buffer and return it. The buffer is
// in backing-store pixels; blit it with drawImage(buf, 0,0, w,h) to map it back
// to logical space.
const snapshotScene = (game: Game, paint: PaintScene): HTMLCanvasElement => {
  const bw = Math.max(1, Math.round(game.w * game.dpr));
  const bh = Math.max(1, Math.round(game.h * game.dpr));
  if (!sceneCanvas || sceneW !== bw || sceneH !== bh) {
    sceneCanvas = sceneCanvas ?? document.createElement("canvas");
    sceneCanvas.width = bw;
    sceneCanvas.height = bh;
    sceneCtx = sceneCanvas.getContext("2d");
    sceneW = bw;
    sceneH = bh;
    sceneDpr = 0; // force the transform reset below
  }
  const sctx = sceneCtx!;
  if (sceneDpr !== game.dpr) {
    sceneDpr = game.dpr;
  }
  sctx.setTransform(game.dpr, 0, 0, game.dpr, 0, 0);
  // paintScene reads game.ctx, so temporarily point the game at the offscreen.
  // forSnapshot=true wraps every body so tiles join seamlessly.
  const realCtx = game.ctx;
  game.ctx = sctx;
  paint(game, 0, 0, true);
  game.ctx = realCtx;
  return sceneCanvas;
};

// Returns true if it handled the whole scene render (tiled modes); false for
// "off" so renderGame paints normally.
export const renderEdgeAidsTiled = (
  game: Game, paint: PaintScene, landmarks: LandmarkPainters,
): boolean => {
  switch (game.edgeAidMode) {
    case "tiled2x2":
      drawTiled2x2(game, paint, landmarks);
      return true;
    case "scroll":
      drawScroll(game, paint, landmarks);
      return true;
    case "tiled3x3":
      drawTiled3x3(game, paint);
      return true;
    default:
      return false;
  }
};

// ── Per-mode implementations (filled in independently) ───────────────────────
// Each gets the offscreen snapshot via snapshotScene(game, paint) and composites
// it onto the main context (game.ctx, dpr-scaled, logical 1920x1080 space).
// Blit the whole snapshot to a logical rect with:
//   ctx.drawImage(snap, 0, 0, snap.width, snap.height, dx, dy, dw, dh)

// Blit the whole snapshot to a logical-space rect [dx,dy,dw,dh].
const blit = (
  ctx: CanvasRenderingContext2D, snap: HTMLCanvasElement,
  dx: number, dy: number, dw: number, dh: number,
) => {
  ctx.drawImage(snap, 0, 0, snap.width, snap.height, dx, dy, dw, dh);
};

const drawTiled2x2 = (game: Game, paint: PaintScene, landmarks: LandmarkPainters) => {
  const snap = snapshotScene(game, paint);
  const { ctx, w, h } = game;
  const hw = w / 2;
  const hh = h / 2;
  blit(ctx, snap, 0, 0, hw, hh);
  blit(ctx, snap, hw, 0, hw, hh);
  blit(ctx, snap, 0, hh, hw, hh);
  blit(ctx, snap, hw, hh, hw, hh);
  // Redraw the ship whole in each quadrant — the snapshot crops it at the world
  // edge, so a half-scale ship lands uncropped at qOffset + 0.5*ship.pos.
  for (const qx of [0, hw]) {
    for (const qy of [0, hh]) landmarks.paintShip(game, qx, qy, 0.5);
  }
  // Thin divider lines so the 2x2 structure reads at a glance.
  ctx.save();
  ctx.strokeStyle = "hsla(192, 80%, 78%, 0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hw, 0);
  ctx.lineTo(hw, h);
  ctx.moveTo(0, hh);
  ctx.lineTo(w, hh);
  ctx.stroke();
  ctx.restore();
};

const drawScroll = (game: Game, paint: PaintScene, landmarks: LandmarkPainters) => {
  const snap = snapshotScene(game, paint);
  const { ctx, w, h } = game;
  // Shift the world so the ship's real position lands at screen center.
  const cox = w / 2 - game.ship.pos.x;
  const coy = h / 2 - game.ship.pos.y;
  // Normalize each offset into (-w,0] / (-h,0], then tile 3 copies forward so
  // the span [ox, ox+3w) fully covers [0,w) for any ship position.
  let ox = cox % w;
  if (ox > 0) ox -= w;
  let oy = coy % h;
  if (oy > 0) oy -= h;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      blit(ctx, snap, ox + i * w, oy + j * h, w, h);
    }
  }
  // The pulsar lives in the snapshot, so it scrolls + wraps with the field as a
  // world-anchored landmark — no separate overlay (that would pin it to screen).
  // Only the ship is redrawn, whole at exact center (the snapshot crops it).
  landmarks.paintShip(game, cox, coy, 1);
};

// Center copy fills this fraction of the screen; the rest is the sliver border.
const TILED3X3_CENTER_SCALE = 0.9;

const drawTiled3x3 = (game: Game, paint: PaintScene) => {
  const snap = snapshotScene(game, paint);
  const { ctx, w, h } = game;
  const s = TILED3X3_CENTER_SCALE;
  const sw = s * w;
  const sh = s * h;
  const cx = w / 2 - sw / 2;
  const cy = h / 2 - sh / 2;

  // Neighbors first, clipped to the screen and washed dark so they read as
  // silhouette echoes; the bright center drawn last covers all but the slivers.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = cx + dx * sw;
      const ny = cy + dy * sh;
      blit(ctx, snap, nx, ny, sw, sh);
      ctx.fillStyle = "rgba(2, 3, 10, 0.62)";
      ctx.fillRect(nx, ny, sw, sh);
    }
  }
  ctx.restore();

  blit(ctx, snap, cx, cy, sw, sh);

  // Faint inner-edge line where the bright center meets the dim slivers.
  ctx.save();
  ctx.strokeStyle = "hsla(192, 80%, 78%, 0.22)";
  ctx.lineWidth = 1;
  ctx.strokeRect(cx, cy, sw, sh);
  ctx.restore();
};

// ── Always-on mode label ─────────────────────────────────────────────────────
const MODE_LABEL: Record<EdgeAidMode, string> = {
  off: "1 · off (baseline)",
  tiled2x2: "2 · 2x2 tiled",
  scroll: "3 · locked-center scroll",
  tiled3x3: "4 · 3x3 silhouette edges",
};
export const renderEdgeAidLabel = (game: Game) => {
  const { ctx, w } = game;
  ctx.save();
  ctx.font = "600 16px 'Space Grotesk', system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "hsla(192, 80%, 78%, 0.55)";
  ctx.fillText(`edge aid  ${MODE_LABEL[game.edgeAidMode]}`, w - 24, 80);
  ctx.restore();
};
