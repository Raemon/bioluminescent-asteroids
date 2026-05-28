import { Vec } from "../vec";
import { BEAT_GRID } from "./rhythmConstants";

// Why we exist: asteroids look best when they move on plausible straight-line
// trajectories, but the rhythm/combo system rewards the player for landing
// hits on the beat grid. Adjusting an asteroid's *speed* (and, for splits,
// a few pixels of spawn-position) at spawn time is enough to make the
// moment it crosses the player's natural firing range land on a beat — so
// the player can chain combos by just shooting on the music, without us
// having to be heavy-handed about how each rock moves.
//
// The adjuster also spreads asteroids across *different* beat slots so a
// wave doesn't dump all of its rocks onto the same beat (which would make
// only the first one comboable). Pass the same Set across calls in one
// spawn batch to distribute.

export type BeatClaimSet = Set<number>;
export const newBeatClaimSet = (): BeatClaimSet => new Set();

export type RhythmAdjustOpts = {
  // Reference point we time the encounter against — usually the ship's
  // current position, or the screen centre for long-haul incoming spawns.
  refPos: Vec;
  // Optional reference velocity. When provided, the engagement ring is
  // centred on a *moving* target: refPos + refVel * t_target. Use for
  // splits where the ship may move ~half the ring radius in the 1–2 beat
  // alignment window — without this, an actively-flying player gets
  // debris timed against a stale "ghost" position. For multi-second
  // incoming travel we can't reliably extrapolate ship motion that far,
  // so callers leave this undefined and anchor against a stable refPos
  // (the screen centre).
  refVel?: Vec;
  // Current game.beatTime — the encounter target snaps to this clock.
  beatTime: number;
  // Realistic speed band for this asteroid kind / size / generation. The
  // adjusted speed is clamped here, so an unusable beat target falls back to
  // the next candidate instead of producing a silly velocity.
  speedRange: [number, number];
  // Ring radius (px) we want the asteroid to *cross* on a beat. For incoming
  // edge spawns this is "fire-on-beat-N → hit-on-beat-N+1" distance (bullet
  // flight time * bullet speed). For split children — which spawn at the
  // ship-adjacent kill site and move outward — it's how far out we want them
  // to drift before the player has a clean follow-up shot.
  engageRadius: number;
  // Maximum number of beat-grid steps ahead we'll consider. A larger value
  // gives the adjuster more candidate targets to find a feasible match, but
  // an absurdly far-future encounter isn't useful — by then the field has
  // changed. 16 grids = 8 s, longer than any realistic engagement window.
  maxBeats?: number;
  // Minimum beats ahead — used for split children, where targeting "0 beats
  // from now" would mean "you can shoot it the instant it spawns", which is
  // not how the player will actually re-engage debris.
  minBeats?: number;
  // Optional: claimed beat indices. The adjuster prefers free beats over
  // taken ones so a batch of spawns fan out across the beat grid instead of
  // clumping on a single beat. The chosen beat index is added to the set on
  // a successful adjustment. Pass the same Set across calls in one batch.
  claimed?: BeatClaimSet;
  // Optional: max position nudge along the velocity direction (px). Lets
  // splits slide the spawn point a few pixels forward so a tighter speed
  // band still finds a beat-aligned solution. Only used for the split path —
  // for incoming edge spawns sliding the pos visibly teleports the rock.
  maxPosNudge?: number;
};

export type RhythmAdjustResult = {
  pos: Vec;        // possibly nudged spawn position
  vel: Vec;        // direction preserved, speed adjusted
  beatIndex: number; // absolute beat index (round((beatTime+t)/BEAT_GRID)) chosen
};

// Time the asteroid (moving in `dir` at unit distance-rate, from `pos`)
// takes to reach distance `D` from refPos. Returns the s*t product (the
// *distance along the trajectory* it has to travel), or null if the
// trajectory never enters / exits the ring of radius D in the future.
//
// The asteroid's straight-line motion is `pos + dir * (s*t)`. Squaring the
// distance equation against D gives a quadratic in (s*t):
//   (s*t)^2 + 2*q*(s*t) + (R^2 - D^2) = 0
// where R = |pos - ref| and q = dir · (pos - ref).
const distanceAlongPathToRing = (
  pos: Vec, dir: Vec, refPos: Vec, D: number,
): number | null => {
  const ux = pos.x - refPos.x;
  const uy = pos.y - refPos.y;
  const R2 = ux * ux + uy * uy;
  const q = dir.x * ux + dir.y * uy;
  // Discriminant of (s*t)^2 + 2q(s*t) + (R^2 - D^2) = 0  →  4(q^2 - R^2 + D^2).
  const disc = q * q - R2 + D * D;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const inside = R2 < D * D;
  // s*t = -q ± √disc. Outside the ring → "first crossing" = -q - √disc; inside
  // → "exit" = -q + √disc. We want a strictly future event (positive value).
  const st = inside ? -q + sqrtDisc : -q - sqrtDisc;
  return st > 0 ? st : null;
};

