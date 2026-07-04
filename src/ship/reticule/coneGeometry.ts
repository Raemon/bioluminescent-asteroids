import type { Ship } from "../../Ship";

// base wedge geometry; the radar powerup doubles both at runtime via radarHalfAngle/radarLength.
const RADAR_HALF_ANGLE_BASE = 0.6;
const RADAR_LENGTH_BASE = 700;
const RADAR_BOOST = 2;

// every wedge consumer reads from the ship so the radar powerup widens & extends the cone everywhere at once.
export const radarHalfAngle = (ship: Ship): number =>
  ship.radarActive ? RADAR_HALF_ANGLE_BASE * RADAR_BOOST : RADAR_HALF_ANGLE_BASE;
export const radarLength = (ship: Ship): number =>
  ship.radarActive ? RADAR_LENGTH_BASE * RADAR_BOOST : RADAR_LENGTH_BASE;

// cone-side outward normals enable signed-distance tests for "inside the cone".
// halfAngle/length travel with the frame so downstream clipping uses the same wedge the renderer drew.
export type ConeFrame = {
  axisX: number;
  axisY: number;
  leftNx: number;
  leftNy: number;
  rightNx: number;
  rightNy: number;
  halfAngle: number;
  length: number;
};

// precompute the cone's axis + side-edge outward normals once per frame instead of per target.
export const computeConeFrame = (ship: Ship): ConeFrame => {
  const half = radarHalfAngle(ship);
  return {
    axisX: Math.cos(ship.heading),
    axisY: Math.sin(ship.heading),
    leftNx: Math.sin(ship.heading - half),
    leftNy: -Math.cos(ship.heading - half),
    rightNx: -Math.sin(ship.heading + half),
    rightNy: Math.cos(ship.heading + half),
    halfAngle: half,
    length: radarLength(ship),
  };
};

// screen-wrap means the closest "image" of a target may be on the other side; pick the nearest.
export { toroidalDelta } from "../../vec";

// a target's silhouette overlaps the cone if forward and either side-normal sit within tr of the wedge.
export const targetIsInsideCone = (
  dx: number, dy: number, tr: number, frame: ConeFrame,
): boolean => {
  const forward = dx * frame.axisX + dy * frame.axisY;
  if (forward < -tr || forward > frame.length + tr) return false;
  const leftSigned = dx * frame.leftNx + dy * frame.leftNy;
  const rightSigned = dx * frame.rightNx + dy * frame.rightNy;
  return !(leftSigned > tr || rightSigned > tr);
};

// ray is clipped to the cone half-planes so the trajectory preview never spills outside the wedge.
export type RayClip = { sMin: number; sMax: number };

// solving each half-plane gives a 1-sided constraint; intersect all four to get the visible segment.
export const clipRayToCone = (
  rsx: number, rsy: number, ux: number, uy: number, frame: ConeFrame,
): RayClip => {
  const r: RayClip = { sMin: 0, sMax: Infinity };
  clipAgainst(r, -frame.axisX, -frame.axisY, 0, rsx, rsy, ux, uy);
  clipAgainst(r, frame.axisX, frame.axisY, frame.length, rsx, rsy, ux, uy);
  clipAgainst(r, frame.leftNx, frame.leftNy, 0, rsx, rsy, ux, uy);
  clipAgainst(r, frame.rightNx, frame.rightNy, 0, rsx, rsy, ux, uy);
  return r;
};

// n·(P-apex) ≤ d. Parallel rays violate "all-or-nothing"; otherwise we shrink sMin or sMax.
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
