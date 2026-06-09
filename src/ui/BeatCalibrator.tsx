import { useEffect, useRef, useState } from "react";
import type { Sound } from "../Sound";
import { isTouchDevice } from "./touch";

// Rhythm practice + latency calibrator. The player taps space on every beat;
//   once they're consistent (a streak of beats landing at a steady offset, one
//   tap per beat) the screen fades and play begins. Two modes:
//   - intro (first run): the *game's own beat* plays (the run has started behind
//     the overlay), so the pulse carries seamlessly into live play. Taps are
//     measured against game.beatTime.
//   - standalone (settings "Resync the beat"): the calibrator schedules its own
//     bgBeat and measures against the audio clock — there's no run to fold into.
//   Either way the streak's median offset becomes Game.beatOffset, which slides
//   the scoring window + visual cues onto the beat the player actually hears.

const BEAT_PERIOD = 0.5; // game's quarter-note grid
const STREAK_TARGET = 8; // consecutive on-beat taps required (two bars of 4)
const STREAK_TOLERANCE = 0.1; // tap tolerance around the streak's running median
const GAP_MIN = 0.3; // inter-tap gap floor — rejects double-taps
const GAP_MAX = 0.8; // inter-tap gap ceiling — a skipped beat breaks the streak
const START_DELAY = 0.8; // standalone: silence before the first scheduled beat
const LOOKAHEAD = 0.18; // standalone: schedule each beat this far ahead
const FADE_MS = 650; // overlay fade-out as the world comes alive

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const getGameBeatTime = (): number | null => {
  const g = (window as unknown as { __game?: { beatTime: number } }).__game;
  return g ? g.beatTime : null;
};

type Phase = "idle" | "running" | "fading";

