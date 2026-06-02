import { useEffect, useRef, useState } from "react";

// Bottom-middle hint shown once per game, on the first meaningful rhythm loss
// outside the tutorial. Game side (rhythmGate.loseCombo) fires
// `rhythm-loss-hint:show`; killEffects fires `:dismiss` on the next on-beat hit.
const FADE_MS = 800;

export const RhythmLossHint = () => {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
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
      setMounted(true);
      schedule(() => setVisible(true), 32);
    };
    const hide = () => {
      setVisible(false);
      schedule(() => setMounted(false), FADE_MS);
    };
    window.addEventListener("rhythm-loss-hint:show", show);
    window.addEventListener("rhythm-loss-hint:dismiss", hide);
    return () => {
      window.removeEventListener("rhythm-loss-hint:show", show);
      window.removeEventListener("rhythm-loss-hint:dismiss", hide);
      clearAll();
    };
  }, []);

  if (!mounted) return null;
  return (
    <div className={`first-wave-hint rhythm-loss-hint${visible ? " visible" : ""}`}>
      <div className="first-wave-hint__line">
        Fire <span className="first-wave-hint__accent">and hit</span> on the beat
      </div>
    </div>
  );
};
