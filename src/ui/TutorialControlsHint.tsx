import { useEffect, useState, useRef } from "react";
import { ControlInfo } from "./ControlInfo";

type Stage = 0 | 1 | 2 | 3 | 4;

const HOLD_MS = 3000;
const FADE_MS = 1000;

export const TutorialControlsHint = () => {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const timeoutsRef = useRef<number[]>([]);

  useEffect(() => {
    const clearPending = () => {
      for (const id of timeoutsRef.current) window.clearTimeout(id);
      timeoutsRef.current = [];
    };
    const schedule = (fn: () => void, ms: number) => {
      const id = window.setTimeout(fn, ms);
      timeoutsRef.current.push(id);
    };
    const onStage = (e: Event) => {
      const detail = (e as CustomEvent<{ stage: Stage }>).detail;
      if (detail.stage !== 1) return;
      clearPending();
      setMounted(true);
      schedule(() => setVisible(true), 32);
      schedule(() => setVisible(false), 32 + HOLD_MS);
      schedule(() => setMounted(false), 32 + HOLD_MS + FADE_MS);
    };
    window.addEventListener("first-wave-hint:stage", onStage as EventListener);
    return () => {
      window.removeEventListener("first-wave-hint:stage", onStage as EventListener);
      clearPending();
    };
  }, []);

  if (!mounted) return null;
  return (
    <div className={`tutorial-controls-hint${visible ? " visible" : ""}`}>
      <ControlInfo id="tutorial-controls-hint-sub" />
    </div>
  );
};
