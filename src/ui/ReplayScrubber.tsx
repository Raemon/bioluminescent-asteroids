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

const exitReplay = () => window.dispatchEvent(new CustomEvent("replay:exit"));

// Starts the offline MP4 export, or cancels the one in flight (the game side
//   treats it as a toggle).
const requestDownload = () => window.dispatchEvent(new CustomEvent("replay:download"));

// WebCodecs is a hard requirement for export (no MediaRecorder fallback);
//   without it the button renders disabled with an explanatory title.
const WEBCODECS_OK = typeof VideoEncoder !== "undefined";

export const ReplayScrubber = () => {
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState(0);
  const [total, setTotal] = useState(0);
  const [speed, setSpeedState] = useState(1);
  const [waveStarts, setWaveStarts] = useState<{ frame: number; wave: number }[]>([]);
  // Export progress fraction (0..1) while an MP4 export runs; null when idle.
  const [exportFrac, setExportFrac] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const histCanvasRef = useRef<HTMLCanvasElement>(null);
  const rhythmRef = useRef<number[]>([]);
  const draggingRef = useRef(false);

  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<{ state: string; highlight?: boolean }>).detail;
      // The game-over highlight clip runs in "replaying" too, but it's a passive
      //   backdrop — no scrubber for it.
      setActive(detail.state === "replaying" && !detail.highlight);
    };
    const onProgress = (e: Event) => {
      const d = (e as CustomEvent<{ position: number; total: number; speed: number }>).detail;
      setPosition(d.position);
      setTotal(d.total);
      setSpeedState(d.speed);
    };
    const onRhythm = (e: Event) => {
      const d = (e as CustomEvent<{ rhythm: number[]; waveStarts: { frame: number; wave: number }[] }>).detail;
      rhythmRef.current = d.rhythm;
      setWaveStarts(d.waveStarts);
      drawHistogram();
    };
    const onExportProgress = (e: Event) => {
      const d = (e as CustomEvent<{ frac: number; phase: string }>).detail;
      setExportFrac(d.phase === "done" ? null : d.frac);
    };
    window.addEventListener("game:state", onState as EventListener);
    window.addEventListener("replay:progress", onProgress as EventListener);
    window.addEventListener("replay:rhythm", onRhythm as EventListener);
    window.addEventListener("replay:export-progress", onExportProgress as EventListener);
    return () => {
      window.removeEventListener("game:state", onState as EventListener);
      window.removeEventListener("replay:progress", onProgress as EventListener);
      window.removeEventListener("replay:rhythm", onRhythm as EventListener);
      window.removeEventListener("replay:export-progress", onExportProgress as EventListener);
    };
  }, []);

  // Draw the rhythm-over-time skyline into the histogram canvas: one column per
  //   device pixel of bar width, each column as tall as the peak rhythm in the
  //   frames it spans — "1px per rhythm". Re-run when the bar resizes or new
  //   samples arrive.
  const drawHistogram = () => {
    const canvas = histCanvasRef.current;
    const bar = barRef.current;
    const rhythm = rhythmRef.current;
    if (!canvas || !bar || rhythm.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = bar.clientWidth;
    let peak = 1;
    for (const r of rhythm) if (r > peak) peak = r;
    // The canvas is exactly peak px tall (1px per rhythm unit) in CSS pixels.
    const cssH = peak;
    canvas.style.height = `${cssH}px`;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(106, 215, 255, 0.35)";
    const cols = Math.round(cssW);
    for (let x = 0; x < cols; x++) {
      const from = Math.floor((x / cols) * rhythm.length);
      const to = Math.max(from + 1, Math.floor(((x + 1) / cols) * rhythm.length));
      let colPeak = 0;
      for (let i = from; i < to && i < rhythm.length; i++) if (rhythm[i] > colPeak) colPeak = rhythm[i];
      if (colPeak <= 0) continue;
      // 1 rhythm unit = 1 CSS px tall, drawn upward from the bottom of the canvas.
      const barH = colPeak * dpr;
      ctx.fillRect(x * dpr, h - barH, dpr, barH);
    }
  };

  useEffect(() => {
    if (!active) return;
    const onResize = () => drawHistogram();
    window.addEventListener("resize", onResize);
    drawHistogram();
    return () => window.removeEventListener("resize", onResize);
  }, [active]);

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
        <canvas ref={histCanvasRef} className="replay-scrubber__hist" aria-hidden="true" />
        <div className="replay-scrubber__fill" style={{ width: `${pct}%` }} />
        {total > 0 && waveStarts.map((w) => (
          <div
            key={w.frame}
            className="replay-scrubber__wave-dot"
            style={{ left: `${(w.frame / total) * 100}%` }}
            title={`Wave ${w.wave}`}
            onPointerDown={(e) => {
              // seek to the wave start; don't let the bar's drag-seek also fire.
              e.stopPropagation();
              seekTo(w.frame);
            }}
          />
        ))}
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
      <button
        type="button"
        className="replay-scrubber__download"
        aria-label={exportFrac !== null ? "Cancel export" : "Download as MP4"}
        title={
          !WEBCODECS_OK
            ? "Video export needs WebCodecs, which this browser doesn't support"
            : exportFrac !== null
              ? "Cancel export"
              : "Download as MP4"
        }
        disabled={!WEBCODECS_OK}
        onClick={requestDownload}
      >
        {exportFrac !== null ? (
          <span className="replay-scrubber__export-pct">{Math.round(exportFrac * 100)}%</span>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10M7.5 10.5L12 15l4.5-4.5M5 19h14" /></svg>
        )}
      </button>
      <button
        type="button"
        className="replay-scrubber__exit"
        aria-label="Exit replay"
        onClick={exitReplay}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
};
