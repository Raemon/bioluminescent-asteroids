export type Vec = { x: number; y: number };

export const v = (x: number, y: number): Vec => ({ x, y });

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec): number => Math.hypot(a.x, a.y);

export const fromAngle = (theta: number, mag = 1): Vec => ({
  x: Math.cos(theta) * mag,
  y: Math.sin(theta) * mag,
});

export const wrap = (a: Vec, w: number, h: number): Vec => ({
  x: ((a.x % w) + w) % w,
  y: ((a.y % h) + h) % h,
});

export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

// Mutating variants — for per-frame hot paths (entity update loops, particles)
// where the functional helpers' fresh {x,y} object per call dominates GC.
// `addScaledMut(a, b, s)` does `a += b * s`. `addMut(a, b)` does `a += b`.
// `scaleMut(a, s)` does `a *= s`. `wrapMut(a, w, h)` wraps `a` in place.
export const addMut = (a: Vec, b: Vec): void => { a.x += b.x; a.y += b.y; };
export const addScaledMut = (a: Vec, b: Vec, s: number): void => {
  a.x += b.x * s;
  a.y += b.y * s;
};
export const scaleMut = (a: Vec, s: number): void => { a.x *= s; a.y *= s; };
export const wrapMut = (a: Vec, w: number, h: number): void => {
  a.x = ((a.x % w) + w) % w;
  a.y = ((a.y % h) + h) % h;
};

export const TAU = Math.PI * 2;

import { rng } from "./game/rng";

export const rand = (min: number, max: number): number => min + rng() * (max - min);
export const randInt = (min: number, max: number): number => Math.floor(rand(min, max + 1));
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
