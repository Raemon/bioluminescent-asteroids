// Shared 3D-octahedron tumble used by pickup pods (Canister) and gold gems
// (Gem). Both project the same six-vertex octahedron through three
// rotation axes and stroke the same 12 wireframe edges; only the surface
// styling (tint, facet fills, line width) differs per kind, so this module
// owns the geometry and each caller owns its own drawing.

export type OctaVert = { x: number; y: number; z: number };

// Each "equator" vertex (±x, ±y) connects to both "poles" (±z) — 12 edges,
// enough wireframe to read as a solid tumbling shape without becoming noise.
export const OCTAHEDRON_EDGES: ReadonlyArray<[number, number]> = [
  [0, 2], [0, 3], [0, 4], [0, 5],
  [1, 2], [1, 3], [1, 4], [1, 5],
  [2, 4], [2, 5], [3, 4], [3, 5],
];

// Rotate the six octahedron vertices (radius r) around X, Y, then Z and
// project orthographically. Returned z is kept for depth fade / backface cull.
export function projectOctahedron(rotX: number, rotY: number, rotZ: number, r: number): OctaVert[] {
  const verts: [number, number, number][] = [
    [r, 0, 0],
    [-r, 0, 0],
    [0, r, 0],
    [0, -r, 0],
    [0, 0, r],
    [0, 0, -r],
  ];
  const cx = Math.cos(rotX), sx = Math.sin(rotX);
  const cy = Math.cos(rotY), sy = Math.sin(rotY);
  const cz = Math.cos(rotZ), sz = Math.sin(rotZ);
  return verts.map(([x, y, z]) => {
    const y1 = y * cx - z * sx;
    const z1 = y * sx + z * cx;
    const x2 = x * cy + z1 * sy;
    const z2 = -x * sy + z1 * cy;
    const x3 = x2 * cz - y1 * sz;
    const y3 = x2 * sz + y1 * cz;
    return { x: x3, y: y3, z: z2 };
  });
}
