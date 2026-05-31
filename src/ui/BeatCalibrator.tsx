import { useEffect, useRef, useState } from "react";
import type { Sound } from "../Sound";

// Tap-to-the-beat latency calibrator. A steady metronome plays on the audio
//   clock; the player presses space with each beat. The instant a key lands we
//   read AudioContext.currentTime and compare it to the nearest scheduled click —
//   that difference is the player's timing offset, which folds in speaker /
//   Bluetooth output latency plus their own reaction. The median of the taps
//   (after dropping the ragged first couple) becomes Game.beatOffset, which
//   slides the scoring window + every visual beat cue forward so "on the beat"
//   lands where they actually hear it. See game/beatCalibration.ts.

const BEAT_PERIOD = 0.5; // 120 BPM — the game's own quarter-note grid.
const LEAD_IN_BEATS = 4; // count-in so the player can lock on before taps count.
const TARGET_TAPS = 8; // taps gathered before we finalize (6 scored after the drop).
const DROP_FIRST = 2; // discard the first couple — they're always ragged.
const START_DELAY = 0.8; // seconds of silence before the first beat.
const LOOKAHEAD = 0.18; // schedule each beat this far ahead of the audio clock.

// median is robust to the odd fumbled tap in a way the mean isn't.
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

type Phase = "idle" | "running" | "done";

