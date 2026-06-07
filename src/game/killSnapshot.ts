import { v } from "../vec";
import { SoundName } from "../Sound";
import { Asteroid } from "../Asteroid";
import { Alien } from "../Alien";
import { Comet } from "../Comet";
import { Ship } from "../Ship";

// post-mission parade replays every kill at full size with the original kill sound.
//   `bassDrone` is set for bassteroid kills whose voice has a longrunning drone
//   (medium/small only — large bass doesn't get one), so the parade can layer the
//   continuous bed under the beat sound just like during play.
// `rhythmHit` captures the on-beat reward at kill time so the parade can replay it.
//   combo is the multiplier at the moment of the kill — drives playComboChime pitch.
export type KilledSnapshot = {
  full: HTMLCanvasElement;
  fullRadius: number;
  killSound: SoundName;
  maxHp: number;
  scoreEarned: number;
  bassDrone?: { kind: "bassA" | "bassB" | "bassC" | "bassD"; size: "medium" | "small" };
  rhythmHit?: { combo: number };
};

// one canvas-creation + translate ritual for all three kill flavours; caller owns the freeze.
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

// trophy must be a still pose, not mid-explosion brightness — freeze rotation + flashes.
// asteroid sprites bake a halo extending to ~2.3×radius + 14px padding (see buildSprite),
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

// aliens carry fireFlash on top of flashAmount; both must clear for a still pose.
// alien halo gradient extends to ~2.2×radius from centre even with fireFlash zeroed (see
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

// comet bloom bleeds far past its radius; tile sizes to fit both the head halo and the
//   recorded trail (rebased to (0,0)) so the parade replay shows the streak behind the head.
//   `age` is forced past FADE_IN so the still pose is at full brightness rather than fading in.
export const snapshotCometKill = (c: Comet, killSound: SoundName, scoreEarned: number): KilledSnapshot | null => {
  const margin = 12;
  const headExtent = c.radius * 2 + margin;
  // trail entries are world-space; rebase them to the comet head at (0,0) so the snapshot
  //   can paint the trail relative to the centred head. Clone so we don't mutate the live comet.
  const rebasedTrail = c.trail.map((p) => ({ pos: v(p.pos.x - c.pos.x, p.pos.y - c.pos.y), age: p.age }));
  let trailExtent = 0;
  for (const p of rebasedTrail) {
    trailExtent = Math.max(trailExtent, Math.abs(p.pos.x), Math.abs(p.pos.y));
  }
  const halfExtent = Math.max(headExtent, trailExtent + margin);
  const tile = Math.ceil(halfExtent * 2);
  const cnv = captureToCanvas(tile, (cx) => {
    const prevPos = c.pos, prevTrail = c.trail, prevAge = c.age;
    c.pos = v(0, 0); c.trail = rebasedTrail; c.age = Comet.FADE_IN + 0.1;
    c.render(cx);
    c.pos = prevPos; c.trail = prevTrail; c.age = prevAge;
  });
  if (!cnv) return null;
  // maxHp=4 paces the parade as one beat of breathing room after the comet sprite.
  return { full: cnv, fullRadius: c.radius, killSound, maxHp: 4, scoreEarned };
};

// tile fits the shield ring + ~28px shadowBlur halo with margin to spare.
// renderShipBody bails on !alive, so flip the flag inside the freeze.
export const snapshotShipKill = (ship: Ship, killSound: SoundName): KilledSnapshot | null => {
  const ringExtent = ship.radius * 1.4 + ship.haloOffset + ship.shieldRingOffset;
  const tile = Math.ceil((ringExtent + 36) * 2);
  const cnv = captureToCanvas(tile, (cx) => {
    const prevPos = ship.pos, prevAlive = ship.alive;
    const prevThrust = ship.thrustOn, prevReverse = ship.reverseThrustOn;
    const prevPort = ship.portThrustOn, prevStarboard = ship.starboardThrustOn;
    const prevInvuln = ship.invuln;
    ship.pos = v(0, 0);
    ship.alive = true;
    ship.thrustOn = false;
    ship.reverseThrustOn = false;
    ship.portThrustOn = false;
    ship.starboardThrustOn = false;
    ship.invuln = 0;
    ship.render(cx, 0, 0);
    ship.pos = prevPos;
    ship.alive = prevAlive;
    ship.thrustOn = prevThrust;
    ship.reverseThrustOn = prevReverse;
    ship.portThrustOn = prevPort;
    ship.starboardThrustOn = prevStarboard;
    ship.invuln = prevInvuln;
  });
  if (!cnv) return null;
  return { full: cnv, fullRadius: ship.radius, killSound, maxHp: 4, scoreEarned: 0 };
};
