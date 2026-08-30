import type { IInput } from "../Input";

// Player-editable keyboard bindings. Each action holds up to BINDING_SLOTS
//   binding strings (slot 0 = primary, slot 1 = alternate), each of which may be
//   a plain key ("arrowleft", " ") or a modifier chord ("shift+arrowleft"). Any
//   slot firing triggers the action, which is how arrows and WASD both drive the
//   ship out of the box. Stored in localStorage so it survives page reloads.
//
// Chord matching is EXACT on modifiers: a binding fires only when the set of
//   modifiers currently held equals the set the binding declares. So bare
//   "arrowleft" is suppressed while shift is held (the player means the
//   shift+arrowleft chord), and "shift+arrowleft" never fires from arrowleft
//   alone. A binding whose main key is itself a modifier ("control" for a hold)
//   ignores that key when comparing the held-modifier set.

export type ControlAction =
  | "rotateLeft"
  | "rotateRight"
  | "precisionTurn"
  | "thrust"
  | "reverse"
  | "sidePort"
  | "sideStarboard"
  | "fire"
  | "pause";

export type Bindings = Record<ControlAction, string[]>;

const STORAGE_KEY = "pulsar.controls.v1";

// Primary + alternate slot per action; the controls editor exposes both.
export const BINDING_SLOTS = 2;
export const SLOT_LABELS: readonly string[] = ["Primary", "Alternate"];

// Arrows primary, WASD alternate — both live at once so a player can use either
//   without touching Settings. A slot may hold a modifier chord (side thrust =
//   shift + turn key, on whichever scheme they're using).
export const DEFAULT_BINDINGS: Bindings = {
  rotateLeft: ["arrowleft", "a"],
  rotateRight: ["arrowright", "d"],
  precisionTurn: ["control"],
  thrust: ["arrowup", "w"],
  reverse: ["arrowdown", "s"],
  sidePort: ["shift+arrowleft", "shift+a"],
  sideStarboard: ["shift+arrowright", "shift+d"],
  fire: [" "],
  pause: ["escape"],
};

export const ACTION_ORDER: ControlAction[] = [
  "rotateLeft",
  "thrust",
  "rotateRight",
  "reverse",
  "sidePort",
  "fire",
  "sideStarboard",
  "pause",
  "precisionTurn",
];

export const ACTION_LABELS: Record<ControlAction, string> = {
  rotateLeft: "Turn left",
  rotateRight: "Turn right",
  thrust: "Thrust",
  reverse: "Reverse thrust",
  sidePort: "Side thrust ←",
  sideStarboard: "Side thrust →",
  fire: "Fire",
  pause: "Pause",
  precisionTurn: "Precise turn (hold)",
};

// Canonical controls shown in the tutorial / start-of-run controls hint. One row per
//   label; each key glyph in a row is bound to its own action and fades the moment
//   that specific key is pressed. The whole pane retires once every key across every
//   row has been used. Used both to render the pane and to gate its dismissal so the
//   two can never drift apart.
export type TutorialKey = { action: ControlAction; glyph: string };
export type TutorialControl = { label: string; keys: TutorialKey[] };
export const TUTORIAL_CONTROLS: TutorialControl[] = [
  { label: "thrust", keys: [{ action: "thrust", glyph: "↑" }] },
  { label: "reverse", keys: [{ action: "reverse", glyph: "↓" }] },
  { label: "rotate", keys: [{ action: "rotateLeft", glyph: "←" }, { action: "rotateRight", glyph: "→" }] },
  { label: "side thrust", keys: [{ action: "sidePort", glyph: "SHIFT ←" }, { action: "sideStarboard", glyph: "SHIFT →" }] },
  { label: "fire", keys: [{ action: "fire", glyph: "space" }] },
];
// Flat list of every action shown in the pane, in display order.
export const TUTORIAL_CONTROL_ACTIONS: ControlAction[] = TUTORIAL_CONTROLS.flatMap((c) => c.keys.map((k) => k.action));
// Per-key usage; a key's glyph fades once its action is used, pane retires when all are.
export type TutorialControlsUsed = Partial<Record<ControlAction, boolean>>;
export const emptyTutorialControlsUsed = (): TutorialControlsUsed =>
  Object.fromEntries(TUTORIAL_CONTROL_ACTIONS.map((a) => [a, false])) as TutorialControlsUsed;

let cached: Bindings | null = null;

