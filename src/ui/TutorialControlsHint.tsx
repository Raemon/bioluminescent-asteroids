import { Fragment, useEffect, useRef, useState } from "react";
import { TUTORIAL_CONTROLS, emptyTutorialControlsUsed, type TutorialControlsUsed } from "../game/controlBindings";

// each key glyph fades as the player presses it; whole hint fades once all keys are used

const FADE_MS = 800;

export const TutorialControlsHint = () => {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [used, setUsed] = useState<TutorialControlsUsed>(emptyTutorialControlsUsed);
  const timeoutsRef = useRef<number[]>([]);

  useEffect(() => {
    const schedule = (fn: () => void, ms: number) => {
      const id = window.setTimeout(fn, ms);
      timeoutsRef.current.push(id);
    };
    const clearAll = () => {
      for (const id of timeoutsRef.current) window.clearTimeout(id);
      timeoutsRef.current = [];
    };
    const show = () => {
      clearAll();
      setUsed(emptyTutorialControlsUsed());
      setMounted(true);
      schedule(() => setVisible(true), 32);
    };
    const hide = () => {
      setVisible(false);
      schedule(() => setMounted(false), FADE_MS);
    };
    const onStage = (e: Event) => {
      const stage = (e as CustomEvent<{ stage: number }>).detail.stage;
      if (stage === 1) show();
      else hide();
    };
    const onShow = () => show();
    const onDismiss = () => hide();
    const onControls = (e: Event) => setUsed((e as CustomEvent<TutorialControlsUsed>).detail);
    window.addEventListener("first-wave-hint:stage", onStage as EventListener);
    window.addEventListener("controls-hint:show", onShow as EventListener);
    window.addEventListener("controls-hint:dismiss", onDismiss as EventListener);
    window.addEventListener("tutorial:controls", onControls as EventListener);
    return () => {
      window.removeEventListener("first-wave-hint:stage", onStage as EventListener);
      window.removeEventListener("controls-hint:show", onShow as EventListener);
      window.removeEventListener("controls-hint:dismiss", onDismiss as EventListener);
      window.removeEventListener("tutorial:controls", onControls as EventListener);
      clearAll();
    };
  }, []);

  if (!mounted) return null;
  return (
    <div className={`tutorial-controls-hint${visible ? " visible" : ""}`}>
      <div className="tutorial-controls-hint__keys">
        {TUTORIAL_CONTROLS.map((ctrl) => {
          const rowUsed = ctrl.keys.every((k) => used[k.action]);
          return (
            <span key={ctrl.label} className={`tch-ctrl${rowUsed ? " used" : ""}`}>
              {ctrl.keys.map((k, i) => (
                <Fragment key={k.action}>
                  {i > 0 ? " " : ""}
                  <span className={`key${used[k.action] ? " used" : ""}`}>{k.glyph}</span>
                </Fragment>
              ))}{" "}
              {ctrl.label}
            </span>
          );
        })}
      </div>
    </div>
  );
};
