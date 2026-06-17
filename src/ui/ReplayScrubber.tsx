import { useEffect, useRef, useState } from "react";

// Video-style transport for replay playback. Visible only while the game is in
//   the "replaying" state. The game drives the playhead (frames consumed) and
//   broadcasts it via "replay:progress"; this component sends back speed/seek
//   commands the game/gameUpdate replay loop honours. Seeking backward forces
//   the sim to rebuild from frame 0 and fast-forward — that work happens in the
//   game loop, muted; here we only emit the target frame.

const SPEEDS = [0.5, 1, 2, 4] as const;

const setSpeed = (speed: number) =>
  window.dispatchEvent(new CustomEvent("replay:setSpeed", { detail: { speed } }));

const seekTo = (frame: number) =>
  window.dispatchEvent(new CustomEvent("replay:seek", { detail: { frame } }));

const togglePlay = () => window.dispatchEvent(new CustomEvent("replay:togglePlay"));

export const ReplayScrubber = () => {
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState(0);
  const [total, setTotal] = useState(0);
  const [speed, setSpeedState] = useState(1);
  const barRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<{ state: string }>).detail;
      setActive(detail.state === "replaying");
    };
    const onProgress = (e: Event) => {
      const d = (e as CustomEvent<{ position: number; total: number; speed: number }>).detail;
      setPosition(d.position);
      setTotal(d.total);
      setSpeedState(d.speed);
    };
    window.addEventListener("game:state", onState as EventListener);
    window.addEventListener("replay:progress", onProgress as EventListener);
    return () => {
      window.removeEventListener("game:state", onState as EventListener);
      window.removeEventListener("replay:progress", onProgress as EventListener);
    };
  }, []);

  // Map a pointer x within the bar to a frame index and seek there.
  const seekFromPointer = (clientX: number) => {
    const bar = barRef.current;
    if (!bar || total <= 0) return;
    const rect = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seekTo(Math.round(frac * total));
  };

  useEffect(() => {
    if (!active) return;
    const onMove = (e: PointerEvent) => { if (draggingRef.current) seekFromPointer(e.clientX); };
    const onUp = () => { draggingRef.current = false; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [active, total]);

  if (!active) return null;

  const paused = speed <= 0;
  const pct = total > 0 ? (position / total) * 100 : 0;
  // ~60 recorded frames per second; show elapsed / total as m:ss.
  const fmt = (frames: number) => {
    const s = Math.floor(frames / 60);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <div id="replay-scrubber">
      <button
        type="button"
        className="replay-scrubber__play"
        aria-label={paused ? "Play" : "Pause"}
        onClick={togglePlay}
      >
        {paused ? (
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l12 7-12 7z" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="4" height="14" rx="1" /><rect x="13" y="5" width="4" height="14" rx="1" /></svg>
        )}
      </button>
      <span className="replay-scrubber__time">{fmt(position)}</span>
      <div
        ref={barRef}
        className="replay-scrubber__bar"
        onPointerDown={(e) => {
          draggingRef.current = true;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          seekFromPointer(e.clientX);
        }}
      >
        <div className="replay-scrubber__fill" style={{ width: `${pct}%` }} />
        <div className="replay-scrubber__knob" style={{ left: `${pct}%` }} />
      </div>
      <span className="replay-scrubber__time">{fmt(total)}</span>
      <div className="replay-scrubber__speeds">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={"replay-scrubber__speed" + (!paused && speed === s ? " is-active" : "")}
            onClick={() => setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
};
