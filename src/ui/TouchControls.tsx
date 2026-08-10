import { useEffect, useRef, useState, type ReactElement } from "react";
import { isTouchDevice } from "./touch";
import { getBindings, DEFAULT_BINDINGS, type ControlAction } from "../game/controlBindings";
import type { Input } from "../Input";

// On-screen movement pad for touch devices. Synthesizes virtual key state
//   into Game.localInput so the rest of the input pipeline (controlBindings,
//   replayRecorder) keeps working unchanged. Each button presses the *first*
//   key currently bound to its action, so rebinding in Settings carries
//   through to the touch surface.

type ActionDef = {
  action: ControlAction;
  label: string;
  icon: ReactElement;
};

type Held = { action: ControlAction; keys: string[] };

const arrow = (d: string): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);

const burst = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="4.6" />
    <path d="M12 1.6 L12 5.2 M12 18.8 L12 22.4 M1.6 12 L5.2 12 M18.8 12 L22.4 12" />
  </svg>
);

const PAD_ACTIONS: Partial<Record<ControlAction, ActionDef>> = {
  rotateLeft:  { action: "rotateLeft",  label: "Turn left",  icon: arrow("M15 5 L7 12 L15 19") },
  rotateRight: { action: "rotateRight", label: "Turn right", icon: arrow("M9 5 L17 12 L9 19") },
  thrust:      { action: "thrust",      label: "Thrust",     icon: arrow("M5 15 L12 7 L19 15") },
  reverse:     { action: "reverse",     label: "Reverse",    icon: arrow("M5 9 L12 17 L19 9") },
  fire:        { action: "fire",        label: "Fire",       icon: burst() },
};

const keysForAction = (action: ControlAction): string[] => {
  const bound = getBindings()[action][0] || DEFAULT_BINDINGS[action][0] || "";
  if (!bound.includes("+")) return bound ? [bound] : [];
  const parts = bound.split("+").filter((p) => p.length > 0);
  return parts.length > 0 ? parts : DEFAULT_BINDINGS[action];
};

const getInput = (): Input | null => {
  const g = (window as unknown as { __game?: { localInput: Input; state?: string } }).__game;
  return g?.localInput ?? null;
};

const getInitialVisible = (): boolean => {
  const g = (window as unknown as { __game?: { state?: string } }).__game;
  return g?.state === "playing" || g?.state === "dying";
};

export const TouchControls = () => {
  const [enabled] = useState<boolean>(() => isTouchDevice());
  const [visible, setVisible] = useState<boolean>(() => getInitialVisible());
  const [pressed, setPressed] = useState<ControlAction[]>([]);
  const heldRef = useRef<Map<number, Held>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<{ state: string }>).detail;
      const playing = detail.state === "playing" || detail.state === "dying";
      if (!playing) {
        // release every held virtual key on state-out so a finger that was
        //   down at game-over doesn't keep the ship spinning into the menu.
        const input = getInput();
        if (input) for (const held of heldRef.current.values()) for (const k of held.keys) input.setVirtual(k, false);
        heldRef.current.clear();
        setPressed([]);
      }
      setVisible(playing);
    };
    window.addEventListener("game:state", onState as EventListener);
    return () => window.removeEventListener("game:state", onState as EventListener);
  }, [enabled]);

  if (!enabled || !visible) return null;

  const pressAction = (e: React.PointerEvent<HTMLButtonElement>, action: ControlAction) => {
    e.preventDefault();
    const input = getInput();
    if (!input) return;
    const keys = keysForAction(action);
    if (keys.length === 0) return;
    const btn = e.currentTarget;
    btn.setPointerCapture?.(e.pointerId);
    // Release whatever this pointer was holding before (covers a drag from
    //   one button into another that briefly fires pointerdown without an
    //   intervening pointerup).
    const prev = heldRef.current.get(e.pointerId);
    if (prev) for (const k of prev.keys) if (!keys.includes(k)) input.setVirtual(k, false);
    heldRef.current.set(e.pointerId, { action, keys });
    for (const k of keys) input.setVirtual(k, true);
    setPressed((cur) => {
      const rest = prev ? cur.filter((a) => a !== prev.action) : cur;
      return rest.includes(action) ? rest : [...rest, action];
    });
    // Drop focus so a paired hardware keyboard's Space press doesn't
    //   re-trigger this button's default click action.
    btn.blur();
  };

  const releasePointer = (e: React.PointerEvent<HTMLButtonElement>) => {
    const input = getInput();
    const held = heldRef.current.get(e.pointerId);
    if (!held) return;
    if (input) for (const k of held.keys) input.setVirtual(k, false);
    heldRef.current.delete(e.pointerId);
    setPressed((cur) => cur.filter((a) => a !== held.action));
  };

  const renderBtn = (def: ActionDef, group?: "rotate" | "thrust") => (
    <button
      key={def.action}
      type="button"
      tabIndex={-1}
      className={[
        "tc-btn",
        group ? `tc-btn--${group}` : "",
        `tc-btn--${def.action}`,
        pressed.includes(def.action) ? "tc-btn--pressed" : "",
      ].filter(Boolean).join(" ")}
      aria-label={def.label}
      onPointerDown={(e) => pressAction(e, def.action)}
      onPointerUp={releasePointer}
      onPointerCancel={releasePointer}
      onPointerLeave={releasePointer}
      onContextMenu={(e) => e.preventDefault()}
    >
      {def.icon}
    </button>
  );

  return (
    <div id="touch-controls">
      <div className="tc-cluster tc-cluster--rotate">
        {renderBtn(PAD_ACTIONS.rotateLeft!, "rotate")}
        {renderBtn(PAD_ACTIONS.rotateRight!, "rotate")}
      </div>
      <div className="tc-cluster tc-cluster--action">
        <div className="tc-stack">
          {renderBtn(PAD_ACTIONS.thrust!, "thrust")}
          {renderBtn(PAD_ACTIONS.reverse!, "thrust")}
        </div>
        {renderBtn(PAD_ACTIONS.fire!)}
      </div>
    </div>
  );
};
