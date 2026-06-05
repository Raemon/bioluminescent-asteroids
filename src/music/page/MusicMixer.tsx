// /music — manual mixer for the combo-halo music stems. Lets the user start
// any subset of variation×layer stems at once and tweak their gains live, so
// they can A/B variations side-by-side without playing the game to combo 12x.
//
// In-game these stems are gated by combo tier and only one variation plays at
// a time (see Sound.startHaloMusic). This page bypasses that — each
// (variation, layer) gets its own AudioBufferSourceNode + GainNode and the
// user toggles them independently.

import { useEffect, useMemo, useRef, useState } from "react";
import { PianoKeyboard } from "./PianoKeyboard";

// Beat grid (seconds per quarter beat) and bass measure length must match the
// game so the pulse here lines up with how it'd feel in real gameplay. See
// src/game/rhythmConstants.ts and src/Asteroid.ts.
const BEAT_GRID = 0.5;
// Baked bgBeat mp3s — same files Sound.ts plays in-game. Downbeat is
// pitchRatio 1.0, offbeat is 1.122 (whole-step lift). Both at intensity 1.0
// (the maxed-out late-wave thud) so the pulse here matches what the player
// hears when the pulsar is closing in.
const BG_BEAT_DOWN_URL = "/sounds/baked/bgBeat__101.0000.mp3";
const BG_BEAT_OFF_URL = "/sounds/baked/bgBeat__113.2000.mp3";

type Variation = "r2-el" | "r2-sb" | "r3-el" | "r4-sb";
type Layer = "ambient" | "melodic" | "layer3";

type StemKey = `${Variation}::${Layer}`;

type VariationInfo = {
  id: Variation;
  label: string;
  blurb: string;
  // In-game peak gains — shown as the slider defaults so the page mirrors
  // what the player actually hears. Kept in sync with Sound.haloMusicGain /
  // Sound.haloMusicLayer3Gain.
  gains: Record<Layer, number>;
};

const VARIATIONS: readonly VariationInfo[] = [
  {
    id: "r2-el",
    label: "r2-el — cinematic bed + felt piano + lonely violin",
    blurb: "ElevenLabs cinematic bed (ambient) + felt piano (melodic) + a lonely solo violin (layer 3, FluidSynth strings).",
    gains: { ambient: 0.25, melodic: 0.25, layer3: 0.45 },
  },
  {
    id: "r2-sb",
    label: "r2-sb — sine pad + felt piano + felt glockenspiel",
    blurb: "Procedural sine pad (ambient) + FluidSynth felt piano (melodic) + slow felt-mallet glockenspiel arpeggio (layer 3).",
    gains: { ambient: 0.30, melodic: 0.30, layer3: 0.40 },
  },
  {
    id: "r3-el",
    label: "r3-el — Juno pad + soft lead + synth-bass arp",
    blurb: "ElevenLabs analog-synthwave Juno pad (ambient) + soft lead (melodic) + pulsed synth-bass arp on off-beats (layer 3).",
    gains: { ambient: 0.22, melodic: 0.22, layer3: 0.30 },
  },
  {
    id: "r4-sb",
    label: "r4-sb — 16th-note arp + solo cello + female choir",
    blurb: "Rhythmic 16th-note arp (ambient) + slow solo-cello sustain (melodic) + sparse female-choir 'ahh' pad (layer 3). Cello + choir onsets land only on beats so nothing reads off-grid against the bass clock.",
    gains: { ambient: 0.25, melodic: 0.25, layer3: 0.45 },
  },
];

const LAYERS: readonly Layer[] = ["ambient", "melodic", "layer3"];

const stemKey = (v: Variation, l: Layer): StemKey => `${v}::${l}`;
const stemUrl = (v: Variation, l: Layer) => `/sounds/halo-music/${v}-${l}.mp3`;

type StemNode = {
  src: AudioBufferSourceNode;
  gain: GainNode;
};

