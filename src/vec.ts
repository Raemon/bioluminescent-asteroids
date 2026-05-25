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

export const TAU = Math.PI * 2;

export const rand = (min: number, max: number): number => min + Math.random() * (max - min);
export const randInt = (min: number, max: number): number => Math.floor(rand(min, max + 1));
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
