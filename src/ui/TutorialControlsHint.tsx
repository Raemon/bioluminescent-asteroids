import { useEffect, useRef, useState } from "react";

// Controls hint shown at the start of every run. In tutorial mode it sticks
//   until rotate+thrust+back are all used (the game advances to stage 2 then);
//   in normal mode it fades in on game start and auto-dismisses on a timer.
// The fade-as-used keys are driven by the game's `tutorial:controls` event,
//   which only fires during the tutorial controls gate.

type Controls = { rotate: boolean; thrust: boolean; back: boolean };
const FADE_MS = 800;
const AUTO_DISMISS_MS = 6500;

export const TutorialControlsHint = () => {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [used, setUsed] = useState<Controls>({ rotate: false, thrust: false, back: false });
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
    const show = (autoDismiss: boolean) => {
      clearAll();
      setUsed({ rotate: false, thrust: false, back: false });
      setMounted(true);
      schedule(() => setVisible(true), 32);
      if (autoDismiss) {
        schedule(() => setVisible(false), AUTO_DISMISS_MS);
        schedule(() => setMounted(false), AUTO_DISMISS_MS + FADE_MS);
      }
    };
    const hide = () => {
      setVisible(false);
      schedule(() => setMounted(false), FADE_MS);
    };
    const onStage = (e: Event) => {
      const stage = (e as CustomEvent<{ stage: number }>).detail.stage;
      if (stage === 1) show(false);
      else hide();
    };
    const onShow = () => show(true);
    const onControls = (e: Event) => setUsed((e as CustomEvent<Controls>).detail);
    window.addEventListener("first-wave-hint:stage", onStage as EventListener);
    window.addEventListener("controls-hint:show", onShow as EventListener);
    window.addEventListener("tutorial:controls", onControls as EventListener);
    return () => {
      window.removeEventListener("first-wave-hint:stage", onStage as EventListener);
      window.removeEventListener("controls-hint:show", onShow as EventListener);
      window.removeEventListener("tutorial:controls", onControls as EventListener);
      clearAll();
    };
  }, []);

  if (!mounted) return null;
  return (
    <div className={`tutorial-controls-hint${visible ? " visible" : ""}`}>
      <p className="tutorial-controls-hint__title">Get a feel for the controls</p>
      <div className="tutorial-controls-hint__keys">
        <span className={`tch-ctrl${used.rotate ? " used" : ""}`}>
          <span className="key">←</span> <span className="key">→</span> rotate
        </span>
        <span className={`tch-ctrl${used.thrust ? " used" : ""}`}>
          <span className="key">↑</span> thrust
        </span>
        <span className={`tch-ctrl${used.back ? " used" : ""}`}>
          <span className="key">↓</span> reverse
        </span>
        <span className="tch-ctrl">
          <span className="key">Z</span> <span className="key">X</span> side thrust
        </span>
      </div>
    </div>
  );
};
