import { useEffect, useRef, useState } from "react";

// Tutorial stage 1 — Controls. Shows the movement controls and fades each one to
//   low opacity as the player uses it (driven by the game's `tutorial:controls`
//   event). The game advances to stage 2 once all three are used, which fades the
//   whole hint out.

type Controls = { rotate: boolean; thrust: boolean; back: boolean };
const FADE_MS = 800;

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
    const onStage = (e: Event) => {
      const stage = (e as CustomEvent<{ stage: number }>).detail.stage;
      if (stage === 1) {
        setUsed({ rotate: false, thrust: false, back: false });
        setMounted(true);
        schedule(() => setVisible(true), 32);
      } else {
        setVisible(false);
        schedule(() => setMounted(false), FADE_MS);
      }
    };
    const onControls = (e: Event) => setUsed((e as CustomEvent<Controls>).detail);
    window.addEventListener("first-wave-hint:stage", onStage as EventListener);
    window.addEventListener("tutorial:controls", onControls as EventListener);
    return () => {
      window.removeEventListener("first-wave-hint:stage", onStage as EventListener);
      window.removeEventListener("tutorial:controls", onControls as EventListener);
      for (const id of timeoutsRef.current) window.clearTimeout(id);
      timeoutsRef.current = [];
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
      </div>
    </div>
  );
};