// Try to compute (newPos, newVel, beatIndex) such that the asteroid's
// arrival at engageRadius is beat-aligned, speed is in speedRange, position
// is nudged at most ±maxPosNudge along the velocity direction, and the
// chosen beat isn't already in `claimed` (if a free option exists).
//
// Returns null if no candidate beat target sits in the speed band even
// after a position nudge — caller should keep the original pos/vel.
export const tryAlignToRhythm = (
  pos: Vec,
  vel: Vec,
  opts: RhythmAdjustOpts,
): RhythmAdjustResult | null => {
  const currentSpeed = Math.hypot(vel.x, vel.y);
  if (currentSpeed < 1e-3) return null;
  const dir = { x: vel.x / currentSpeed, y: vel.y / currentSpeed };

  const beatPhase = opts.beatTime % BEAT_GRID;
  // Seconds until the next beat boundary — equals BEAT_GRID when we're
  // already sitting exactly on a beat (avoids a degenerate t_target=0).
  const toNextBeat = beatPhase === 0 ? BEAT_GRID : BEAT_GRID - beatPhase;
  // Beat index whose moment is `beatTime + toNextBeat`. Subsequent
  // candidates are this index + k. We use this for the "claimed" bookkeeping
  // so two asteroids spawning at the same beatTime claim distinct indices.
  const baseBeatIdx = Math.round((opts.beatTime + toNextBeat) / BEAT_GRID);

  const minBeats = Math.max(0, opts.minBeats ?? 0);
  const maxBeats = Math.max(minBeats, opts.maxBeats ?? 16);
  const [sMin, sMax] = opts.speedRange;
  const maxPosNudge = Math.max(0, opts.maxPosNudge ?? 0);
  const refVel = opts.refVel;

  // Pre-compute nudged spawn positions (no per-beat allocations). The
  // path-distance to the engagement ring depends on the reference position,
  // which moves with each beat candidate when refVel is set — so we defer
  // the pathDist computation into the loop.
  const NUDGE_SAMPLES = 5;
  const nudgePositions: { delta: number; np: Vec }[] = [];
  if (maxPosNudge > 0) {
    for (let i = 1; i <= NUDGE_SAMPLES; i++) {
      const dp = (i / NUDGE_SAMPLES) * maxPosNudge;
      for (const sign of [1, -1]) {
        const delta = dp * sign;
        nudgePositions.push({
          delta,
          np: { x: pos.x + dir.x * delta, y: pos.y + dir.y * delta },
        });
      }
    }
  }

  // Iterate candidate beat slots; for each, score the no-nudge variant and
  // all nudged variants. Score:
  //   cost = |s_new - currentSpeed| / currentSpeed   (speed change penalty)
  //        + |Δp| / maxPosNudge * 0.3                (nudge penalty, small)
  //        + (claimed ? 2 : 0)                       (claimed slot penalty)
  // Lower is better. The claimed penalty (2) is large enough that any
  // unclaimed candidate beats any claimed one when both are otherwise valid.
  let best: { score: number; result: RhythmAdjustResult; beatIdx: number } | null = null;
  // Scratch ref point — reused per candidate, then reassigned for nudged
  // variants. Allocating one object keeps the loop allocation-free.
  const refAt: Vec = { x: opts.refPos.x, y: opts.refPos.y };
  for (let k = minBeats; k <= maxBeats; k++) {
    const tTarget = toNextBeat + k * BEAT_GRID;
    if (tTarget <= 0) continue;
    const beatIdx = baseBeatIdx + k;
    const isClaimed = opts.claimed?.has(beatIdx) ?? false;
    const claimedPenalty = isClaimed ? 2 : 0;
    // Where the reference (the ship, for splits) will be at the candidate
    // beat moment. For static refs (refVel undefined) this is just refPos.
    if (refVel) {
      refAt.x = opts.refPos.x + refVel.x * tTarget;
      refAt.y = opts.refPos.y + refVel.y * tTarget;
    } else {
      refAt.x = opts.refPos.x;
      refAt.y = opts.refPos.y;
    }

    const pathDist0 = distanceAlongPathToRing(pos, dir, refAt, opts.engageRadius);
    if (pathDist0 !== null) {
      const reqSpeed = pathDist0 / tTarget;
      if (reqSpeed >= sMin && reqSpeed <= sMax) {
        const speedCost = Math.abs(reqSpeed - currentSpeed) / Math.max(1, currentSpeed);
        const score = speedCost + claimedPenalty;
        if (!best || score < best.score) {
          best = {
            score,
            beatIdx,
            result: {
              pos: { x: pos.x, y: pos.y },
              vel: { x: dir.x * reqSpeed, y: dir.y * reqSpeed },
              beatIndex: beatIdx,
            },
          };
        }
      }
    }

    for (const n of nudgePositions) {
      const pd = distanceAlongPathToRing(n.np, dir, refAt, opts.engageRadius);
      if (pd === null) continue;
      const reqSpeed = pd / tTarget;
      if (reqSpeed < sMin || reqSpeed > sMax) continue;
      const speedCost = Math.abs(reqSpeed - currentSpeed) / Math.max(1, currentSpeed);
      const nudgeCost = Math.abs(n.delta) / maxPosNudge * 0.3;
      const score = speedCost + nudgeCost + claimedPenalty;
      if (!best || score < best.score) {
        best = {
          score,
          beatIdx,
          result: {
            pos: { x: n.np.x, y: n.np.y },
            vel: { x: dir.x * reqSpeed, y: dir.y * reqSpeed },
            beatIndex: beatIdx,
          },
        };
      }
    }
  }
  if (!best) return null;
  opts.claimed?.add(best.beatIdx);
  return best.result;
};

// Convenience wrapper: applies the adjustment in-place if a feasible match
// exists, otherwise leaves pos/vel alone. Returns true if a change was made.
export const alignVelocityToRhythm = (
  pos: Vec,
  vel: Vec,
  opts: RhythmAdjustOpts,
): boolean => {
  const adjusted = tryAlignToRhythm(pos, vel, opts);
  if (!adjusted) return false;
  pos.x = adjusted.pos.x;
  pos.y = adjusted.pos.y;
  vel.x = adjusted.vel.x;
  vel.y = adjusted.vel.y;
  return true;
};
