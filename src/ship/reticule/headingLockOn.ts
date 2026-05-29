import type { Ship } from "../../Ship";
import { TAU } from "../../vec";
import {
  ConeFrame, computeConeFrame, toroidalDelta,
  targetIsInsideCone, clipRayToCone,
} from "./coneGeometry";
import { ReticuleTarget } from "./trajectoryPreview";

// Why: when the player sweeps the ship and the reticule would jump from one side of a target's
// trajectory line to the other in a single frame, snap the heading so the reticule lands ON the
// line. Lets the player fine-aim along a moving target's path without overshooting it. The lock is
// soft — held rotation past ESCAPE_THRESHOLD releases past the line.

// Why: max accumulated intended rotation (radians) before the lock releases. ~10° → roughly 2–3
// frames of held input at the ship's max turn rate (4.6 rad/s) before breaking free.
const LOCK_ESCAPE_THRESHOLD = 0.17;

// Why: matches the geometry of `paintTrajectoryFromSnapshot` — the trajectory line is drawn
// starting `(radius + edgePad)` ahead of the target body along its velocity vector.
const TRAJECTORY_EDGE_PAD = 6;

// Why: the primary reticule (the one used for the on-rhythm lock) is computed at beatFraction=1.
const PRIMARY_BEAT_FRACTION = 1;

export type HeadingLock = {
  // Which target's line we snapped to. Strong reference — released when the target is no longer
  // in the cone or the line no longer passes near the reticule.
  target: object;
  // The heading where the reticule sits exactly on the line.
  heading: number;
  // Signed accumulated rotation intent past the snap heading (rad). Releases when |this| exceeds
  // LOCK_ESCAPE_THRESHOLD.
  pendingExcess: number;
};

// Reticule geometry: P(θ) = C + R * (cos θ, sin θ).
// C carries the velocity-leading term (independent of heading); R is the muzzle+travel reach.
const reticuleCircle = (ship: Ship, beatGrid: number) => {
  const lead = 0.4 * beatGrid * PRIMARY_BEAT_FRACTION;
  return {
    cx: ship.pos.x + ship.vel.x * lead,
    cy: ship.pos.y + ship.vel.y * lead,
    R: (ship.radius + 4) + ship.bulletSpeed * beatGrid * PRIMARY_BEAT_FRACTION,
  };
};

type TrajectoryLine = {
  target: ReticuleTarget;
  // Line origin in ship-local coords (start of the visible trajectory ray, just past the target body).
  sx: number;
  sy: number;
  // Unit velocity direction.
  ux: number;
  uy: number;
  // Visible ray parameter range along (ux, uy) from (sx, sy).
  sMin: number;
  sMax: number;
};

// Gather visible trajectory lines, in ship-local coordinates so the lock math doesn't have to
// worry about world wrap. Mirrors the cone-membership rule from paintTrajectoryPreviews so we
// only snap to lines the player can actually see.
const collectTrajectoryLines = (
  ship: Ship, frame: ConeFrame, w: number, h: number,
  targets: ReadonlyArray<ReticuleTarget>,
): TrajectoryLine[] => {
  const lines: TrajectoryLine[] = [];
  for (const t of targets) {
    const speed = Math.hypot(t.vel.x, t.vel.y);
    if (speed < 1) continue;
    const [dx, dy] = toroidalDelta(t.pos.x - ship.pos.x, t.pos.y - ship.pos.y, w, h);
    const tr = t.radius ?? 0;
    const ux = t.vel.x / speed;
    const uy = t.vel.y / speed;
    const rsx = dx + ux * (tr + TRAJECTORY_EDGE_PAD);
    const rsy = dy + uy * (tr + TRAJECTORY_EDGE_PAD);
    const targetInCone = targetIsInsideCone(dx, dy, tr, frame);
    let sMin: number;
    let sMax: number;
    if (targetInCone) {
      sMin = -(tr + TRAJECTORY_EDGE_PAD);
      sMax = frame.length;
    } else {
      const clip = clipRayToCone(rsx, rsy, ux, uy, frame);
      if (clip.sMax <= clip.sMin) continue;
      sMin = clip.sMin;
      sMax = clip.sMax;
    }
    lines.push({ target: t, sx: rsx, sy: rsy, ux, uy, sMin, sMax });
  }
  return lines;
};

