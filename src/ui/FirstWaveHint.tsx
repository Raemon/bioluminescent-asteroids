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
//       holds 2s then advances to stage 4.
//   4 — "Become one with the Pulsar" — bottom half; fades in, holds 3s, fades
//       out, then dismisses the tutorial.
//   0 — hidden.
//
// Styling matches the #overlay h1 title — Space Grotesk 700, mixed case, wide
// tracking, scaleX squish, cyan with a blue glow — sized down to a medium
// prompt that doesn't compete with the actual title.

type Stage = 0 | 1 | 2 | 3 | 4;

const FADE_MS = 1000;
const INTERSTITIAL_MS = 300;
const STAGE_3_HOLD_MS = 3000;
const STAGE_4_HOLD_MS = 3000;

export const FirstWaveHint = () => {
  // `displayStage` is what's currently mounted; `targetStage` is what the
  //   game wants. They diverge during the fade-out window so the previous
  //   text can leave before the next one arrives.
  const [displayStage, setDisplayStage] = useState<Stage>(0);
  const [targetStage, setTargetStage] = useState<Stage>(0);
  const [visible, setVisible] = useState(false);
  // stage-2 sub-line ("Use your targeting tools to help") reveals only after
  //   the player lands one on-beat fire while stage 2 is up. Game-side fires
  //   "first-wave-hint:sub" to flip this on; stage transitions reset it.
  const [subVisible, setSubVisible] = useState(false);
  const [subMounted, setSubMounted] = useState(false);
  // stage-1 progress: how many on-beat fires the player has banked (0-3).
  //   Drives the three diamond pips under the first tooltip.
  const [progress, setProgress] = useState(0);
  // stage-2 progress: how many on-beat *hits* the player has banked (0-3).
  //   Drives the three diamond pips under stage 2's main line. The
  //   "(Use your targeting tools to help)" sub-line is independent — it
  //   reveals on the first on-beat fire (subVisible/subMounted above).
  const [hitProgress, setHitProgress] = useState(0);
  // stage-3 only starts its 3s hold + fade once the game signals readiness
  //   (player at ≥3x rhythm). Until then it sits at full opacity indefinitely.
  const [stage3Ready, setStage3Ready] = useState(false);
  // stage-3 diamond row mirrors the player's current rhythm count (0-3).
  const [rhythmProgress, setRhythmProgress] = useState(0);
  const timeoutsRef = useRef<number[]>([]);
  const subTimeoutsRef = useRef<number[]>([]);

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
      // any stage change clears the stage-3 readiness latch; it re-arms
      //   only when the game next dispatches stage3Ready while at stage 3.
      setStage3Ready(false);
    };
    const onSub = (e: Event) => {
      const detail = (e as CustomEvent<{ visible: boolean }>).detail;
      if (detail.visible) {
        setSubMounted(true);
        // resting opacity 0 frame before the transition, same trick as the
        //   main stage fade-in.
        const id = window.setTimeout(() => setSubVisible(true), 32);
        subTimeoutsRef.current.push(id);
      } else {
        setSubVisible(false);
        const id = window.setTimeout(() => setSubMounted(false), FADE_MS);
        subTimeoutsRef.current.push(id);
      }
    };
    const onProgress = (e: Event) => {
      const detail = (e as CustomEvent<{ count: number }>).detail;
      setProgress(detail.count);
    };
    const onHitProgress = (e: Event) => {
      const detail = (e as CustomEvent<{ count: number }>).detail;
      setHitProgress(detail.count);
    };
    const onStage3Ready = () => setStage3Ready(true);
    const onRhythmProgress = (e: Event) => {
      const detail = (e as CustomEvent<{ count: number }>).detail;
      setRhythmProgress(detail.count);
    };
    window.addEventListener("first-wave-hint:stage", onStage as EventListener);
    window.addEventListener("first-wave-hint:sub", onSub as EventListener);
    window.addEventListener("first-wave-hint:progress", onProgress as EventListener);
    window.addEventListener("first-wave-hint:hitProgress", onHitProgress as EventListener);
    window.addEventListener("first-wave-hint:stage3Ready", onStage3Ready);
    window.addEventListener("first-wave-hint:rhythmProgress", onRhythmProgress as EventListener);
    return () => {
      window.removeEventListener("first-wave-hint:stage", onStage as EventListener);
      window.removeEventListener("first-wave-hint:sub", onSub as EventListener);
      window.removeEventListener("first-wave-hint:progress", onProgress as EventListener);
      window.removeEventListener("first-wave-hint:hitProgress", onHitProgress as EventListener);
      window.removeEventListener("first-wave-hint:stage3Ready", onStage3Ready);
      window.removeEventListener("first-wave-hint:rhythmProgress", onRhythmProgress as EventListener);
      clearPending();
      for (const id of subTimeoutsRef.current) window.clearTimeout(id);
      subTimeoutsRef.current = [];
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

  // stage 3 auto-advances to stage 4 ("Become one with the Pulsar") 3 seconds
  //   after the game signals stage3Ready (player at ≥3x rhythm). If they enter
  //   stage 3 already at 3x, the signal fires immediately and the hold + fade
  //   start right away; otherwise stage 3 hangs at full opacity until the next
  //   on-beat hit crosses them back to 3x.
  useEffect(() => {
    if (displayStage !== 3 || !visible || !stage3Ready) return;
    const holdId = window.setTimeout(() => setVisible(false), STAGE_3_HOLD_MS);
    const advanceId = window.setTimeout(() => {
      // game-side listener calls setFirstWaveHintStage(4), which keeps
      //   game.firstWaveHintStage in sync and re-dispatches the stage event.
      window.dispatchEvent(new CustomEvent("first-wave-hint:advance"));
    }, STAGE_3_HOLD_MS + FADE_MS);
    return () => {
      window.clearTimeout(holdId);
      window.clearTimeout(advanceId);
    };
  }, [displayStage, visible, stage3Ready]);

  // stage 4 is the closing flourish — fades in, holds for 3s, fades out, then
  //   dismisses the tutorial entirely.
  useEffect(() => {
    if (displayStage !== 4 || !visible) return;
    const holdId = window.setTimeout(() => setVisible(false), STAGE_4_HOLD_MS);
    const clearId = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("first-wave-hint:dismiss"));
    }, STAGE_4_HOLD_MS + FADE_MS);
    return () => {
      window.clearTimeout(holdId);
      window.clearTimeout(clearId);
    };
  }, [displayStage, visible]);

  if (displayStage === 0) return null;

  // stage 1 lives above the ship; stages 2, 3, and 4 share the lower-third slot.
  const slot = displayStage === 1 ? "top" : "bottom";

  return (
    <div
      className={`first-wave-hint first-wave-hint--${slot} ${visible ? "visible" : ""}`}
      aria-live="polite"
    >
      {displayStage === 1 && (
        <>
          <div className="first-wave-hint__line">
            Fire on the beat<br />to deal more damage
          </div>
          <div className="first-wave-hint__pips" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`first-wave-hint__pip ${i < progress ? "filled" : ""}`}
              />
            ))}
          </div>
        </>
      )}
      {displayStage === 2 && (
        <>
          <div className="first-wave-hint__line">
            Fire <span className="first-wave-hint__accent">and hit</span> on the beat<br />to build rhythm
          </div>
          <div className="first-wave-hint__pips" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`first-wave-hint__pip ${i < hitProgress ? "filled" : ""}`}
              />
            ))}
          </div>
          {subMounted && (
            <div className={`mt-8 first-wave-hint__sub ${subVisible ? "visible" : ""}`}>
              (Use your targeting tools to help)
            </div>
          )}
        </>
      )}
      {displayStage === 3 && (
        <>
          <div className="first-wave-hint__line">
            <span className="first-wave-hint__accent">Build rhythm</span> without missing a beat.
            <div className="first-wave-hint__pips" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`first-wave-hint__pip ${i < rhythmProgress ? "filled" : ""}`}
              />
            ))}
          </div>
            <div className={`first-wave-hint__sub visible`}>
              (Use your targeting tools to help)
            </div>
          </div>
        </>
      )}
      {displayStage === 4 && (
        <div className="first-wave-hint__line">
          Become one with the <span className="first-wave-hint__accent">Pulsar</span>
        </div>
      )}
    </div>
  );
};
