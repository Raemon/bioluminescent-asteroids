// /music → Beat Sync. Tunes the per-song timing offset for the full-length
// halo songs (haloFullMusicConfig.ts, the L1–9 "different system") by EAR:
// shows each song's six layer waveforms + the in-game bass pulse as a reference,
// overlaid on the game's beat grid (0.5s quarter, 2.0s measure/downbeat). Drag a
// waveform left/right to slide the song against the grid (the end cycles back to
// the start), hear it update live, and the offset is persisted to
// halo-full-config.json on drag-end so a commit captures it.
//
// CRITICAL: playback goes through the REAL in-game path — Sound.startHaloFullMusic
// with loopForTuning=true — on the same shared Sound instance the piano uses. The
// only editor-specific behaviour is looping (so it cycles) and live re-offset.
// What you hear here is byte-for-byte what the game plays, so a by-ear fix
// translates 1:1 once USE_FULL_HALO_MUSIC is flipped back on.

import { useEffect, useMemo, useRef, useState } from "react";
import { sound } from "./PianoKeyboard";
import {
  FULL_HALO_SONGS,
  FULL_HALO_TIER_THRESHOLDS,
  type FullHaloSong,
} from "../../game/haloFullMusicConfig";
import { BEAT_GRID } from "../../game/rhythmConstants";
import { BASS_MEASURE_LENGTH } from "../../Asteroid";
import {
  loadHaloFullConfig,
  getHaloFullConfig,
  saveHaloFullConfig,
  fullHaloOffset,
  type HaloFullConfig,
} from "../../haloFullConfig";

// Same bgBeat mp3s the loop-pool mixer uses — the actual in-game bass pulse, so
// the reference lane is exactly the rhythm mothlight must land on late-wave.
const BG_BEAT_DOWN_URL = "/sounds/baked/bgBeat__101.0000.mp3";
const BG_BEAT_OFF_URL = "/sounds/baked/bgBeat__113.2000.mp3";

const SONGS = Object.keys(FULL_HALO_SONGS) as FullHaloSong[];

// l1→l6 short labels (mirrors FULL_HALO_SONGS[song].layerOrder, abbreviated).
const LAYER_SHORT = ["l1 atmos", "l2 pulse", "l3 guitar", "l4 bass", "l5 drums", "l6 shimmer"] as const;
const TIER_LABEL = FULL_HALO_TIER_THRESHOLDS.map((t) => `${t}x`);

const fullHaloUrl = (song: FullHaloSong, layer: number) =>
  `/sounds/halo-music-full/${song}-l${layer}.mp3`;

// Pixels of waveform per second of audio. Wide enough that a quarter-beat
// (0.5s) is a comfortable drag target; the lane scrolls horizontally.
const PX_PER_SEC = 90;
const LANE_HEIGHT = 44;
const REF_LANE_HEIGHT = 30;
// Left offset of the canvas content within each lane row: row px-1 (4) + the
// w-20 label (80) + gap-2 (8). The playhead is left-anchored here so it tracks
// the waveform, not the label.
const LABEL_GUTTER = 92;

type WaveData = {
  // Peak envelope: one [min,max] pair per pixel column across the whole track.
  // Computed once per decoded buffer; redrawing on drag just re-blits with an
  // x-shift so dragging stays smooth on a 2-minute track.
  peaks: Float32Array; // interleaved min,max,min,max…
  durationS: number;
};

// Downsample a decoded buffer to a per-pixel-column peak envelope.
function computePeaks(buf: AudioBuffer, pxPerSec: number): WaveData {
  const cols = Math.max(1, Math.ceil(buf.duration * pxPerSec));
  const peaks = new Float32Array(cols * 2);
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
  const samplesPerCol = ch0.length / cols;
  for (let c = 0; c < cols; c++) {
    const start = Math.floor(c * samplesPerCol);
    const end = Math.min(ch0.length, Math.floor((c + 1) * samplesPerCol));
    let mn = 0;
    let mx = 0;
    for (let i = start; i < end; i++) {
      const v = (ch0[i] + ch1[i]) * 0.5;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    peaks[c * 2] = mn;
    peaks[c * 2 + 1] = mx;
  }
  return { peaks, durationS: buf.duration };
}

async function decodeUrl(url: string): Promise<AudioBuffer | null> {
  sound.ensureContext();
  const ctx = sound.ctx;
  if (!ctx) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return await ctx.decodeAudioData(ab);
  } catch {
    return null;
  }
}