const cloneDefaults = (): Bindings => ({
  rotateLeft: [...DEFAULT_BINDINGS.rotateLeft],
  rotateRight: [...DEFAULT_BINDINGS.rotateRight],
  precisionTurn: [...DEFAULT_BINDINGS.precisionTurn],
  thrust: [...DEFAULT_BINDINGS.thrust],
  reverse: [...DEFAULT_BINDINGS.reverse],
  sidePort: [...DEFAULT_BINDINGS.sidePort],
  sideStarboard: [...DEFAULT_BINDINGS.sideStarboard],
  fire: [...DEFAULT_BINDINGS.fire],
  pause: [...DEFAULT_BINDINGS.pause],
});

const sanitize = (raw: unknown, backfill = false): Bindings => {
  const out = cloneDefaults();
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  const stored: Partial<Record<ControlAction, string[]>> = {};
  for (const action of ACTION_ORDER) {
    const v = obj[action];
    if (Array.isArray(v)) {
      const keys = v.filter((k): k is string => typeof k === "string" && k.length > 0).slice(0, BINDING_SLOTS);
      stored[action] = keys;
      out[action] = keys;
    }
  }
  if (backfill) backfillAlternates(out, stored);
  return out;
};

// Payloads written before the alternate slot existed hold one key per action, so
//   a returning player would silently miss the WASD scheme new players get. Top
//   each short action back up from the defaults, skipping any default key the
//   player has explicitly bound elsewhere — their own bindings always win.
const backfillAlternates = (out: Bindings, stored: Partial<Record<ControlAction, string[]>>) => {
  const claimed = new Set<string>();
  for (const action of ACTION_ORDER) for (const k of stored[action] ?? []) claimed.add(k);
  for (const action of ACTION_ORDER) {
    if (!stored[action] || out[action].length >= BINDING_SLOTS) continue;
    for (const fallback of DEFAULT_BINDINGS[action]) {
      if (out[action].length >= BINDING_SLOTS) break;
      if (claimed.has(fallback) || out[action].includes(fallback)) continue;
      out[action].push(fallback);
      claimed.add(fallback);
    }
  }
};

// Exposed for the replay path: the recorded header carries a generic
//   Record<string,string[]> from an older or future build, and we want to drop
//   keys we don't recognise + default any missing actions before using it. No
//   backfill here — a replay must respond to exactly the keys it was recorded
//   with, not to alternates the recording's build never had.
export const normalizeBindings = (raw: unknown): Bindings => sanitize(raw);

// Marker written alongside the actions once the payload is known to have been
//   authored against the two-slot editor. Its absence means a pre-alternates
//   payload that still needs the one-time backfill; its presence means every
//   slot is deliberate, so an alternate the player cleared stays cleared.
const SLOTS_MARKER = "_slots";

const readFromStorage = (): Bindings => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaults();
    const parsed = JSON.parse(raw);
    const legacy = !parsed || typeof parsed !== "object" || !(SLOTS_MARKER in parsed);
    return sanitize(parsed, legacy);
  } catch {
    return cloneDefaults();
  }
};

export const getBindings = (): Bindings => {
  if (cached === null) cached = readFromStorage();
  return cached;
};

export const saveBindings = (next: Bindings) => {
  cached = sanitize(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cached, [SLOTS_MARKER]: BINDING_SLOTS }));
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent("controls:changed"));
};

export const resetBindings = () => saveBindings(cloneDefaults());

// Keep cache in sync if another tab / dialog instance updates the bindings.
if (typeof window !== "undefined") {
  window.addEventListener("controls:changed", () => {
    cached = readFromStorage();
  });
}

// Display label for a stored key string ("arrowleft" → "←", " " → "space").
const KEY_DISPLAY: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  " ": "space",
  spacebar: "space",
  escape: "esc",
  esc: "esc",
  enter: "enter",
  return: "enter",
  control: "ctrl",
  meta: "cmd",
  shift: "shift",
  alt: "alt",
  tab: "tab",
};

const formatKeyPart = (key: string): string => {
  const k = key.toLowerCase();
  if (KEY_DISPLAY[k]) return KEY_DISPLAY[k];
  return k.length === 1 ? k.toUpperCase() : k;
};

// A binding may be a chord ("shift+arrowleft"); render each part joined by "+".
export const formatKey = (binding: string): string =>
  binding.split("+").map(formatKeyPart).join("+");