// Signed perpendicular distance from a point (px, py) to the line through (sx, sy) along (ux, uy).
const perpDistance = (px: number, py: number, line: TrajectoryLine): number =>
  -line.uy * (px - line.sx) + line.ux * (py - line.sy);

// Reticule position at heading θ, in ship-local coords (origin = ship.pos).
const reticuleAt = (
  theta: number, R: number, leadX: number, leadY: number,
): { x: number; y: number } => ({
  x: leadX + R * Math.cos(theta),
  y: leadY + R * Math.sin(theta),
});

// Solve for the heading that places the reticule exactly on the trajectory line.
// Geometry: P(θ) = (leadX, leadY) + R*(cos θ, sin θ). On the line ⇒ perp(P(θ)) = 0.
// Reduces to sin(θ - α) = -K/R, where α = atan2(uy, ux) and K is the line-relative offset of the
// circle center. Returns the solution(s) in (-π, π], or empty array if the circle misses the line.
const headingsOnLine = (
  line: TrajectoryLine, leadX: number, leadY: number, R: number,
): number[] => {
  if (R <= 0) return [];
  const K = -line.uy * (leadX - line.sx) + line.ux * (leadY - line.sy);
  const rhs = -K / R;
  if (rhs > 1 || rhs < -1) return [];
  const alpha = Math.atan2(line.uy, line.ux);
  const base = Math.asin(Math.max(-1, Math.min(1, rhs)));
  return [normalizeAngle(alpha + base), normalizeAngle(alpha + Math.PI - base)];
};

// Wrap angle to (-π, π].
const normalizeAngle = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= TAU;
  while (x <= -Math.PI) x += TAU;
  return x;
};

// Signed angular distance from a to b in (-π, π] — i.e. how much you'd rotate (with sign) to go a→b.
const angularDelta = (from: number, to: number): number => normalizeAngle(to - from);

// Check that the reticule, sitting exactly on the line at the snap heading, projects inside the
// visible segment [sMin, sMax]. Prevents snapping to invisible extensions of the line behind the
// target or beyond the cone.
const snapPointOnVisibleSegment = (
  line: TrajectoryLine, snapTheta: number, R: number, leadX: number, leadY: number,
): boolean => {
  const p = reticuleAt(snapTheta, R, leadX, leadY);
  const s = (p.x - line.sx) * line.ux + (p.y - line.sy) * line.uy;
  return s >= line.sMin && s <= line.sMax;
};

// Find the line (if any) crossed when rotating from θ0 to θ1, and the heading at which the
// reticule sits on that line. If multiple lines are crossed, pick the one crossed first (smallest
// fraction of the rotation arc).
type Crossing = { line: TrajectoryLine; snapHeading: number };
const findCrossing = (
  lines: ReadonlyArray<TrajectoryLine>, theta0: number, theta1: number,
  leadX: number, leadY: number, R: number,
): Crossing | null => {
  const fullDelta = angularDelta(theta0, theta1);
  if (Math.abs(fullDelta) < 1e-9) return null;
  let best: Crossing | null = null;
  let bestFrac = Infinity;
  for (const line of lines) {
    const p0 = reticuleAt(theta0, R, leadX, leadY);
    const p1 = reticuleAt(theta1, R, leadX, leadY);
    const d0 = perpDistance(p0.x, p0.y, line);
    const d1 = perpDistance(p1.x, p1.y, line);
    // Only count a "crossing" when the sign genuinely flips (zero crossings are picked up by either
    // boundary — small epsilon avoids snapping when the reticule is already on the line).
    if (d0 === 0 || d1 === 0) continue;
    if ((d0 > 0) === (d1 > 0)) continue;
    // Pick the analytic solution whose angular position is between θ0 and θ1 along the rotation
    // direction, and nearest to θ0 (the first crossing the sweep hits).
    const candidates = headingsOnLine(line, leadX, leadY, R);
    let snapHeading: number | null = null;
    let snapFrac = Infinity;
    for (const c of candidates) {
      const delta = angularDelta(theta0, c);
      // Must move in the same rotation direction as the player's intent…
      if (Math.sign(delta) !== Math.sign(fullDelta)) continue;
      // …and be reached before the full rotation completes.
      if (Math.abs(delta) > Math.abs(fullDelta)) continue;
      const frac = Math.abs(delta) / Math.abs(fullDelta);
      if (frac < snapFrac) { snapFrac = frac; snapHeading = c; }
    }
    if (snapHeading === null) continue;
    if (!snapPointOnVisibleSegment(line, snapHeading, R, leadX, leadY)) continue;
    if (snapFrac < bestFrac) { bestFrac = snapFrac; best = { line, snapHeading }; }
  }
  return best;
};

