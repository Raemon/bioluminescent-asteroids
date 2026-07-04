import type { IInput } from "../Input";

// Player-editable keyboard bindings. Each action holds a single binding string,
//   which may be a plain key ("arrowleft", " ") or a modifier chord
//   ("shift+arrowleft"). Stored in localStorage so it survives page reloads.
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

// Arrow-key defaults; the controls editor exposes one slot per action. A slot
//   may hold a modifier chord (e.g. side thrust = shift + arrow).
export const DEFAULT_BINDINGS: Bindings = {
  rotateLeft: ["arrowleft"],
  rotateRight: ["arrowright"],
  precisionTurn: ["control"],
  thrust: ["arrowup"],
  reverse: ["arrowdown"],
  sidePort: ["shift+arrowleft"],
  sideStarboard: ["shift+arrowright"],
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

const sanitize = (raw: unknown): Bindings => {
  const out = cloneDefaults();
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const action of ACTION_ORDER) {
    const v = obj[action];
    if (Array.isArray(v)) {
      const keys = v.filter((k): k is string => typeof k === "string" && k.length > 0).slice(0, 1);
      out[action] = keys;
    }
  }
  return out;
};

// Exposed for the replay path: the recorded header carries a generic
//   Record<string,string[]> from an older or future build, and we want to drop
//   keys we don't recognise + default any missing actions before using it.
export const normalizeBindings = (raw: unknown): Bindings => sanitize(raw);

const readFromStorage = (): Bindings => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaults();
    return sanitize(JSON.parse(raw));
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
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
type Chord = { mods: string[]; main: string };
const parseChord = (binding: string): Chord => {
  const parts = binding.split("+");
  const main = parts[parts.length - 1];
  const mods = parts.slice(0, -1).filter(isModifier);
  return { mods, main };
};

// Do the currently-held modifiers exactly match those this chord declares?
//   Exact match is what suppresses bare bindings while a modifier is held:
//   "arrowleft" (no mods) fails the moment shift goes down, so shift+arrow
//   fires the chord alone. When the main key is itself a modifier ("control"
//   for a hold), that key is expected held and excluded from the surplus check.
const modsMatch = (input: IInput, chord: Chord): boolean => {
  for (const m of MODIFIER_KEYS) {
    const wantHeld = chord.mods.includes(m) || m === chord.main;
    if (input.down(m) !== wantHeld) return false;
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