// Normalize a KeyboardEvent.key into the form used by the Input layer.
export const normalizeKey = (raw: string): string => {
  const k = raw.toLowerCase();
  if (k === "spacebar") return " ";
  if (k === "esc") return "escape";
  if (k === "return") return "enter";
  return k;
};

// Keys that act as chord modifiers. Stored in normalized (lowercase) form.
export const MODIFIER_KEYS: readonly string[] = ["shift", "control", "alt", "meta"];
export const isModifierKey = (key: string): boolean => (MODIFIER_KEYS as string[]).includes(key);
const isModifier = isModifierKey;

// Build a chord binding string from a keydown event's held modifiers plus the
//   (already-normalized, non-modifier) main key. Modifier order is fixed so two
//   bindings for the same chord always stringify identically. Used by the
//   Settings capture flow: pressing Shift+← yields "shift+arrowleft".
export const chordFromEvent = (
  e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  mainKey: string,
): string => {
  const held: Record<string, boolean> = {
    shift: e.shiftKey, control: e.ctrlKey, alt: e.altKey, meta: e.metaKey,
  };
  const mods = MODIFIER_KEYS.filter((m) => held[m]);
  return [...mods, mainKey].join("+");
};

// Split a binding string into its modifier prefix keys and its main key. The
//   last "+"-separated part is the main key; everything before it must be a
//   modifier. "shift+arrowleft" → { mods:["shift"], main:"arrowleft" }.
export type Chord = { mods: string[]; main: string };
export const parseChord = (binding: string): Chord => {
  const parts = binding.split("+");
  const main = parts[parts.length - 1];
  const mods = parts.slice(0, -1).filter(isModifier);
  return { mods, main };
};

// Does some active binding pair modifier m as a prefix with this exact main
//   key? If so, a held m must suppress the bare `main` binding so the chord
//   (e.g. shift+arrowleft = side thrust) wins the key instead. If not, a held m
//   is incidental and leaves the bare binding alone — holding shift for side
//   thrust must not also mask thrust (arrowup) or fire (space).
const modifierClaimsMain = (m: string, main: string): boolean => {
  const bindings = activeBindings();
  for (const action in bindings) {
    for (const binding of bindings[action as ControlAction]) {
      const chord = parseChord(binding);
      if (chord.main === main && chord.mods.includes(m)) return true;
    }
  }
  return false;
};

// Do the currently-held modifiers match those this chord declares? A declared
//   modifier must be held. A modifier the chord does NOT declare only forces a
//   mismatch when it's held AND some other binding claims it as a prefix on the
//   same main key (see modifierClaimsMain) — that per-key rule is what lets
//   shift+arrow suppress bare arrow while leaving bare arrowup/space firing with
//   shift held. When the main key is itself a modifier ("control" for a hold),
//   that key is expected held and excluded from the surplus check.
const modsMatch = (input: IInput, chord: Chord): boolean => {
  for (const m of MODIFIER_KEYS) {
    const wantHeld = chord.mods.includes(m) || m === chord.main;
    if (input.down(m) === wantHeld) continue;
    if (!wantHeld && !modifierClaimsMain(m, chord.main)) continue;
    return false;
  }
  return true;
};

const chordDown = (input: IInput, binding: string): boolean => {
  const chord = parseChord(binding);
  return input.down(chord.main) && modsMatch(input, chord);
};

// Edge-trigger on the main key, but only while the modifier set already matches
//   this frame — so shift+arrow's press edge doesn't leak to a bare-arrow action.
const chordPressed = (input: IInput, binding: string): boolean => {
  const chord = parseChord(binding);
  return input.pressed(chord.main) && modsMatch(input, chord);
};

// During replay we substitute the recording's bindings so the recorded raw
//   keys map to the same actions even if the watcher has rebound their keys.
//   setReplayBindings(null) at end-of-replay reverts to the live bindings.
let replayBindings: Bindings | null = null;
export const setReplayBindings = (b: Bindings | null): void => { replayBindings = b; };
const activeBindings = (): Bindings => replayBindings ?? getBindings();

export const isDown = (input: IInput, action: ControlAction): boolean => {
  const keys = activeBindings()[action];
  for (let i = 0; i < keys.length; i++) if (chordDown(input, keys[i])) return true;
  return false;
};

export const wasPressed = (input: IInput, action: ControlAction): boolean => {
  const keys = activeBindings()[action];
  for (let i = 0; i < keys.length; i++) if (chordPressed(input, keys[i])) return true;
  return false;
};
