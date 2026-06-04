import type { IInput } from "../Input";

// Player-editable keyboard bindings. Each action holds up to two keys (primary +
//   alternate) — matches how the game has always supported both arrow keys and
//   WASD for movement. Stored in localStorage so it survives page reloads.

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

// Arrow-key defaults; the controls editor exposes one slot per action.
export const DEFAULT_BINDINGS: Bindings = {
  rotateLeft: ["arrowleft"],
  rotateRight: ["arrowright"],
  precisionTurn: ["shift"],
  thrust: ["arrowup"],
  reverse: ["arrowdown"],
  sidePort: [],
  sideStarboard: [],
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

export const formatKey = (key: string): string => {
  const k = key.toLowerCase();
  if (KEY_DISPLAY[k]) return KEY_DISPLAY[k];
  return k.length === 1 ? k.toUpperCase() : k;
};

// Normalize a KeyboardEvent.key into the form used by the Input layer.
export const normalizeKey = (raw: string): string => {
  const k = raw.toLowerCase();
  if (k === "spacebar") return " ";
  if (k === "esc") return "escape";
  if (k === "return") return "enter";
  return k;
};

export const isDown = (input: IInput, action: ControlAction): boolean => {
  const keys = getBindings()[action];
  for (let i = 0; i < keys.length; i++) if (input.down(keys[i])) return true;
  return false;
};

export const wasPressed = (input: IInput, action: ControlAction): boolean => {
  const keys = getBindings()[action];
  for (let i = 0; i < keys.length; i++) if (input.pressed(keys[i])) return true;
  return false;
};