export const BeatCalibrator = () => {
  const [phase, setPhase] = useState<Phase>("idle");
  const [tapCount, setTapCount] = useState(0);
  const [countIn, setCountIn] = useState(LEAD_IN_BEATS);
  const [resultMs, setResultMs] = useState(0);

  const soundRef = useRef<Sound | null>(null);
  const startAfterRef = useRef(false);
  const firstBeatRef = useRef(0);
  const nextBeatRef = useRef(0);
  const lastBeatIdxRef = useRef(-Infinity);
  const tapsRef = useRef<number[]>([]);
  const resultSecRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const pingRef = useRef<HTMLDivElement | null>(null);
  const coreRef = useRef<HTMLDivElement | null>(null);
  const runningRef = useRef(false);
  // false until the baked bgBeat is ready and the first beat is locked in — keeps
  //   the intro groove steady instead of clustering early beats during cache warmup.
  const startedRef = useRef(false);
  // mirrors `phase` so the single always-on key listener can branch without
  //   re-subscribing (re-subscribing left a gap where a focused button could
  //   steal the space press and re-trigger the calibrator).
  const phaseRef = useRef<Phase>("idle");

  const goPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  // Begin a measurement pass: capture the audio-clock origin, reset counters,
  //   and let the rAF loop schedule clicks + animate the ring from there.
  const beginRun = () => {
    const sound = soundRef.current;
    if (!sound) return;
    // drop focus off whatever button opened us so it can't grab the space taps.
    (document.activeElement as HTMLElement | null)?.blur?.();
    tapsRef.current = [];
    nextBeatRef.current = 0;
    lastBeatIdxRef.current = -Infinity;
    startedRef.current = false;
    firstBeatRef.current = 0;
    setTapCount(0);
    setCountIn(LEAD_IN_BEATS);
    setResultMs(0);
    runningRef.current = true;
    goPhase("running");
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(loop);
  };

  // single rAF: rolling beat scheduler + ring animation + count-in display.
  const loop = () => {
    const sound = soundRef.current;
    if (!sound || !runningRef.current) { rafRef.current = null; return; }
    const now = sound.currentAudioTime();
    // Hold the intro until the baked bgBeat is ready, then lock the timeline to a
    //   steady downbeat so warmup can't cluster the first beats.
    if (!startedRef.current) {
      const t0 = now + START_DELAY;
      if (sound.scheduleCalibrationBeat(t0, false)) {
        firstBeatRef.current = t0;
        nextBeatRef.current = 1;
        startedRef.current = true;
      }
      rafRef.current = requestAnimationFrame(loop);
      return;
    }
    const first = firstBeatRef.current;
    while (first + nextBeatRef.current * BEAT_PERIOD <= now + LOOKAHEAD) {
      const k = nextBeatRef.current;
      // alternate downbeat / offbeat pitch like tickBgBeats does for quarters.
      sound.scheduleCalibrationBeat(first + k * BEAT_PERIOD, k % 2 === 1);
      nextBeatRef.current += 1;
    }
    const beatsElapsed = (now - first) / BEAT_PERIOD;
    const idx = Math.floor(beatsElapsed);
    if (idx !== lastBeatIdxRef.current) {
      lastBeatIdxRef.current = idx;
      const remaining = LEAD_IN_BEATS - Math.max(0, idx);
      setCountIn(idx < LEAD_IN_BEATS ? Math.max(1, remaining) : 0);
    }
    // frac: 0 at the beat onset → 1 just before the next. The ping ring expands
    //   outward and fades (sonar ping); the core dot flashes bright then settles.
    const frac = idx >= 0 ? beatsElapsed - idx : 1;
    const ping = pingRef.current;
    if (ping) {
      ping.style.transform = `scale(${(0.5 + 0.62 * frac).toFixed(3)})`;
      ping.style.opacity = (idx >= 0 ? Math.pow(1 - frac, 1.7) : 0).toFixed(3);
    }
    const core = coreRef.current;
    if (core) {
      const env = idx >= 0 ? (1 - frac) * (1 - frac) : 0;
      core.style.transform = `scale(${(1 + 0.55 * env).toFixed(3)})`;
      core.style.opacity = (0.5 + 0.5 * env).toFixed(3);
    }
    rafRef.current = requestAnimationFrame(loop);
  };

  const stopLoop = () => {
    runningRef.current = false;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  // a tap is scored against the nearest scheduled click; lead-in taps are ignored.
  const registerTap = () => {
    const sound = soundRef.current;
    if (!sound || !runningRef.current || !startedRef.current) return;
    const now = sound.currentAudioTime();
    // soft pluck so each tap feels like firing, not clicking a button.
    sound.playCalibrationTap();
    const idx = Math.round((now - firstBeatRef.current) / BEAT_PERIOD);
    if (idx < LEAD_IN_BEATS) return;
    const offset = now - (firstBeatRef.current + idx * BEAT_PERIOD);
    tapsRef.current.push(offset);
    setTapCount(tapsRef.current.length);
    if (tapsRef.current.length >= TARGET_TAPS) finalize();
  };

  const finalize = () => {
    stopLoop();
    // settle the ping out and rest the core at a calm steady glow for the result view.
    if (pingRef.current) pingRef.current.style.opacity = "0";
    if (coreRef.current) {
      coreRef.current.style.transform = "scale(1)";
      coreRef.current.style.opacity = "0.95";
    }
    const scored = tapsRef.current.slice(DROP_FIRST);
    const med = scored.length ? median(scored) : 0;
    resultSecRef.current = med;
    setResultMs(Math.round(med * 1000));
    goPhase("done");
  };

  const close = () => {
    stopLoop();
    goPhase("idle");
  };

  const finishWith = (offsetSec: number) => {
    window.dispatchEvent(
      new CustomEvent("beat-calibrator:done", {
        detail: { offsetSec, startAfter: startAfterRef.current },
      }),
    );
    close();
  };

  const cancel = () => {
    window.dispatchEvent(new CustomEvent("beat-calibrator:cancel"));
    close();
  };

  // Esc (key or button) always backs out to the title without saving or
  //   starting — same from the first-run gate or the title's recalibrate link.
  const exitToHome = () => {
    cancel();
  };

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sound: Sound; startAfter: boolean };
      soundRef.current = detail.sound;
      startAfterRef.current = !!detail.startAfter;
      beginRun();
    };
    // Attached once for the component's life: space/escape are fully owned here
    //   (always preventDefault'd) so no focused button can hijack a tap.
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current === "idle") return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        exitToHome();
        return;
      }
      // Return / Enter confirms the result and continues to the next screen.
      if (e.key === "Enter") {
        if (phaseRef.current === "done") {
          e.preventDefault();
          e.stopPropagation();
          finishWith(resultSecRef.current);
        }
        return;
      }
      if (e.code === "Space" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        e.stopPropagation();
        if (phaseRef.current === "running") registerTap();
        else if (phaseRef.current === "done") finishWith(resultSecRef.current);
      }
    };
    window.addEventListener("beat-calibrator:open", onOpen);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("beat-calibrator:open", onOpen);
      document.removeEventListener("keydown", onKey, true);
      stopLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "idle") return null;

  const tapPips = Array.from({ length: TARGET_TAPS });

  return (
    <div id="beat-calibrator">
      <div className="cal-inner">
        <h2 className="cal-title">Sync to the Beat</h2>
        <div
          className={`cal-ring-wrap${phase === "done" ? " is-done" : ""}`}
          onClick={phase === "running" ? registerTap : undefined}
        >
          <div className="cal-guide" />
          <div className="cal-ping" ref={pingRef} />
          <div className="cal-core" ref={coreRef} />
          {phase === "done" && (
            <span className="cal-result-ms">
              {resultMs >= 0 ? "+" : "−"}{Math.abs(resultMs)}<small>ms</small>
            </span>
          )}
        </div>

        {phase === "running" && (
          <>
            <p className="cal-instruction">
              press <span className="key">space</span> with the beat
            </p>
            <p className="cal-sub">{countIn > 0 ? "listen — get ready…" : "tap the moment you hear each pulse"}</p>
            <div className="cal-progress">
              {tapPips.map((_, i) => (
                <span key={i} className={i < tapCount ? "cal-pip on" : "cal-pip"} />
              ))}
            </div>
            <button type="button" className="cal-skip" onClick={exitToHome}>
              Esc
            </button>
          </>
        )}

        {phase === "done" && (
          <>
            <p className="cal-sub cal-verdict">
              {Math.abs(resultMs) < 25
                ? "you're right on the grid — nicely in time."
                : resultMs > 0
                  ? "your taps land late — we'll bring the beat to your ears."
                  : "your taps land early — we'll bring the beat to meet you."}
            </p>
            <div className="cal-actions">
              <button type="button" className="cal-primary" onClick={() => finishWith(resultSecRef.current)}>
                {startAfterRef.current ? "begin" : "save"}
              </button>
              <button type="button" className="cal-redo" onClick={beginRun}>
                redo
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