export const BeatSyncEditor = () => {
  const [song] = useState<FullHaloSong>(SONGS[0]);
  const def = FULL_HALO_SONGS[song];

  const [waves, setWaves] = useState<(WaveData | null)[]>(() => Array(6).fill(null));
  const [refWave, setRefWave] = useState<WaveData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Combo tier preview — which layers are audible. Defaults to "all on" so you
  // hear the whole arrangement while aligning; drop it to hear a single tier.
  const [previewCombo, setPreviewCombo] = useState<number>(FULL_HALO_TIER_THRESHOLDS[5]);

  // Live offset in seconds (the value being dragged). Initialized from the
  // on-disk config once it loads.
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  offsetRef.current = offset;
  const [dirty, setDirty] = useState(false);

  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const refCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Decoded bgBeat one-shots, kept so the pulse can be scheduled as live audio
  // (not just drawn). The pulse rides the same 0.5s grid as the in-game beat,
  // anchored to the song's measure-aligned start so the two share a downbeat.
  const pulseDownRef = useRef<AudioBuffer | null>(null);
  const pulseOffRef = useRef<AudioBuffer | null>(null);
  const pulseTimerRef = useRef<number | null>(null);
  const pulseNextSlotRef = useRef<number>(0);
  const pulseAnchorRef = useRef<number>(0); // audio time of slot 0 (the downbeat)

  // Playhead cursor — a left:px overlay swept by rAF off the audio clock.
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const totalWidth = useMemo(
    () => Math.ceil((def.durationS) * PX_PER_SEC),
    [def.durationS],
  );

  // Load config offset, decode all six layers + the bgBeat reference.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Pulls + caches halo-full-config.json; fullHaloOffset then reads it.
      await loadHaloFullConfig();
      if (!cancelled) {
        const o = fullHaloOffset(song);
        setOffset(o);
        offsetRef.current = o;
      }
      const bufs = await Promise.all(
        Array.from({ length: 6 }, (_, i) => decodeUrl(fullHaloUrl(song, i + 1))),
      );
      if (cancelled) return;
      setWaves(bufs.map((b) => (b ? computePeaks(b, PX_PER_SEC) : null)));

      // Reference lane: tile the bgBeat downbeat/offbeat onto the 0.5s grid for
      // the song's length, then envelope it. Downbeats (even slots) use the
      // downbeat mp3, offbeats (odd) the offbeat mp3 — the in-game pattern.
      const [down, off] = await Promise.all([decodeUrl(BG_BEAT_DOWN_URL), decodeUrl(BG_BEAT_OFF_URL)]);
      if (cancelled) return;
      pulseDownRef.current = down;
      pulseOffRef.current = off;
      if (down && off && sound.ctx) {
        const ctx = sound.ctx;
        const len = Math.ceil(def.durationS * ctx.sampleRate);
        const tile = ctx.createBuffer(1, len, ctx.sampleRate);
        const out = tile.getChannelData(0);
        const slot = Math.round(BEAT_GRID * ctx.sampleRate);
        for (let s = 0, slotIdx = 0; s < len; s += slot, slotIdx++) {
          const hit = (slotIdx & 1) === 0 ? down : off;
          const hd = hit.getChannelData(0);
          const n = Math.min(hd.length, len - s);
          for (let i = 0; i < n; i++) out[s + i] += hd[i];
        }
        setRefWave(computePeaks(tile, PX_PER_SEC));
      }
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [song, def.durationS]);

  // Draw a single waveform lane onto its canvas, content shifted by the live
  // offset and WRAPPED so the head that scrolls off the left reappears at the
  // right (the end→beginning cycling). The beat grid is drawn fixed on top, so
  // visually the SONG slides under a stationary grid.
  const drawLane = (
    canvas: HTMLCanvasElement | null,
    wave: WaveData | null,
    height: number,
    color: string,
    dim: boolean,
  ) => {
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const w = totalWidth;
    if (canvas.width !== w * dpr || canvas.height !== height * dpr) {
      canvas.width = w * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${height}px`;
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, height);

    const mid = height / 2;
    if (wave) {
      const cols = wave.peaks.length / 2;
      // Offset in pixels; positive offset advances playback, i.e. shifts the
      // content LEFT (later audio sits under the downbeat sooner).
      const shiftPx = Math.round(offsetRef.current * PX_PER_SEC);
      ctx2d.fillStyle = dim ? color.replace(/0\.\d+\)$/, "0.18)") : color;
      for (let x = 0; x < w; x++) {
        // Which source column shows at screen x, wrapped.
        let c = (((x + shiftPx) % cols) + cols) % cols;
        const mn = wave.peaks[c * 2];
        const mx = wave.peaks[c * 2 + 1];
        const y0 = mid - mx * (mid - 1);
        const y1 = mid - mn * (mid - 1);
        ctx2d.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    }
    drawGrid(ctx2d, w, height);
  };

  // Beat grid: quarter lines every BEAT_GRID, heavier measure/downbeat lines
  // every BASS_MEASURE_LENGTH. This is the anchor mothlight must align to.
  const drawGrid = (ctx2d: CanvasRenderingContext2D, w: number, height: number) => {
    const quarterPx = BEAT_GRID * PX_PER_SEC;
    const measurePx = BASS_MEASURE_LENGTH * PX_PER_SEC;
    for (let x = 0, i = 0; x <= w; x += quarterPx, i++) {
      const isMeasure = Math.abs((x % measurePx)) < 0.5 || Math.abs((x % measurePx) - measurePx) < 0.5;
      ctx2d.strokeStyle = isMeasure ? "rgba(255,200,120,0.55)" : "rgba(106,215,255,0.16)";
      ctx2d.lineWidth = isMeasure ? 1.5 : 1;
      ctx2d.beginPath();
      ctx2d.moveTo(x + 0.5, 0);
      ctx2d.lineTo(x + 0.5, height);
      ctx2d.stroke();
    }
  };

  // Redraw every lane when the offset changes (drag) or waves load.
  useEffect(() => {
    const COLORS = [
      "rgba(122,210,255,0.9)", "rgba(155,225,180,0.9)", "rgba(255,210,150,0.9)",
      "rgba(210,170,255,0.9)", "rgba(255,170,170,0.9)", "rgba(180,240,255,0.9)",
    ];
    const activeTier = (() => {
      let tier = -1;
      for (let i = 0; i < FULL_HALO_TIER_THRESHOLDS.length; i++) {
        if (previewCombo >= FULL_HALO_TIER_THRESHOLDS[i]) tier = i;
      }
      return tier;
    })();
    for (let i = 0; i < 6; i++) {
      drawLane(canvasRefs.current[i], waves[i], LANE_HEIGHT, COLORS[i], i > activeTier);
    }
    drawLane(refCanvasRef.current, refWave, REF_LANE_HEIGHT, "rgba(255,200,120,0.85)", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waves, refWave, offset, totalWidth, previewCombo]);

  // --- drag to offset ---------------------------------------------------------
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startOffset: offsetRef.current };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // Drag RIGHT → content should move right → playback retreats → offset
    // decreases. (dx>0 ⇒ offset−.) Wrap into the track length.
    const dx = e.clientX - d.startX;
    const dur = def.durationS;
    let next = d.startOffset - dx / PX_PER_SEC;
    next = ((next % dur) + dur) % dur;
    setOffset(next);
    offsetRef.current = next;
    setDirty(true);
    if (playing) sound.setHaloFullMusicOffset(next);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    void persist(offsetRef.current);
  };

  // Nudge buttons — fine alignment by a fraction of a beat.
  const nudge = (deltaS: number) => {
    const dur = def.durationS;
    let next = (((offsetRef.current + deltaS) % dur) + dur) % dur;
    setOffset(next);
    offsetRef.current = next;
    setDirty(true);
    if (playing) sound.setHaloFullMusicOffset(next);
    void persist(next);
  };

  const persist = async (value: number) => {
    const cur: HaloFullConfig = getHaloFullConfig();
    const next: HaloFullConfig = {
      ...cur,
      offsets: { ...cur.offsets, [song]: Math.round(value * 1000) / 1000 },
    };
    await saveHaloFullConfig(next);
    setDirty(false);
  };

  // Lookahead pulse scheduler — fires the decoded bgBeat one-shots on the 0.5s
  // grid, anchored to pulseAnchorRef (the song's downbeat) so song + pulse share
  // a 1. Even slots are downbeats (down buffer), odd are offbeats (off buffer),
  // matching the in-game pattern and the REF lane. Runs every 100ms, scheduling
  // any slot inside a 250ms horizon.
  const schedulePulse = () => {
    const ctx = sound.ctx;
    const down = pulseDownRef.current;
    const off = pulseOffRef.current;
    if (!ctx || !down || !off) return;
    const horizon = ctx.currentTime + 0.25;
    while (true) {
      const slotTime = pulseAnchorRef.current + pulseNextSlotRef.current * BEAT_GRID;
      if (slotTime > horizon) break;
      if (slotTime >= ctx.currentTime - BEAT_GRID) {
        const isOff = (pulseNextSlotRef.current & 1) === 1;
        const src = ctx.createBufferSource();
        src.buffer = isOff ? off : down;
        if (sound.master) src.connect(sound.master);
        src.start(Math.max(slotTime, ctx.currentTime));
      }
      pulseNextSlotRef.current += 1;
    }
  };

  const startPulse = (anchor: number) => {
    if (pulseTimerRef.current !== null) return;
    pulseAnchorRef.current = anchor;
    const ctx = sound.ctx;
    pulseNextSlotRef.current = ctx ? Math.max(0, Math.ceil((ctx.currentTime - anchor) / BEAT_GRID)) : 0;
    schedulePulse();
    pulseTimerRef.current = window.setInterval(schedulePulse, 100);
  };

  const stopPulse = () => {
    if (pulseTimerRef.current !== null) {
      window.clearInterval(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
  };

  // Cursor sweep — read the real audio-clock playhead each frame and place the
  // overlay. x = wrapped elapsed (playhead − offset) × PX_PER_SEC, which lands
  // the cursor over the content currently sounding (lanes draw content shifted
  // by offset, so elapsed maps straight to screen x).
  const tickCursor = () => {
    const p = sound.fullMusicPlayheadSec();
    const el = cursorRef.current;
    if (p != null && el) {
      const dur = def.durationS;
      const elapsed = (((p - offsetRef.current) % dur) + dur) % dur;
      el.style.transform = `translateX(${elapsed * PX_PER_SEC}px)`;
      el.style.opacity = "1";
    } else if (el) {
      el.style.opacity = "0";
    }
    rafRef.current = window.requestAnimationFrame(tickCursor);
  };

  const startCursor = () => {
    if (rafRef.current === null) rafRef.current = window.requestAnimationFrame(tickCursor);
  };

  const stopCursor = () => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (cursorRef.current) cursorRef.current.style.opacity = "0";
  };

  // Tear the pulse + cursor down if the component unmounts mid-play.
  useEffect(() => () => { stopPulse(); stopCursor(); }, []);

  const play = async () => {
    sound.ensureContext();
    if (sound.ctx?.state === "suspended") await sound.ctx.resume();
    // Start on the next measure boundary like the game does, so the grid and
    // the audio share a downbeat. measureAlignDelay = wait to next 2.0s slot.
    const now = sound.ctx ? sound.ctx.currentTime : 0;
    const measureAlignDelay = BASS_MEASURE_LENGTH - (now % BASS_MEASURE_LENGTH);
    await sound.startHaloFullMusic(song, previewCombo, measureAlignDelay, 0, null, true);
    setPlaying(true);
    // Anchor the pulse to the same downbeat the song was scheduled on.
    startPulse(now + measureAlignDelay);
    startCursor();
  };

  const stop = () => {
    sound.stopHaloFullMusic();
    stopPulse();
    stopCursor();
    setPlaying(false);
  };

  const setCombo = (combo: number) => {
    setPreviewCombo(combo);
    if (playing) sound.setHaloFullMusicTier(combo);
  };

  const offsetBeats = offset / BEAT_GRID;

  return (
    <section className="rounded-lg border border-[rgba(255,200,120,0.3)] bg-[rgba(255,200,120,0.04)] px-4 py-3">
      <header className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-[15px] font-semibold tracking-[0.12em] text-[#ffd49b]">
          BEAT SYNC — {song}
        </h2>
        <span className="text-[11px] text-[#9bb5d6]">
          drag a lane to slide the song against the beat grid · the orange lines are
          measure downbeats · cyan are quarter-beats
        </span>
        <div className="ml-auto flex items-center gap-2">
          {!playing ? (
            <button
              type="button"
              onClick={() => void play()}
              className="rounded border border-[rgba(106,215,255,0.4)] bg-[rgba(106,215,255,0.08)] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[#6ad7ff]"
            >
              play
            </button>
          ) : (
            <button
              type="button"
              onClick={stop}
              className="rounded border border-[rgba(255,200,120,0.5)] bg-[rgba(255,200,120,0.12)] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[#ffd49b]"
            >
              stop
            </button>
          )}
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="uppercase tracking-[0.16em] text-[#9bb5d6]">offset</span>
          <button type="button" onClick={() => nudge(-BEAT_GRID / 4)} className="rounded border border-[rgba(106,215,255,0.35)] px-1.5 py-0.5 text-[#6ad7ff]" title="−1/16 beat">−</button>
          <button type="button" onClick={() => nudge(-0.005)} className="rounded border border-[rgba(106,215,255,0.25)] px-1.5 py-0.5 text-[#6ad7ff]" title="−5ms">·</button>
          <span className="w-44 text-center tabular-nums text-[#d6ecff]">
            {offset >= 0 ? "+" : ""}{offset.toFixed(3)}s ({offsetBeats.toFixed(2)} beats)
          </span>
          <button type="button" onClick={() => nudge(0.005)} className="rounded border border-[rgba(106,215,255,0.25)] px-1.5 py-0.5 text-[#6ad7ff]" title="+5ms">·</button>
          <button type="button" onClick={() => nudge(BEAT_GRID / 4)} className="rounded border border-[rgba(106,215,255,0.35)] px-1.5 py-0.5 text-[#6ad7ff]" title="+1/16 beat">+</button>
          <button type="button" onClick={() => nudge(-offsetRef.current)} className="rounded border border-[rgba(255,120,120,0.35)] px-2 py-0.5 text-[#ff9b9b]" title="reset to 0">reset</button>
          {dirty && <span className="text-[#ffd49b]">saving…</span>}
          {!dirty && loaded && <span className="text-[#7bd58e]">saved</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="uppercase tracking-[0.16em] text-[#9bb5d6]">tier</span>
          {FULL_HALO_TIER_THRESHOLDS.map((t, i) => (
            <button
              key={t}
              type="button"
              onClick={() => setCombo(t)}
              className={
                "rounded border px-1.5 py-0.5 " +
                (previewCombo === t
                  ? "border-[rgba(255,200,120,0.6)] bg-[rgba(255,200,120,0.15)] text-[#ffd49b]"
                  : "border-[rgba(106,215,255,0.25)] text-[#6ad7ff]")
              }
              title={LAYER_SHORT[i]}
            >
              {TIER_LABEL[i]}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable lane stack. Reference pulse on top, then l1→l6. */}
      <div className="overflow-x-auto rounded border border-[rgba(106,215,255,0.12)] bg-[rgba(4,8,14,0.6)]">
        <div style={{ width: totalWidth + LABEL_GUTTER }} className="relative select-none">
          {/* Playhead — absolute over the lane stack, left-anchored past the
              label gutter; swept via transform off the audio clock. */}
          <div
            ref={cursorRef}
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-[#ffe9b0] opacity-0 [box-shadow:0_0_8px_rgba(255,233,176,0.9)]"
            style={{ left: LABEL_GUTTER, willChange: "transform" }}
          />
          <div className="flex items-center gap-2 px-1 pt-1">
            <span className="w-20 shrink-0 text-[10px] uppercase tracking-[0.14em] text-[#ffd49b]">PULSE ref</span>
            <canvas ref={refCanvasRef} className="block" style={{ height: REF_LANE_HEIGHT }} />
          </div>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 px-1 py-0.5">
              <span className="w-20 shrink-0 text-[10px] uppercase tracking-[0.14em] text-[#9bb5d6]">
                {LAYER_SHORT[i]}
              </span>
              <canvas
                ref={(el) => { canvasRefs.current[i] = el; }}
                className="block cursor-ew-resize touch-none"
                style={{ height: LANE_HEIGHT }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              />
            </div>
          ))}
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-[#7a92b0]">
        Playback runs through the real in-game path (Sound.startHaloFullMusic, looped
        here so it cycles). The persisted offset feeds the game directly — flip
        USE_FULL_HALO_MUSIC back on in haloFullMusicConfig.ts to hear it in a run.
        Layers above the selected tier are dimmed and silent.
      </p>
    </section>
  );
};