// Re-derive the lock's snap heading against the current line, since both the target and the ship
// move every frame. Picks the analytic intersection closest to the previously-stored heading so
// the lock tracks the line smoothly instead of jumping to the opposite intersection on the circle.
// Returns the refreshed line + heading, or null if the lock should release (target gone, circle no
// longer meets the line, or snap point exited the visible segment).
const refreshLock = (
  lock: HeadingLock, lines: ReadonlyArray<TrajectoryLine>,
  leadX: number, leadY: number, R: number,
): { line: TrajectoryLine; heading: number } | null => {
  const line = lines.find((l) => (l.target as unknown as object) === lock.target);
  if (!line) return null;
  const candidates = headingsOnLine(line, leadX, leadY, R);
  if (candidates.length === 0) return null;
  let bestHeading: number | null = null;
  let bestDelta = Infinity;
  for (const c of candidates) {
    if (!snapPointOnVisibleSegment(line, c, R, leadX, leadY)) continue;
    const delta = Math.abs(angularDelta(lock.heading, c));
    if (delta < bestDelta) { bestDelta = delta; bestHeading = c; }
  }
  if (bestHeading === null) return null;
  return { line, heading: bestHeading };
};

export type HeadingLockResult = {
  heading: number;
  lock: HeadingLock | null;
};

// Compute the next heading given the player's intended rotation, applying trajectory-line snap.
// `intendedDelta` is the signed angle the player wants to rotate this frame (positive = clockwise
// in screen coords, matching ship.heading's convention). `prevLock` carries lock state across frames.
export const resolveHeadingWithLock = (
  ship: Ship, intendedDelta: number, beatGrid: number,
  w: number, h: number, targets: ReadonlyArray<ReticuleTarget>,
  prevLock: HeadingLock | null,
): HeadingLockResult => {
  const frame = computeConeFrame(ship);
  const lines = collectTrajectoryLines(ship, frame, w, h, targets);
  const { cx, cy, R } = reticuleCircle(ship, beatGrid);
  const leadX = cx - ship.pos.x;
  const leadY = cy - ship.pos.y;

  // Re-validate an existing lock first. If still valid and the player hasn't exceeded escape
  // pressure, keep the heading pinned to the refreshed snap (which tracks the moving target).
  if (prevLock) {
    const refreshed = refreshLock(prevLock, lines, leadX, leadY, R);
    if (refreshed) {
      const nextExcess = prevLock.pendingExcess + intendedDelta;
      if (Math.abs(nextExcess) <= LOCK_ESCAPE_THRESHOLD) {
        return {
          heading: refreshed.heading,
          lock: { target: prevLock.target, heading: refreshed.heading, pendingExcess: nextExcess },
        };
      }
      // Escape: release the lock and apply the residual rotation past the snap.
      return { heading: refreshed.heading + nextExcess, lock: null };
    }
  }

  // No active lock (or it just released): look for a fresh crossing.
  const theta0 = ship.heading;
  const theta1 = ship.heading + intendedDelta;
  const crossing = findCrossing(lines, theta0, theta1, leadX, leadY, R);
  if (!crossing) return { heading: theta1, lock: null };
  return {
    heading: crossing.snapHeading,
    lock: {
      target: crossing.line.target as unknown as object,
      heading: crossing.snapHeading,
      pendingExcess: 0,
    },
  };
};
