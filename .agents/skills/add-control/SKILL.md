---
name: add-control
description: Add a new player-bindable keyboard control to the Pulsar game. Ensures the control is reachable from the in-game Settings dialog (not a hardcoded key check), survives a Reset-to-defaults, and tolerates older localStorage payloads. Use when the user asks to add a new action, hotkey, or binding — including modifier keys held during another action (precision-aim, sprint, alt-fire, etc.).
---

# Adding a new keyboard control

Pulsar has a single source of truth for player-editable keyboard controls: `src/game/controlBindings.ts`. The Settings dialog reads from it, gameplay code reads from it via `isDown` / `wasPressed`, and a localStorage payload (`pulsar.controls.v1`) persists overrides. A new control is only "real" if it lives in that file. Putting `input.down("shift")` inside `shipPhysics.ts` looks like a control but isn't — the player can't see it, can't rebind it, and it won't show up in the Reset-defaults flow.

The rule: **a new control means five edits in `controlBindings.ts` and a `isDown` / `wasPressed` call at the use site. Nothing else.**

## The five-point edit in `src/game/controlBindings.ts`

Each new action needs all five — skip any one and something breaks silently.

1. **`ControlAction` union.** Add the new action name as a string-literal arm. The whole file's type-safety pivots on this — TypeScript will then force you to address the next four edits.

2. **`DEFAULT_BINDINGS`.** Add `<action>: ["<key>"]`. One key per slot (the sanitizer truncates anything longer to a single element). Keys are lowercase and match `KeyboardEvent.key.toLowerCase()`: `"shift"`, `"arrowleft"`, `"arrowup"`, `" "` (literal space for spacebar), `"escape"`, `"z"`, etc. The `KEY_DISPLAY` table at the bottom of the file shows the canonical strings for the special keys.

3. **`ACTION_ORDER`.** Insert the action name where it should appear in the Settings UI. Order matters — `SettingsDialog.tsx` iterates this array verbatim to render the controls grid. Group with related actions (rotation modifier next to rotation; alt-fire next to fire).

4. **`ACTION_LABELS`.** Add a human-readable label. Use parenthetical hints for modal controls — e.g. `"Precision turn (hold)"` — so players understand whether to tap or hold.

5. **`cloneDefaults()`.** Add `<action>: [...DEFAULT_BINDINGS.<action>]`. This is what gets returned on Reset-defaults *and* on first load when no localStorage entry exists yet. Skipping this leaves the action with no binding after a reset — a silent hole that's hard to spot in testing.

## Wiring the new control into gameplay

At the use site (almost always `src/ship/shipPhysics.ts`, `src/game/gameUpdate.ts`, or similar):

```ts
import { isDown, wasPressed } from "../game/controlBindings";

if (isDown(input, "precisionTurn")) { /* held */ }
if (wasPressed(input, "fire")) { /* edge-triggered */ }
```

**Never read `input.down("<rawkey>")` directly in gameplay code for a new control.** That bypasses the binding layer entirely: the player's rebind won't take effect, the Settings row won't reflect reality, and the control won't appear in the controls grid. The only exception is existing legacy keybinds that predate the binding system — and there aren't any worth keeping that way.

## Settings UI is automatic

`src/ui/SettingsDialog.tsx` iterates `ACTION_ORDER` and looks up `ACTION_LABELS[action]` for each row. As long as the five-point edit is complete, the new row appears in the controls grid with no UI code changes.

## Storage compatibility — no migration needed

`sanitize()` starts from `cloneDefaults()` and overlays whatever it finds in the stored payload. That means:

- Older localStorage payloads that lack the new action will pick up the default key automatically on next load.
- No version bump on `STORAGE_KEY` (`pulsar.controls.v1`) is required when adding a new action.
- A version bump *is* required if you ever rename or remove an action — but that's a different operation.

## Choosing a default key

- Pick a key not already in `DEFAULT_BINDINGS` (the `applyBinding` flow in `SettingsDialog.tsx` removes the key from any other action if a player binds it, but defaults should be conflict-free out of the box).
- Modifier keys (`shift`, `control`, `alt`, `meta`) are fair game for "hold while doing X" controls — they don't conflict with the WASD/arrow primary controls and the rebind capture in `SettingsDialog.tsx` accepts them.
- If there's no good default and you want the player to opt in, use `<action>: []` — the Settings row will render as `—` and the player can bind it themselves.

## Anti-patterns

- **Hardcoded `input.down("shift")` in physics code.** Bypasses the binding system. Always go through `isDown(input, "<action>")`.
- **Forgetting `cloneDefaults()`.** The action works on a fresh install (because `DEFAULT_BINDINGS` provides it via the sanitizer overlay) and on every reload after that — but the *Reset defaults* button silently fails to restore it. The user only finds out months later.
- **Two-key arrays.** `sanitize()` truncates to `slice(0, 1)`, so `["q", "e"]` becomes `["q"]`. The controls editor exposes one slot per action; multi-key bindings are not currently supported. If you need that, change `slice(0, 1)` in `sanitize()` and the rendering in `SettingsDialog.tsx` to match — that's a feature, not part of adding a control.
- **Action names with capitals or spaces.** Keep them camelCase (`precisionTurn`, `altFire`). They're used as TS string-literal types and object keys; the label string is where humans see prettiness.
- **Reusing a default key already in use.** A new action defaulting to `arrowleft` would conflict with `rotateLeft`. The first time a player rebinds `rotateLeft`, the conflict-resolution code in `applyBinding` may strip the key from the new action too. Pick a free default.

## Checklist before reporting done

- [ ] Five edits in `controlBindings.ts` (union, defaults, order, labels, cloneDefaults).
- [ ] Gameplay code reads the action via `isDown` or `wasPressed`, not `input.down("<rawkey>")`.
- [ ] Tried opening the Settings dialog and confirmed the new row appears in the correct spot. (Or stated that this is a frontend change you couldn't verify without the dev server.)
- [ ] No hardcoded key references remain at the use site.
