import type { Ship } from "../Ship";

// collisions test the visible halo outline, not a bounding circle, so the outline IS the hitbox.
export const haloVertices = (ship: Ship): Array<[number, number]> => {
  const hull: Array<[number, number]> = [
    [Math.cos(ship.heading) * ship.radius * 1.4, Math.sin(ship.heading) * ship.radius * 1.4],
    [Math.cos(ship.heading + Math.PI * 0.78) * ship.radius * 1.0, Math.sin(ship.heading + Math.PI * 0.78) * ship.radius * 1.0],
    [Math.cos(ship.heading - Math.PI * 0.78) * ship.radius * 1.0, Math.sin(ship.heading - Math.PI * 0.78) * ship.radius * 1.0],
  ];
  const s = polygonOutwardSign(hull);
  const halo: Array<[number, number]> = [];
  for (let k = 0; k < 3; k++) halo.push(miterVertex(hull, k, s, ship.haloOffset));
  return halo;
};

// hull winding direction varies with heading; we need it to pick the "outward" normal sign.
const polygonOutwardSign = (hull: Array<[number, number]>): number => {
  const cross =
    (hull[1][0] - hull[0][0]) * (hull[2][1] - hull[0][1]) -
    (hull[1][1] - hull[0][1]) * (hull[2][0] - hull[0][0]);
  return cross < 0 ? 1 : -1;
};

// pushing each vertex along its bisector keeps the offset edges perpendicular to the hull edges.
const miterVertex = (hull: Array<[number, number]>, k: number, s: number, offset: number): [number, number] => {
  const prev = hull[(k + 2) % 3];
  const curr = hull[k];
  const next = hull[(k + 1) % 3];
  const e1x = curr[0] - prev[0], e1y = curr[1] - prev[1];
  const e2x = next[0] - curr[0], e2y = next[1] - curr[1];
  let n1x = s * -e1y, n1y = s * e1x;
  let n2x = s * -e2y, n2y = s * e2x;
  const l1 = Math.hypot(n1x, n1y) || 1;
  const l2 = Math.hypot(n2x, n2y) || 1;
  n1x /= l1; n1y /= l1;
  n2x /= l2; n2y /= l2;
  let bx = n1x + n2x, by = n1y + n2y;
  const bl = Math.hypot(bx, by) || 1;
  bx /= bl; by /= bl;
  const dot = bx * n1x + by * n1y;
  const miter = offset / Math.max(0.2, dot);
  return [curr[0] + bx * miter, curr[1] + by * miter];
};

// bullets/asteroids need the exact reach so glancing hits register if they touch the visible outline.
export const hitDistanceToward = (ship: Ship, theta: number): number => {
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);
  const halo = haloVertices(ship);
  const best = closestHaloRayDistance(halo, dx, dy);
  if (!Number.isFinite(best)) return ship.hitRadius;
  // collision-only padding (uniform + forward bonus) bulks the hitbox without moving the outline.
  const forward = Math.max(0, Math.cos(theta - ship.heading));
  return best + ship.hitPad + ship.hitFrontBonus * forward;
};

// ray-vs-segment per halo edge gives the silhouette distance the player sees in that direction.
const closestHaloRayDistance = (halo: Array<[number, number]>, dx: number, dy: number): number => {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const a = halo[k];
    const b = halo[(k + 1) % 3];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const t = (a[0] * ey - a[1] * ex) / denom;
    const u = (a[0] * dy - a[1] * dx) / denom;
    if (t >= 0 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
};