// Shared start time for every stem in a given mixer session. All stems start
// at the same audio time so loops stay phase-locked; per-stem gain ramps
// handle play/stop. Aligns with how Sound.startHaloMusic does it in-game.
//
// We open the context lazily on first user interaction so autoplay doesn't
// block, then everything sticks to a single shared clock.
export const MusicMixer = () => {
  const [ready, setReady] = useState(false);
  const [bufStatus, setBufStatus] = useState<Record<StemKey, "idle" | "loading" | "ready" | "error">>(() => {
    const init: Record<string, "idle"> = {};
    for (const v of VARIATIONS) for (const l of LAYERS) init[stemKey(v.id, l)] = "idle";
    return init as Record<StemKey, "idle">;
  });
  const [playing, setPlaying] = useState<Record<StemKey, boolean>>({} as Record<StemKey, boolean>);
  const [gains, setGains] = useState<Record<StemKey, number>>(() => {
    const init: Record<string, number> = {};
    for (const v of VARIATIONS) for (const l of LAYERS) init[stemKey(v.id, l)] = v.gains[l];
    return init as Record<StemKey, number>;
  });
  const [masterGain, setMasterGain] = useState(1.0);
  const [pulseEnabled, setPulseEnabled] = useState(true);
  const [pulseGain, setPulseGain] = useState(1.0);

  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const buffersRef = useRef<Map<StemKey, AudioBuffer>>(new Map());
  const nodesRef = useRef<Map<StemKey, StemNode>>(new Map());
  // Shared start time so every stem we kick off lands on the same loop phase
  // as anything already playing. Reset whenever every stem is stopped.
  const startAtRef = useRef<number>(0);

  // Background pulsar beat. Two buffers (downbeat + offbeat) fire on a 0.5s
  // grid anchored to startAtRef, matching the in-game bassClock pattern.
  const pulseDownBufRef = useRef<AudioBuffer | null>(null);
  const pulseOffBufRef = useRef<AudioBuffer | null>(null);
  const pulseGainNodeRef = useRef<GainNode | null>(null);
  const pulseTimerRef = useRef<number | null>(null);
  // Index of the next quarter-beat slot we'll schedule (0-based from startAt).
  const pulseNextBeatRef = useRef<number>(0);

  const ensureContext = (): AudioContext => {
    if (ctxRef.current) return ctxRef.current;
    const ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = masterGain;
    master.connect(ctx.destination);
    const pulseG = ctx.createGain();
    pulseG.gain.value = pulseEnabled ? pulseGain : 0;
    pulseG.connect(master);
    ctxRef.current = ctx;
    masterRef.current = master;
    pulseGainNodeRef.current = pulseG;
    return ctx;
  };

  const loadPulseBuffers = async (): Promise<void> => {
    if (pulseDownBufRef.current && pulseOffBufRef.current) return;
    const ctx = ensureContext();
    const fetchOne = async (url: string): Promise<AudioBuffer | null> => {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const ab = await r.arrayBuffer();
        return await ctx.decodeAudioData(ab);
      } catch {
        return null;
      }
    };
    const [d, o] = await Promise.all([
      pulseDownBufRef.current ? Promise.resolve(pulseDownBufRef.current) : fetchOne(BG_BEAT_DOWN_URL),
      pulseOffBufRef.current ? Promise.resolve(pulseOffBufRef.current) : fetchOne(BG_BEAT_OFF_URL),
    ]);
    if (d) pulseDownBufRef.current = d;
    if (o) pulseOffBufRef.current = o;
  };

  // Lookahead scheduler — fires every 100ms, schedules any beats whose audio
  // time falls in the next 200ms window. Each beat is a one-shot
  // AudioBufferSourceNode routed through pulseGainNodeRef so the user's pulse
  // slider rides everything. Pattern matches game/bassClock.ts: even beat
  // indices are downbeats (pitchRatio 1.0), odd are offbeats (1.122).
  const schedulePulseTick = () => {
    const ctx = ctxRef.current;
    const sink = pulseGainNodeRef.current;
    if (!ctx || !sink) return;
    const lookahead = 0.2;
    const horizon = ctx.currentTime + lookahead;
    while (true) {
      const slotTime = startAtRef.current + pulseNextBeatRef.current * BEAT_GRID;
      if (slotTime > horizon) break;
      // Don't bother scheduling beats that have already passed by more than
      // one slot (can only happen if the page was backgrounded mid-loop).
      if (slotTime >= ctx.currentTime - BEAT_GRID) {
        const isOffbeat = (pulseNextBeatRef.current & 1) === 1;
        const buf = isOffbeat ? pulseOffBufRef.current : pulseDownBufRef.current;
        if (buf) {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(sink);
          src.start(Math.max(slotTime, ctx.currentTime));
        }
      }
      pulseNextBeatRef.current += 1;
    }
  };

  const startPulseScheduler = async () => {
    if (pulseTimerRef.current !== null) return;
    await loadPulseBuffers();
    const ctx = ctxRef.current;
    if (!ctx) return;
    // Snap to the same quarter-beat slot we'd be on if the music had been
    // running all along: figure out the next slot >= now and start there.
    const now = ctx.currentTime;
    const elapsed = Math.max(0, now - startAtRef.current);
    pulseNextBeatRef.current = Math.ceil(elapsed / BEAT_GRID);
    schedulePulseTick();
    pulseTimerRef.current = window.setInterval(schedulePulseTick, 100);
  };

  const stopPulseScheduler = () => {
    if (pulseTimerRef.current !== null) {
      window.clearInterval(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
  };

  const loadBuffer = async (v: Variation, l: Layer): Promise<AudioBuffer | null> => {
    const key = stemKey(v, l);
    const cached = buffersRef.current.get(key);
    if (cached) return cached;
    setBufStatus((s) => ({ ...s, [key]: "loading" }));
    try {
      const ctx = ensureContext();
      const r = await fetch(stemUrl(v, l));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ab = await r.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      buffersRef.current.set(key, buf);
      setBufStatus((s) => ({ ...s, [key]: "ready" }));
      return buf;
    } catch {
      setBufStatus((s) => ({ ...s, [key]: "error" }));
      return null;
    }
  };

  const stopStem = (key: StemKey) => {
    const node = nodesRef.current.get(key);
    if (!node || !ctxRef.current) return;
    const ctx = ctxRef.current;
    const t = ctx.currentTime;
    node.gain.gain.cancelScheduledValues(t);
    node.gain.gain.setValueAtTime(node.gain.gain.value, t);
    node.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    try { node.src.stop(t + 0.55); } catch { /* already stopped */ }
    nodesRef.current.delete(key);
    if (nodesRef.current.size === 0) stopPulseScheduler();
  };

  const startStem = async (v: Variation, l: Layer) => {
    const key = stemKey(v, l);
    const buf = await loadBuffer(v, l);
    if (!buf) return;
    const ctx = ensureContext();
    if (ctx.state === "suspended") await ctx.resume();
    const master = masterRef.current!;
    // Reuse existing shared start time if anything else is currently playing
    // so the new stem lands on the same loop phase. Otherwise reset to now.
    if (nodesRef.current.size === 0 || startAtRef.current < ctx.currentTime - 1) {
      startAtRef.current = ctx.currentTime + 0.05;
    }
    const startAt = startAtRef.current;
    // If the shared start is in the past (other stems already running), we
    // need to set the source's loop offset so it lines up phase-correctly.
    const now = ctx.currentTime;
    const elapsed = Math.max(0, now - startAt);
    const offset = elapsed > 0 ? elapsed % buf.duration : 0;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    const target = gains[key] ?? 0.25;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, target), now + 0.5);
    src.connect(gain);
    gain.connect(master);
    if (offset > 0) src.start(now, offset);
    else src.start(startAt);
    nodesRef.current.set(key, { src, gain });
    void startPulseScheduler();
  };

  // Live gain updates — slide the slider and you hear the change immediately.
  // Snap rather than ramp; the user's pulling on the knob, they want the
  // change *now*.
  useEffect(() => {
    if (!ctxRef.current) return;
    const t = ctxRef.current.currentTime;
    for (const [key, node] of nodesRef.current) {
      const target = Math.max(0.0001, gains[key]);
      node.gain.gain.cancelScheduledValues(t);
      node.gain.gain.setTargetAtTime(target, t, 0.05);
    }
  }, [gains]);

  useEffect(() => {
    if (!masterRef.current || !ctxRef.current) return;
    const t = ctxRef.current.currentTime;
    masterRef.current.gain.cancelScheduledValues(t);
    masterRef.current.gain.setTargetAtTime(masterGain, t, 0.05);
  }, [masterGain]);

  useEffect(() => {
    if (!pulseGainNodeRef.current || !ctxRef.current) return;
    const t = ctxRef.current.currentTime;
    const target = pulseEnabled ? Math.max(0.0001, pulseGain) : 0.0001;
    pulseGainNodeRef.current.gain.cancelScheduledValues(t);
    pulseGainNodeRef.current.gain.setTargetAtTime(target, t, 0.05);
  }, [pulseGain, pulseEnabled]);

  // Preload everything in the background once the user signals readiness.
  useEffect(() => {
    if (!ready) return;
    for (const v of VARIATIONS) {
      for (const l of LAYERS) void loadBuffer(v.id, l);
    }
    void loadPulseBuffers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    return () => stopPulseScheduler();
  }, []);

  const togglePlay = async (v: Variation, l: Layer) => {
    const key = stemKey(v, l);
    setReady(true);
    if (playing[key]) {
      stopStem(key);
      setPlaying((p) => ({ ...p, [key]: false }));
    } else {
      setPlaying((p) => ({ ...p, [key]: true }));
      await startStem(v, l);
    }
  };

  const stopAll = () => {
    for (const key of Array.from(nodesRef.current.keys())) stopStem(key);
    setPlaying({} as Record<StemKey, boolean>);
  };

  const playWholeVariation = async (v: Variation) => {
    setReady(true);
    for (const l of LAYERS) {
      const key = stemKey(v, l);
      if (!playing[key]) {
        setPlaying((p) => ({ ...p, [key]: true }));
        await startStem(v, l);
      }
    }
  };

  const stopWholeVariation = (v: Variation) => {
    for (const l of LAYERS) {
      const key = stemKey(v, l);
      if (playing[key]) stopStem(key);
    }
    setPlaying((p) => {
      const next = { ...p };
      for (const l of LAYERS) next[stemKey(v, l)] = false;
      return next;
    });
  };

  const anyPlaying = useMemo(() => Object.values(playing).some(Boolean), [playing]);

  return (
    <div className="min-h-screen bg-[#04060a] font-mono text-[#d6ecff]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(106,215,255,0.18)] bg-gradient-to-b from-[rgba(106,215,255,0.06)] to-transparent px-4 py-3">
        <div className="flex items-baseline gap-3">
          <a
            href="/"
            className="text-[16px] font-semibold tracking-[0.18em] text-[#6ad7ff] no-underline [text-shadow:0_0_12px_rgba(106,215,255,0.55)] hover:text-[#b8ecff]"
          >
            ← PULSAR
          </a>
          <span className="text-[14px] tracking-[0.32em] text-[#9bb5d6]">/ MUSIC</span>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-[12px] uppercase tracking-[0.18em] text-[#9bb5d6]">
            <input
              type="checkbox"
              checked={pulseEnabled}
              onChange={(e) => setPulseEnabled(e.target.checked)}
              className="accent-[#6ad7ff]"
            />
            pulse
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={pulseGain}
              onChange={(e) => setPulseGain(parseFloat(e.target.value))}
              disabled={!pulseEnabled}
              className="w-32 accent-[#6ad7ff] disabled:opacity-40"
            />
            <span className="w-10 text-right text-[#d6ecff] tabular-nums">{pulseGain.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-2 text-[12px] uppercase tracking-[0.18em] text-[#9bb5d6]">
            master
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={masterGain}
              onChange={(e) => setMasterGain(parseFloat(e.target.value))}
              className="w-40 accent-[#6ad7ff]"
            />
            <span className="w-10 text-right text-[#d6ecff] tabular-nums">{masterGain.toFixed(2)}</span>
          </label>
          <button
            type="button"
            disabled={!anyPlaying}
            onClick={stopAll}
            className="rounded border border-[rgba(255,120,120,0.4)] bg-[rgba(255,120,120,0.08)] px-3 py-1 text-[12px] uppercase tracking-[0.18em] text-[#ff9b9b] disabled:opacity-30"
          >
            stop all
          </button>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6">
        <p className="text-[13px] leading-relaxed text-[#9bb5d6]">
          Toggle any combination of variation × layer to hear them at once.
          Sliders adjust each layer&apos;s gain live; defaults match the in-game
          peak gains. All stems share a common loop phase so re-triggering
          mid-session lines up cleanly.
        </p>

        <PianoKeyboard />

        <div className="grid gap-5 lg:grid-cols-2">
          {VARIATIONS.map((variation) => {
            const allOn = LAYERS.every((l) => playing[stemKey(variation.id, l)]);
            const anyOn = LAYERS.some((l) => playing[stemKey(variation.id, l)]);
            return (
              <section
                key={variation.id}
                className="rounded-lg border border-[rgba(106,215,255,0.22)] bg-[rgba(106,215,255,0.04)] p-4 shadow-[0_0_24px_rgba(106,215,255,0.06)_inset]"
              >
                <header className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[15px] font-semibold tracking-[0.14em] text-[#b8ecff]">
                      {variation.label}
                    </h2>
                    <p className="mt-1 text-[12px] leading-relaxed text-[#9bb5d6]">{variation.blurb}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => (allOn ? stopWholeVariation(variation.id) : playWholeVariation(variation.id))}
                    className={
                      "shrink-0 rounded border px-3 py-1 text-[11px] uppercase tracking-[0.18em] " +
                      (anyOn
                        ? "border-[rgba(255,200,120,0.5)] bg-[rgba(255,200,120,0.1)] text-[#ffd49b]"
                        : "border-[rgba(106,215,255,0.4)] bg-[rgba(106,215,255,0.08)] text-[#6ad7ff]")
                    }
                  >
                    {allOn ? "stop all 3" : "play all 3"}
                  </button>
                </header>

                <div className="flex flex-col gap-2">
                  {LAYERS.map((layer) => {
                    const key = stemKey(variation.id, layer);
                    const status = bufStatus[key];
                    const isPlaying = !!playing[key];
                    return (
                      <div
                        key={layer}
                        className={
                          "flex items-center gap-3 rounded border px-3 py-2 " +
                          (isPlaying
                            ? "border-[rgba(106,215,255,0.45)] bg-[rgba(106,215,255,0.08)]"
                            : "border-[rgba(106,215,255,0.12)] bg-[rgba(8,12,20,0.6)]")
                        }
                      >
                        <button
                          type="button"
                          onClick={() => void togglePlay(variation.id, layer)}
                          disabled={status === "error"}
                          className={
                            "w-20 shrink-0 rounded border px-2 py-1 text-[11px] uppercase tracking-[0.18em] " +
                            (isPlaying
                              ? "border-[rgba(255,200,120,0.5)] bg-[rgba(255,200,120,0.18)] text-[#ffd49b]"
                              : "border-[rgba(106,215,255,0.4)] bg-[rgba(106,215,255,0.08)] text-[#6ad7ff]") +
                            " disabled:opacity-30"
                          }
                        >
                          {isPlaying ? "stop" : "play"}
                        </button>
                        <span className="w-20 shrink-0 text-[12px] uppercase tracking-[0.18em] text-[#9bb5d6]">
                          {layer}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.005}
                          value={gains[key]}
                          onChange={(e) =>
                            setGains((g) => ({ ...g, [key]: parseFloat(e.target.value) }))
                          }
                          className="flex-1 accent-[#6ad7ff]"
                        />
                        <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-[#d6ecff]">
                          {gains[key].toFixed(3)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setGains((g) => ({ ...g, [key]: variation.gains[layer] }))}
                          title={`Reset to in-game default (${variation.gains[layer].toFixed(3)})`}
                          className="w-14 shrink-0 rounded border border-[rgba(106,215,255,0.2)] bg-transparent px-1 py-1 text-[10px] uppercase tracking-[0.14em] text-[#9bb5d6] hover:text-[#d6ecff]"
                        >
                          reset
                        </button>
                        <span
                          className={
                            "w-16 shrink-0 text-right text-[10px] uppercase tracking-[0.14em] " +
                            (status === "ready"
                              ? "text-[#7bd58e]"
                              : status === "loading"
                                ? "text-[#ffd49b]"
                                : status === "error"
                                  ? "text-[#ff9b9b]"
                                  : "text-[#5a7593]")
                          }
                        >
                          {status}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
};