export const BeatCalibrator = () => {
  const [phase, setPhase] = useState<Phase>("idle");
  const [streak, setStreak] = useState(0);
  const touch = isTouchDevice();

  const soundRef = useRef<Sound | null>(null);
  const introRef = useRef(false);
  const originRef = useRef<"intro" | "settings">("intro");
  const streakRef = useRef<number[]>([]);
  const lastTapRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const pingRef = useRef<HTMLDivElement | null>(null);
  const coreRef = useRef<HTMLDivElement | null>(null);
  const runningRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  // standalone-mode beat scheduling state (unused in intro mode).
  const firstBeatRef = useRef(0);
  const nextBeatRef = useRef(0);
  const startedRef = useRef(false);

  const goPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const beginRun = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    streakRef.current = [];
    lastTapRef.current = null;
    setStreak(0);
    startedRef.current = false;
    firstBeatRef.current = 0;
    nextBeatRef.current = 0;
    runningRef.current = true;
    goPhase("running");
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(loop);
  };

  const animateRing = (frac: number, active: boolean) => {
    const ping = pingRef.current;
    if (ping) {
      ping.style.transform = `scale(${(0.5 + 0.62 * frac).toFixed(3)})`;
      ping.style.opacity = (active ? Math.pow(1 - frac, 1.7) : 0).toFixed(3);
    }
    const core = coreRef.current;
    if (core) {
      const env = active ? (1 - frac) * (1 - frac) : 0;
      core.style.transform = `scale(${(1 + 0.55 * env).toFixed(3)})`;
      core.style.opacity = (0.5 + 0.5 * env).toFixed(3);
    }
  };

  // rAF: in intro mode just animate the ring off the game's beat; in standalone
  //   mode also run the rolling scheduler for the calibrator's own bgBeat.
  const loop = () => {
    if (!runningRef.current) { rafRef.current = null; return; }
    if (introRef.current) {
      const bt = getGameBeatTime() ?? 0;
      const frac = (((bt % BEAT_PERIOD) + BEAT_PERIOD) % BEAT_PERIOD) / BEAT_PERIOD;
      animateRing(frac, true);
    } else {
      const sound = soundRef.current;
      if (sound) {
        const now = sound.currentAudioTime();
        if (!startedRef.current) {
          const t0 = now + START_DELAY;
          if (sound.scheduleCalibrationBeat(t0, false)) {
            firstBeatRef.current = t0;
            nextBeatRef.current = 1;
            startedRef.current = true;
          }
        } else {
          const first = firstBeatRef.current;
          while (first + nextBeatRef.current * BEAT_PERIOD <= now + LOOKAHEAD) {
            sound.scheduleCalibrationBeat(first + nextBeatRef.current * BEAT_PERIOD, nextBeatRef.current % 2 === 1);
            nextBeatRef.current += 1;
          }
          const be = (now - first) / BEAT_PERIOD;
          animateRing(be < 0 ? 1 : be - Math.floor(be), true);
        }
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  };

  const stopLoop = () => {
    runningRef.current = false;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  // a tap continues the streak only if it lands one beat after the last (every-beat
  //   tapping) AND within tolerance of the streak's running offset. Otherwise the
  //   streak resets to this tap — the player has to find the groove again.
  const feedConsistency = (offset: number, rawTap: number) => {
    const last = lastTapRef.current;
    const gap = last === null ? null : rawTap - last;
    lastTapRef.current = rawTap;
    if (gap !== null && (gap < GAP_MIN || gap > GAP_MAX)) {
      streakRef.current = [offset];
      setStreak(1);
      return;
    }
    const s = streakRef.current;
    if (s.length < 2) {
      s.push(offset);
    } else if (Math.abs(offset - median(s)) <= STREAK_TOLERANCE) {
      s.push(offset);
    } else {
      streakRef.current = [offset];
    }
    setStreak(streakRef.current.length);
    if (streakRef.current.length >= STREAK_TARGET) complete();
  };

  const registerTap = () => {
    if (!runningRef.current) return;
    const sound = soundRef.current;
    let offset: number;
    let rawTap: number;
    if (introRef.current) {
      const bt = getGameBeatTime();
      if (bt === null) return;
      rawTap = bt;
      offset = bt - Math.round(bt / BEAT_PERIOD) * BEAT_PERIOD;
    } else {
      if (!sound || !startedRef.current) return;
      rawTap = sound.currentAudioTime();
      const idx = Math.round((rawTap - firstBeatRef.current) / BEAT_PERIOD);
      if (idx < 1) return; // first scheduled beat isn't audible yet
      offset = rawTap - (firstBeatRef.current + idx * BEAT_PERIOD);
    }
    sound?.playCalibrationTap();
    feedConsistency(offset, rawTap);
  };

  const complete = () => {
    runningRef.current = false;
    const offsetSec = median(streakRef.current);
    // hand off immediately so the world comes alive on the same beat while we fade.
    window.dispatchEvent(new CustomEvent("beat-calibrator:done", { detail: { offsetSec, origin: originRef.current } }));
    goPhase("fading");
    window.setTimeout(() => { stopLoop(); goPhase("idle"); }, FADE_MS);
  };

  const cancel = () => {
    runningRef.current = false;
    window.dispatchEvent(new CustomEvent("beat-calibrator:cancel", { detail: { origin: originRef.current } }));
    stopLoop();
    goPhase("idle");
  };

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sound: Sound; intro?: boolean };
      soundRef.current = detail.sound;
      introRef.current = !!detail.intro;
      originRef.current = detail.intro ? "intro" : "settings";
      beginRun();
    };
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current === "idle") return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (phaseRef.current === "running") cancel();
        return;
      }
      if (e.code === "Space" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        e.stopPropagation();
        if (phaseRef.current === "running") registerTap();
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

  const pips = Array.from({ length: STREAK_TARGET });
  const sub =
    streak === 0
      ? "find the pulse — one tap on every beat"
      : streak < STREAK_TARGET
        ? "lock in… keep the streak going"
        : "you've got the rhythm";

  // pointerdown over click: registers on finger-down instead of tap-up,
  //   which would skew the offset by ~50-100ms on touch.
  const onTapDown = (e: React.PointerEvent) => {
    if (phase !== "running") return;
    e.preventDefault();
    registerTap();
  };

  return (
    <div id="beat-calibrator" className={phase === "fading" ? "fading" : ""}>
      <div className="cal-inner">
        <h2 className="cal-title">Find the Beat</h2>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Tap on every beat"
          className={`cal-ring-wrap${touch ? " cal-ring-wrap--touch" : ""}`}
          onPointerDown={onTapDown}
        >
          <div className="cal-guide" />
          <div className="cal-ping" ref={pingRef} />
          <div className="cal-core" ref={coreRef} />
          {touch && <div className="cal-tap-label">tap</div>}
        </button>
        <p className="cal-instruction">
          {touch ? (
            <>tap the circle on every beat</>
          ) : (
            <>tap <span className="key">space</span> on every beat</>
          )}
        </p>
        <p className="cal-sub">{sub}</p>
        <div className="cal-progress">
          {pips.map((_, i) => (
            <span key={i} className={i < streak ? "cal-pip on" : "cal-pip"} />
          ))}
        </div>
        <button type="button" className="cal-skip" onClick={cancel}>
          {touch ? "Cancel" : "Esc"}
        </button>
      </div>
    </div>
  );
};
