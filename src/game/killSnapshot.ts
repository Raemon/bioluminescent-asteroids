import { v } from "../vec";
import { SoundName } from "../Sound";
import { Asteroid } from "../Asteroid";
import { Alien } from "../Alien";
import { Comet } from "../Comet";

// Why: post-mission parade replays every kill at full size with the original kill sound.
export type KilledSnapshot = {
  full: HTMLCanvasElement;
  fullRadius: number;
  killSound: SoundName;
  maxHp: number;
  scoreEarned: number;
};

// Why: one canvas-creation + translate ritual for all three kill flavours; caller owns the freeze.
const captureToCanvas = (tileSize: number, paint: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement | null => {
  const c = document.createElement("canvas");
  c.width = tileSize;
  c.height = tileSize;
  const cx = c.getContext("2d");
  if (!cx) return null;
  cx.translate(tileSize / 2, tileSize / 2);
  paint(cx);
  return c;
};

// Why: trophy must be a still pose, not mid-explosion brightness — freeze rotation + flashes.
// Why: asteroid sprites bake a halo extending to ~2.3×radius + 14px padding (see buildSprite),
//   plus an extra margin for any live shadowBlur drawn on top — taking the max of the sprite's
//   own half-size and (radius + margin) ensures the parade tile never crops the halo.
export const snapshotAsteroidKill = (a: Asteroid, killSound: SoundName, scoreEarned: number): KilledSnapshot | null => {
  const margin = 32;
  const halfExtent = Math.max(a.radius + margin, a.spriteHalfSize + margin / 2);
  const tile = Math.ceil(halfExtent * 2);
  const cnv = captureToCanvas(tile, (cx) => {
    const prevPos = a.pos, prevRot = a.rotation, prevFlash = a.flashAmount, prevBeat = a.beatFlash;
    a.pos = v(0, 0); a.rotation = 0; a.flashAmount = 0; a.beatFlash = 0;
    a.render(cx, 0);
    a.pos = prevPos; a.rotation = prevRot; a.flashAmount = prevFlash; a.beatFlash = prevBeat;
  });
  if (!cnv) return null;
  return { full: cnv, fullRadius: a.radius, killSound, maxHp: a.maxHp, scoreEarned };
};

// Why: aliens carry fireFlash on top of flashAmount; both must clear for a still pose.
// Why: alien halo gradient extends to ~2.2×radius from centre even with fireFlash zeroed (see
//   Alien.render), and shadowBlur adds ~12px on top — size the tile so neither is clipped.
export const snapshotAlienKill = (al: Alien, killSound: SoundName, scoreEarned: number): KilledSnapshot | null => {
  const haloExtent = al.radius * 2.2 + 16;
  const tile = Math.ceil(haloExtent * 2);
  const cnv = captureToCanvas(tile, (cx) => {
    const prevPos = al.pos, prevRot = al.rotation, prevFlash = al.flashAmount, prevFire = al.fireFlash;
    al.pos = v(0, 0); al.rotation = 0; al.flashAmount = 0; al.fireFlash = 0;
    al.render(cx, 0);
    al.pos = prevPos; al.rotation = prevRot; al.flashAmount = prevFlash; al.fireFlash = prevFire;
  });
  if (!cnv) return null;
  return { full: cnv, fullRadius: al.radius, killSound, maxHp: al.maxHp, scoreEarned };
};

// Why: comet bloom bleeds far past its radius; 4× tile fits it and `age` is forced past FADE_IN.
export const snapshotCometKill = (c: Comet, killSound: SoundName, scoreEarned: number): KilledSnapshot | null => {
  const margin = 12;
  const tile = Math.ceil(c.radius * 4 + margin * 2);
  const cnv = captureToCanvas(tile, (cx) => {
    const prevPos = c.pos, prevTrail = c.trail, prevAge = c.age;
    c.pos = v(0, 0); c.trail = []; c.age = Comet.FADE_IN + 0.1;
    c.render(cx);
    c.pos = prevPos; c.trail = prevTrail; c.age = prevAge;
  });
  if (!cnv) return null;
  // Why: maxHp=4 paces the parade as one beat of breathing room after the comet sprite.
  return { full: cnv, fullRadius: c.radius, killSound, maxHp: 4, scoreEarned };
};
