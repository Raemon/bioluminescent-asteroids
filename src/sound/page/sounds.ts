// Sound registry for /sound. One entry per SoundName (TypeScript types are
// erased at runtime, so the list is enumerated here once). The runtime page
// iterates this registry to build one checkbox row per sound — adding a new
// SoundName just means adding it to the SoundName union and a single entry
// below.
//
// Each entry declares:
//   - kind: how the sound triggers ("loop" = continuous, "beat" = on the
//     shared beat grid). Loops start/stop with the checkbox; beat sounds fire
//     on each matching slot while the checkbox is on.
//   - animation: which entity animation to pair with this sound (see
//     animations.ts). Defaults to "generic" if no entity is a natural fit.
//   - label/sublabel: row text. Sublabel is auto-built from the cadence if not
//     given, so the registry stays terse.
//
// Two safety nets: ALL_SOUNDS asserts the registry has an entry for every
// SoundName at compile time, and any new SoundName that lacks an entry will
// surface as a TypeScript error in this file.

import type { SoundName } from "../../Sound";
import type { AnimationId } from "./animations";

export type SoundTrigger =
  | { kind: "loop" }
  | { kind: "beat"; periodBeats: number; phaseBeats: number };

export type SoundEntry = {
  sound: SoundName;
  label: string;
  animation: AnimationId;
  trigger: SoundTrigger;
  // Optional manual override for the sublabel; otherwise auto-built.
  sublabel?: string;
};

const beat = (periodBeats: number, phaseBeats = 0): SoundTrigger => ({
  kind: "beat",
  periodBeats,
  phaseBeats,
});

const LOOP: SoundTrigger = { kind: "loop" };

// One entry per SoundName. Cadence + visual are chosen to be representative of
// how the sound actually fires in game.
const ENTRIES: Record<SoundName, Omit<SoundEntry, "sound">> = {
  // ── ship/control ─────────────────────────────────────────────────────
  thrust: { label: "ship thrusting", animation: "ship-thrust", trigger: LOOP },
  reverseThrust: { label: "back thrusting", animation: "ship-reverse", trigger: LOOP },
  sideThrust: { label: "side thrusting", animation: "ship-side", trigger: LOOP },
  death: { label: "ship death", animation: "ship-death", trigger: beat(8) },
  shieldPop: { label: "shield pop", animation: "ship-shield", trigger: beat(4) },

  // ── bullets ─────────────────────────────────────────────────────────
  fire: { label: "weak bullet", animation: "bullet-weak", trigger: beat(1, 0.5) },
  fireBeat: { label: "rhythm bullet", animation: "bullet-rhythm", trigger: beat(1) },

  // ── asteroid hits ───────────────────────────────────────────────────
  explosionSmall: { label: "asteroid chip", animation: "asteroid-chip", trigger: beat(2) },
  explosionMedium: { label: "asteroid medium hit", animation: "asteroid-chip", trigger: beat(2) },
  explosionLarge: { label: "asteroid kill", animation: "asteroid-kill", trigger: beat(4) },
  asteroidBoomBeat: { label: "asteroid boom-beat", animation: "asteroid-kill", trigger: beat(4) },

  // ── pulsar bed ──────────────────────────────────────────────────────
  bgBeat: { label: "pulsar beat", animation: "pulsar", trigger: beat(1) },
  pulsarHum: { label: "pulsar hum", animation: "pulsar", trigger: beat(8) },

  // ── bassteroids ─────────────────────────────────────────────────────
  bassKick: { label: "bass kick", animation: "asteroid-chip", trigger: beat(1) },
  bassPluck: { label: "bass pluck", animation: "asteroid-chip", trigger: beat(1) },
  bassBoom: { label: "bass boom", animation: "asteroid-chip", trigger: beat(1) },
  bassSnap: { label: "bass snap", animation: "asteroid-chip", trigger: beat(1) },
  bassHit: { label: "bass hit overlay", animation: "asteroid-chip", trigger: beat(2) },
  bassEcho: { label: "bass echo", animation: "asteroid-chip", trigger: beat(4) },

  // ── decorative pickups / combo ──────────────────────────────────────
  chime: { label: "chime", animation: "asteroid-chip", trigger: beat(2) },
  bell: { label: "bell", animation: "asteroid-chip", trigger: beat(4) },
  warble: { label: "warble", animation: "asteroid-chip", trigger: beat(4) },
  comboTick: { label: "combo tick", animation: "generic", trigger: beat(1) },
  comboSparkle: { label: "combo sparkle", animation: "generic", trigger: beat(2) },
  tink: { label: "tink", animation: "asteroid-chip", trigger: beat(4) },
  scoreBlip: { label: "score blip", animation: "generic", trigger: beat(1, 0.5) },
  summaryDownbeat: { label: "summary downbeat", animation: "generic", trigger: beat(4) },
  powerup: { label: "powerup arpeggio", animation: "canister", trigger: beat(8) },
  waveClear: { label: "wave clear", animation: "generic", trigger: beat(8) },

  // ── shockwave ───────────────────────────────────────────────────────
  shockwaveCharge: { label: "shockwave charge", animation: "generic", trigger: beat(8) },
  shockwaveBoom: { label: "shockwave boom", animation: "generic", trigger: beat(8) },

  // ── aliens ──────────────────────────────────────────────────────────
  alienFireBig: { label: "alien fire (big)", animation: "alien-big", trigger: beat(2) },
  alienFireMedium: { label: "alien fire (medium)", animation: "alien-medium", trigger: beat(1) },
  alienFireSmall: { label: "alien fire (small)", animation: "alien-small", trigger: beat(1) },
  alienHit: { label: "alien hit", animation: "alien-medium", trigger: beat(2) },
  alienExplode: { label: "alien explode", animation: "alien-medium", trigger: beat(8) },

  // ── comets ──────────────────────────────────────────────────────────
  cometNote: { label: "comet note", animation: "comet", trigger: beat(2) },
  cometDestroyed: { label: "comet destroyed", animation: "comet", trigger: beat(8) },
  cometDestroyedSad: { label: "comet destroyed (sad)", animation: "comet", trigger: beat(8) },

  // ── canisters ───────────────────────────────────────────────────────
  canisterAppear: { label: "canister appear", animation: "canister", trigger: beat(8) },
  canisterDestroyed: { label: "canister destroyed", animation: "canister", trigger: beat(8) },

  // ── misc ────────────────────────────────────────────────────────────
  comboLost: { label: "combo lost", animation: "generic", trigger: beat(8) },
};

const autoSublabel = (sound: SoundName, trig: SoundTrigger): string => {
  if (trig.kind === "loop") return `${sound} · continuous`;
  const phase = trig.phaseBeats === 0.5 ? " · off-beat" : "";
  if (trig.periodBeats === 1) return `${sound} · every beat${phase}`;
  return `${sound} · every ${trig.periodBeats} beats${phase}`;
};

export const SOUND_ENTRIES: SoundEntry[] = (Object.keys(ENTRIES) as SoundName[]).map((sound) => {
  const e = ENTRIES[sound];
  return {
    sound,
    label: e.label,
    animation: e.animation,
    trigger: e.trigger,
    sublabel: e.sublabel ?? autoSublabel(sound, e.trigger),
  };
});
