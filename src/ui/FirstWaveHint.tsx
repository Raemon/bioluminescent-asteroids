import { useEffect, useRef, useState } from "react";

// later-stage tutorial overlay; stage owned by lifecycle.ts→setFirstWaveHintStage,
// this component just runs the fade + auto-dismiss timers

type Stage = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const FADE_MS = 1000;
const INTERSTITIAL_MS = 300;
const STAGE_5_HOLD_MS = 3000;
const STAGE_6_HOLD_MS = 3000;

// stages 0 and 1 render nothing in this component (1 is the controls hint).
const hidden = (s: Stage) => s === 0 || s === 1;

export const FirstWaveHint = () => {
  const [displayStage, setDisplayStage] = useState<Stage>(0);
  const [targetStage, setTargetStage] = useState<Stage>(0);
  const [visible, setVisible] = useState(false);
  const [subVisible, setSubVisible] = useState(false);
  const [subMounted, setSubMounted] = useState(false);
  const [progress, setProgress] = useState(0); // stage 2: on-beat fires (0-3)
  const [hitProgress, setHitProgress] = useState(0); // stage 4: on-beat hits (0-3)
  const [stageReady, setStageReady] = useState(false); // stage 5: player reached 4x
  const [rhythmProgress, setRhythmProgress] = useState(0); // stage 5 diamonds (0-3)
  const [hoverProgress, setHoverProgress] = useState(0); // stage 3 circle fill (0-1)
  const timeoutsRef = useRef<number[]>([]);
  const subTimeoutsRef = useRef<number[]>([]);

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
      setTargetStage((e as CustomEvent<{ stage: Stage }>).detail.stage);
      setStageReady(false);
    };
    const onSub = (e: Event) => {
      const detail = (e as CustomEvent<{ visible: boolean }>).detail;
      if (detail.visible) {
        setSubMounted(true);
        const id = window.setTimeout(() => setSubVisible(true), 32);
        subTimeoutsRef.current.push(id);
      } else {
        setSubVisible(false);
        const id = window.setTimeout(() => setSubMounted(false), FADE_MS);
        subTimeoutsRef.current.push(id);
      }
    };
    const onProgress = (e: Event) => setProgress((e as CustomEvent<{ count: number }>).detail.count);
    const onHitProgress = (e: Event) => setHitProgress((e as CustomEvent<{ count: number }>).detail.count);
    const onStageReady = () => setStageReady(true);
    const onRhythmProgress = (e: Event) => setRhythmProgress((e as CustomEvent<{ count: number }>).detail.count);
    const onHoverProgress = (e: Event) => setHoverProgress((e as CustomEvent<{ value: number }>).detail.value);
    window.addEventListener("first-wave-hint:stage", onStage as EventListener);
    window.addEventListener("first-wave-hint:sub", onSub as EventListener);
    window.addEventListener("first-wave-hint:progress", onProgress as EventListener);
    window.addEventListener("first-wave-hint:hitProgress", onHitProgress as EventListener);
    window.addEventListener("first-wave-hint:stage3Ready", onStageReady);
    window.addEventListener("first-wave-hint:rhythmProgress", onRhythmProgress as EventListener);
    window.addEventListener("tutorial:hoverProgress", onHoverProgress as EventListener);
    return () => {
      window.removeEventListener("first-wave-hint:stage", onStage as EventListener);
      window.removeEventListener("first-wave-hint:sub", onSub as EventListener);
      window.removeEventListener("first-wave-hint:progress", onProgress as EventListener);
      window.removeEventListener("first-wave-hint:hitProgress", onHitProgress as EventListener);
      window.removeEventListener("first-wave-hint:stage3Ready", onStageReady);
      window.removeEventListener("first-wave-hint:rhythmProgress", onRhythmProgress as EventListener);
      window.removeEventListener("tutorial:hoverProgress", onHoverProgress as EventListener);
      clearPending();
      for (const id of subTimeoutsRef.current) window.clearTimeout(id);
      subTimeoutsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (targetStage === displayStage) return;
    clearPending();
    if (hidden(displayStage)) {
      setDisplayStage(targetStage);
      schedule(() => setVisible(true), 32);
      return;
    }
    setVisible(false);
    schedule(() => {
      setDisplayStage(targetStage);
      if (!hidden(targetStage)) schedule(() => setVisible(true), 32);
    }, FADE_MS + INTERSTITIAL_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetStage]);

  // stage 5 (build to 4x) auto-advances to stage 6 once the game signals 4x reached.
  useEffect(() => {
    if (displayStage !== 5 || !visible || !stageReady) return;
    const holdId = window.setTimeout(() => setVisible(false), STAGE_5_HOLD_MS);
    const advanceId = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("first-wave-hint:advance"));
    }, STAGE_5_HOLD_MS + FADE_MS);
    return () => { window.clearTimeout(holdId); window.clearTimeout(advanceId); };
  }, [displayStage, visible, stageReady]);

  // stage 6 closing flourish — fades in, holds, fades out, dismisses the tutorial.
  useEffect(() => {
    if (displayStage !== 6 || !visible) return;
    const holdId = window.setTimeout(() => setVisible(false), STAGE_6_HOLD_MS);
    const clearId = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("first-wave-hint:dismiss"));
    }, STAGE_6_HOLD_MS + FADE_MS);
    return () => { window.clearTimeout(holdId); window.clearTimeout(clearId); };
  }, [displayStage, visible]);

  if (hidden(displayStage)) return null;

  const slot = displayStage === 2 ? "top" : "bottom";

  return (
    <div
      className={`first-wave-hint first-wave-hint--${slot} ${visible ? "visible" : ""}`}
      aria-live="polite"
    >
      {displayStage === 2 && (
        <>
          <div className="first-wave-hint__line">
            Fire on the beat<br />to deal more damage
          </div>
          <div className="first-wave-hint__pips" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span key={i} className={`first-wave-hint__pip ${i < progress ? "filled" : ""}`} />
            ))}
          </div>
        </>
      )}
      {displayStage === 3 && (
        <>
          <div className="first-wave-hint__line">Drift alongside the asteroids</div>
          <div
            className="first-wave-hint__circle"
            style={{ ["--p" as string]: hoverProgress }}
            aria-hidden="true"
          >
            <div className="first-wave-hint__circle-core" />
          </div>
          <div className="first-wave-hint__line first-wave-hint__line--sub">
            Hold your reticule over<br />the target for one second
          </div>
          <div className="first-wave-hint__sub visible">
            (You can use backthrusters to help)
          </div>
        </>
      )}
      {displayStage === 4 && (
        <>
          <div className="first-wave-hint__line">
            Fire <span className="first-wave-hint__accent">(and hit)</span> on the beat<br />to build rhythm
          </div>
          <div className="first-wave-hint__pips" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span key={i} className={`first-wave-hint__pip ${i < hitProgress ? "filled" : ""}`} />
            ))}
          </div>
          {subMounted && (
            <div className={`mt-8 first-wave-hint__sub ${subVisible ? "visible" : ""}`}>
              Aim for the asteroid target.
            </div>
          )}
        </>
      )}
      {displayStage === 5 && (
        <div className="first-wave-hint__line">
          <span className="first-wave-hint__accent">Build rhythm</span> without missing a beat.
          <div className="first-wave-hint__pips" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span key={i} className={`first-wave-hint__pip ${i < rhythmProgress ? "filled" : ""}`} />
            ))}
          </div>
          <div className="first-wave-hint__sub visible">
            <div>Match your target's velocity, and use your targeting tools.</div>
          </div>
        </div>
      )}
      {displayStage === 6 && (
        <div className="first-wave-hint__line">
          Become one with the <span className="first-wave-hint__accent">Pulsar</span>
        </div>
      )}
    </div>
  );
};
