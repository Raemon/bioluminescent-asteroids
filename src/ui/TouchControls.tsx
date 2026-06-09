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

const arrow = (d: string): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);

const PAD_ACTIONS: Partial<Record<ControlAction, ActionDef>> = {
  rotateLeft:  { action: "rotateLeft",  label: "Turn left",  icon: arrow("M15 5 L7 12 L15 19") },
  rotateRight: { action: "rotateRight", label: "Turn right", icon: arrow("M9 5 L17 12 L9 19") },
  thrust:      { action: "thrust",      label: "Thrust",     icon: arrow("M5 15 L12 7 L19 15") },
  reverse:     { action: "reverse",     label: "Reverse",    icon: arrow("M5 9 L12 17 L19 9") },
};

const keyForAction = (action: ControlAction): string => {
  const bound = getBindings()[action];
  if (bound && bound.length > 0) return bound[0];
  return DEFAULT_BINDINGS[action][0] ?? "";
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
  const heldRef = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<{ state: string }>).detail;
      const playing = detail.state === "playing" || detail.state === "dying";
      if (!playing) {
        // release every held virtual key on state-out so a finger that was
        //   down at game-over doesn't keep the ship spinning into the menu.
        const input = getInput();
        if (input) for (const k of heldRef.current.values()) input.setVirtual(k, false);
        heldRef.current.clear();
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
    const key = keyForAction(action);
    if (!key) return;
    const btn = e.currentTarget;
    btn.setPointerCapture?.(e.pointerId);
    // Release whatever this pointer was holding before (covers a drag from
    //   one button into another that briefly fires pointerdown without an
    //   intervening pointerup).
    const prev = heldRef.current.get(e.pointerId);
    if (prev && prev !== key) input.setVirtual(prev, false);
    heldRef.current.set(e.pointerId, key);
    input.setVirtual(key, true);
    // Drop focus so a paired hardware keyboard's Space press doesn't
    //   re-trigger this button's default click action.
    btn.blur();
  };

  const releasePointer = (e: React.PointerEvent<HTMLButtonElement>) => {
    const input = getInput();
    const key = heldRef.current.get(e.pointerId);
    if (input && key) input.setVirtual(key, false);
    heldRef.current.delete(e.pointerId);
  };

  const renderBtn = (def: ActionDef, group: "rotate" | "thrust") => (
    <button
      key={def.action}
      type="button"
      tabIndex={-1}
      className={`tc-btn tc-btn--${group} tc-btn--${def.action}`}
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
      <div className="tc-cluster tc-cluster--thrust">
        {renderBtn(PAD_ACTIONS.thrust!, "thrust")}
        {renderBtn(PAD_ACTIONS.reverse!, "thrust")}
      </div>
    </div>
  );
};
