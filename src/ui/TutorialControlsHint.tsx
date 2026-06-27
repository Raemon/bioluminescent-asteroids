import { useEffect, useRef, useState } from "react";

// each key fades as the player uses it; whole hint fades once all keys are used

type Controls = { rotate: boolean; thrust: boolean; back: boolean; side: boolean; fire: boolean };
const FADE_MS = 800;

export const TutorialControlsHint = () => {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [used, setUsed] = useState<Controls>({ rotate: false, thrust: false, back: false, side: false, fire: false });
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
      setUsed({ rotate: false, thrust: false, back: false, side: false, fire: false });
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
    const onControls = (e: Event) => setUsed((e as CustomEvent<Controls>).detail);
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
        <span className={`tch-ctrl${used.rotate ? " used" : ""}`}>
          <span className="key">←</span> <span className="key">→</span> rotate
        </span>
        <span className={`tch-ctrl${used.thrust ? " used" : ""}`}>
          <span className="key">↑</span> thrust
        </span>
        <span className={`tch-ctrl${used.back ? " used" : ""}`}>
          <span className="key">↓</span> reverse
        </span>
        <span className={`tch-ctrl${used.side ? " used" : ""}`}>
          <span className="key">Z</span> <span className="key">X</span> side thrust
        </span>
        <span className={`tch-ctrl${used.fire ? " used" : ""}`}>
          <span className="key">space</span> fire
        </span>
      </div>
    </div>
  );
};
