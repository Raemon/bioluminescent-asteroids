import { useEffect, useRef, useState } from "react";

// Wave-1 tutorial overlay. The game-side state machine
// (src/game/lifecycle.ts → setFirstWaveHintStage) owns the stage number and
// dispatches "first-wave-hint:stage" whenever it changes; this component owns
// the cinematic fade transitions and the stage-3 auto-dismiss timer.
//
// Cinematic flow:
//   target stage changes → current stage fades out (1s) → beat of darkness →
//   new stage fades in (1s) at its assigned slot.
//
// Stages:
//   1 — "Fire on the beat to deal more damage" — above the ship (top half).
//       Held until 3 on-beat fires land.
//   2 — "Fire and hit on the beat to build rhythm" + "Use your targeting
//       tools to help" — bottom half of the screen, appears only after stage 1
//       has fully faded out. Held until 4x rhythm.
//   3 — "Rhythm gives you dramatically more points" — bottom half, gold;
//       holds 2s then fades away.
//   0 — hidden.
//
// Styling matches the #overlay h1 title — Space Grotesk 700, mixed case, wide
// tracking, scaleX squish, cyan with a blue glow — sized down to a medium
// prompt that doesn't compete with the actual title.

type Stage = 0 | 1 | 2 | 3;

const FADE_MS = 1000;
const INTERSTITIAL_MS = 300;
const STAGE_3_HOLD_MS = 2000;

export const FirstWaveHint = () => {
  // `displayStage` is what's currently mounted; `targetStage` is what the
  //   game wants. They diverge during the fade-out window so the previous
  //   text can leave before the next one arrives.
  const [displayStage, setDisplayStage] = useState<Stage>(0);
  const [targetStage, setTargetStage] = useState<Stage>(0);
  const [visible, setVisible] = useState(false);
  const timeoutsRef = useRef<number[]>([]);

  // single bucket for all pending fade/swap timers so a rapid target change
  //   (or unmount) cancels everything cleanly.
  const clearPending = () => {
    for (const id of timeoutsRef.current) window.clearTimeout(id);
    timeoutsRef.current = [];
  };
  const schedule = (fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timeoutsRef.current.push(id);
  };

  useEffect(() => {
    const onStage = (e: Event) => {
      const detail = (e as CustomEvent<{ stage: Stage }>).detail;
      setTargetStage(detail.stage);
    };
    window.addEventListener("first-wave-hint:stage", onStage as EventListener);
    return () => {
      window.removeEventListener("first-wave-hint:stage", onStage as EventListener);
      clearPending();
    };
  }, []);

  // Drive transitions when the target changes. Each branch owns its own
  //   timeline so the sequencing reads top-to-bottom.
  // Only react to *target* changes — re-running when displayStage settles
  //   would cancel the fade-in timer we just scheduled. We read displayStage
  //   imperatively against the latest committed value to make the right
  //   first-appearance vs. swap branch decision.
  useEffect(() => {
    if (targetStage === displayStage) return;
    clearPending();
    if (displayStage === 0) {
      setDisplayStage(targetStage);
      // small delay so the browser sees opacity 0 commit before the transition
      //   to opacity 1; otherwise it skips the transition entirely.
      schedule(() => setVisible(true), 32);
      return;
    }
    // fade the current stage out, then after an interstitial swap the new one in.
    setVisible(false);
    schedule(() => {
      setDisplayStage(targetStage);
      if (targetStage === 0) return;
      schedule(() => setVisible(true), 32);
    }, FADE_MS + INTERSTITIAL_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetStage]);

  // stage 3 auto-dismisses after a brief hold. game-side keeps stage at 3
  //   throughout; React just fades it out and tells the game to clear.
  useEffect(() => {
    if (displayStage !== 3 || !visible) return;
    const holdId = window.setTimeout(() => setVisible(false), STAGE_3_HOLD_MS);
    const clearId = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("first-wave-hint:dismiss"));
    }, STAGE_3_HOLD_MS + FADE_MS);
    return () => {
      window.clearTimeout(holdId);
      window.clearTimeout(clearId);
    };
  }, [displayStage, visible]);

  if (displayStage === 0) return null;

  // stage 1 lives above the ship; stages 2 and 3 share the lower-third slot.
  const slot = displayStage === 1 ? "top" : "bottom";

  return (
    <div
      className={`first-wave-hint first-wave-hint--${slot} ${visible ? "visible" : ""}`}
      aria-live="polite"
    >
      {displayStage === 1 && (
        <div className="first-wave-hint__line">
          Fire on the beat<br />to deal more damage
        </div>
      )}
      {displayStage === 2 && (
        <>
          <div className="first-wave-hint__line">
            Fire <span className="first-wave-hint__accent">and hit</span> on the beat<br />to build rhythm
          </div>
          <div className="first-wave-hint__sub">
            Use your targeting tools to help
          </div>
        </>
      )}
      {displayStage === 3 && (
        <div className="first-wave-hint__line first-wave-hint__line--accent">
          Rhythm gives you dramatically more points
        </div>
      )}
    </div>
  );
};
