// Fuel Mode — optional survival layer where thrusting drains a fuel reserve
// that slowly refills, and fuel orbs (dropped by gold gems that don't pay out
// an upgrade) top it back up. Flip FUEL_MODE_ENABLED off to remove every fuel
// cost, hide the HUD bar, and stop fuel orbs from spawning.
export const FUEL_MODE_ENABLED = true;

export const FUEL_MAX = 100;
// drain per second of held forward / reverse thrust at full ramp.
export const FUEL_THRUST_DRAIN = 14;
// side engines are cheaper than the main drive so strafing stays affordable.
export const FUEL_SIDE_DRAIN = 9;
// passive trickle back per second whenever the reserve isn't full.
export const FUEL_RECHARGE = 1;
// fraction of FUEL_MAX a single fuel orb restores.
export const FUEL_ORB_RESTORE = 35;

// Shield (held on the shield key). Raising the shield sips fuel pre-emptively
// every second it's up, and ramming a rock with it up costs a burst scaled by
// the impact — bigger, faster rocks take a bigger bite. The hold drain is
// cheaper than a side engine so keeping a guard up while coasting is viable.
export const FUEL_SHIELD_HOLD_DRAIN = 6;
// Impact cost = SHIELD_IMPACT_FACTOR × asteroid-radius × relative-impact-speed,
// clamped so a glancing tap on a pebble is near-free and a full-speed slam into
// a planetoid empties a big chunk of the tank rather than the whole thing.
export const FUEL_SHIELD_IMPACT_FACTOR = 0.00035;
export const FUEL_SHIELD_IMPACT_MIN = 4;
export const FUEL_SHIELD_IMPACT_MAX = 55;
// Flat bite the shield takes to swallow a non-asteroid hit (alien bullet, drifting
// gem, boss beam) — those have no meaningful "size × speed", so they cost a fixed
// amount rather than the asteroid impact formula.
export const FUEL_SHIELD_ABSORB = 12;

// Fuel a shielded ram into asteroid `a` (with the ship moving at shipVel) costs.
//   radius stands in for size; |shipVel − asteroidVel| is the speed that matters.
export const shieldImpactFuelCost = (
  radius: number,
  relSpeed: number,
): number => {
  const raw = FUEL_SHIELD_IMPACT_FACTOR * radius * relSpeed;
  return Math.min(FUEL_SHIELD_IMPACT_MAX, Math.max(FUEL_SHIELD_IMPACT_MIN, raw));
};

// Laser (lasershot upgrade) fuel costs. Holding to charge sips fuel slowly —
// less than a side engine — so defensive charging stays affordable; the charge
// is rhythm-capped at a few beats so the hold is short anyway. Firing then pays
// a per-shot toll that scales with how many dots you charged, so an uncharged
// tap is near-free while a maxed melt-everything beam takes a real bite out of
// the tank and competes with movement for the reserve.
export const FUEL_LASER_CHARGE_DRAIN = 4;
export const FUEL_LASER_FIRE_BASE = 2;
export const FUEL_LASER_FIRE_PER_DOT = 4;

// Fuel a laser shot of `dots` charge costs to fire (on top of the charge sip).
export const laserFireFuelCost = (dots: number): number =>
  FUEL_LASER_FIRE_BASE + FUEL_LASER_FIRE_PER_DOT * dots;

// Spend fuel off a ship's reserve, floored at 0 — no-op when fuel mode is off.
// Structural type so callers outside shipPhysics (the laser) can drain without
// importing Ship. Unlike thrust, the laser never hard-blocks on empty: a broke
// ship still fires, it just can't also maneuver, rather than going defenceless.
export const spendShipFuel = (ship: { fuel: number }, amount: number) => {
  if (!FUEL_MODE_ENABLED) return;
  ship.fuel = Math.max(0, ship.fuel - amount);
};
