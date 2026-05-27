import type { Ship } from "../../Ship";

// Why: the radar cone is a wedge that fans forward from the ship; everything else needs its angle.
export const RADAR_HALF_ANGLE = 0.60;
export const RADAR_LENGTH = 800;

// Why: cone-side outward normals enable signed-distance tests for "inside the cone".
export type ConeFrame = {
  axisX: number;
  axisY: number;
  leftNx: number;
  leftNy: number;
  rightNx: number;
  rightNy: number;
};

// Why: precompute the cone's axis + side-edge outward normals once per frame instead of per target.
export const computeConeFrame = (ship: Ship): ConeFrame => ({
  axisX: Math.cos(ship.heading),
  axisY: Math.sin(ship.heading),
  leftNx: Math.sin(ship.heading - RADAR_HALF_ANGLE),
  leftNy: -Math.cos(ship.heading - RADAR_HALF_ANGLE),
  rightNx: -Math.sin(ship.heading + RADAR_HALF_ANGLE),
  rightNy: Math.cos(ship.heading + RADAR_HALF_ANGLE),
});

// Why: screen-wrap means the closest "image" of a target may be on the other side; pick the nearest.
export const toroidalDelta = (dx: number, dy: number, w: number, h: number): [number, number] => {
  if (dx > w / 2) dx -= w;
  else if (dx < -w / 2) dx += w;
  if (dy > h / 2) dy -= h;
  else if (dy < -h / 2) dy += h;
  return [dx, dy];
};

// Why: a target's silhouette overlaps the cone if forward and either side-normal sit within tr of the wedge.
export const targetIsInsideCone = (
  dx: number, dy: number, tr: number, frame: ConeFrame,
): boolean => {
  const forward = dx * frame.axisX + dy * frame.axisY;
  if (forward < -tr || forward > RADAR_LENGTH + tr) return false;
  const leftSigned = dx * frame.leftNx + dy * frame.leftNy;
  const rightSigned = dx * frame.rightNx + dy * frame.rightNy;
  return !(leftSigned > tr || rightSigned > tr);
};

// Why: ray is clipped to the cone half-planes so the trajectory preview never spills outside the wedge.
export type RayClip = { sMin: number; sMax: number };

// Why: solving each half-plane gives a 1-sided constraint; intersect all four to get the visible segment.
export const clipRayToCone = (
  rsx: number, rsy: number, ux: number, uy: number, frame: ConeFrame,
): RayClip => {
  const r: RayClip = { sMin: 0, sMax: Infinity };
  clipAgainst(r, -frame.axisX, -frame.axisY, 0, rsx, rsy, ux, uy);
  clipAgainst(r, frame.axisX, frame.axisY, RADAR_LENGTH, rsx, rsy, ux, uy);
  clipAgainst(r, frame.leftNx, frame.leftNy, 0, rsx, rsy, ux, uy);
  clipAgainst(r, frame.rightNx, frame.rightNy, 0, rsx, rsy, ux, uy);
  return r;
};

// Why: n·(P-apex) ≤ d. Parallel rays violate "all-or-nothing"; otherwise we shrink sMin or sMax.
const clipAgainst = (
  r: RayClip, nx: number, ny: number, d: number,
  rsx: number, rsy: number, ux: number, uy: number,
) => {
  const num = d - (nx * rsx + ny * rsy);
  const den = nx * ux + ny * uy;
  if (Math.abs(den) < 1e-9) { if (num < 0) r.sMax = -1; return; }
  const sBound = num / den;
  if (den > 0) { if (sBound < r.sMax) r.sMax = sBound; }
  else { if (sBound > r.sMin) r.sMin = sBound; }
};
