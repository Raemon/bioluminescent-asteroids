import { useEffect, useRef, useState, type ReactElement } from "react";
import { isTouchDevice } from "./touch";
import { getBindings, parseChord, type ControlAction } from "../game/controlBindings";
import type { Input } from "../Input";

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
  const bound = getBindings()[action][0] || "";
  if (!bound) return [];
  const chord = parseChord(bound);
  if (!chord.main) return [];
  return [...chord.mods, chord.main];
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
  const keyCountRef = useRef<Map<string, number>>(new Map());
  const actionCountRef = useRef<Map<ControlAction, number>>(new Map());

  const acquireKeys = (input: Input | null, keys: string[]) => {
    for (const k of keys) {
      keyCountRef.current.set(k, (keyCountRef.current.get(k) ?? 0) + 1);
      input?.setVirtual(k, true);
    }
  };

  const releaseKeys = (input: Input | null, keys: string[]) => {
    for (const k of keys) {
      const next = (keyCountRef.current.get(k) ?? 0) - 1;
      if (next > 0) {
        keyCountRef.current.set(k, next);
      } else {
        keyCountRef.current.delete(k);
        input?.setVirtual(k, false);
      }
    }
  };

  const bumpAction = (action: ControlAction, delta: number) => {
    const next = (actionCountRef.current.get(action) ?? 0) + delta;
    if (next > 0) actionCountRef.current.set(action, next);
    else actionCountRef.current.delete(action);
    setPressed([...actionCountRef.current.keys()]);
  };

  useEffect(() => {
    if (!enabled) return;
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<{ state: string }>).detail;
      const playing = detail.state === "playing" || detail.state === "dying";
      if (!playing) {
        const input = getInput();
        for (const held of heldRef.current.values()) releaseKeys(input, held.keys);
        heldRef.current.clear();
        keyCountRef.current.clear();
        actionCountRef.current.clear();
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
    const prev = heldRef.current.get(e.pointerId);
    heldRef.current.set(e.pointerId, { action, keys });
    acquireKeys(input, keys);
    bumpAction(action, 1);
    if (prev) {
      releaseKeys(input, prev.keys);
      bumpAction(prev.action, -1);
    }
    btn.blur();
  };

  const releasePointer = (e: React.PointerEvent<HTMLButtonElement>) => {
    const held = heldRef.current.get(e.pointerId);
    if (!held) return;
    heldRef.current.delete(e.pointerId);
    releaseKeys(getInput(), held.keys);
    bumpAction(held.action, -1);
  };

  const renderBtn = (def: ActionDef) => (
    <button
      key={def.action}
      type="button"
      tabIndex={-1}
      className={[
        "tc-btn",
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
        {renderBtn(PAD_ACTIONS.rotateLeft!)}
        {renderBtn(PAD_ACTIONS.rotateRight!)}
      </div>
      <div className="tc-cluster tc-cluster--action">
        <div className="tc-stack">
          {renderBtn(PAD_ACTIONS.thrust!)}
          {renderBtn(PAD_ACTIONS.reverse!)}
        </div>
        {renderBtn(PAD_ACTIONS.fire!)}
      </div>
    </div>
  );
};
