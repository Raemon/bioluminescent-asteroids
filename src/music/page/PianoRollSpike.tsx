// SPIKE — evaluating whether the off-the-shelf `webaudio-pianoroll` custom
// element is a good enough grid to build the real IR-backed editor on, or
// whether we go from-scratch. See music-editor-plan.md. This is a throwaway
// evaluation page, not the real editor: it does NOT touch the IR, persistence,
// or the bake pipeline. It only answers "is the component nice to use?".
//
// What it exercises:
//   - the component renders + edits notes (drag to add/move/resize)
//   - we can read its note array (`element.sequence`, each note {t,g,n})
//   - we can play those notes back through Pulsar's real preview path
//     (soundfont-player GM instrument, copied from PianoKeyboard.tsx)

import { useEffect, useRef, useState } from "react";
import Soundfont from "soundfont-player";
import "webaudio-pianoroll"; // self-registers the <webaudio-pianoroll> element
import { Sound } from "../../Sound";

// Sound has no shared singleton export; pages make their own (see PianoKeyboard).
const sound = new Sound();

// Same runtime-shape shim PianoKeyboard uses for soundfont-player.
type SfPlayer = { play: (note: string | number, when?: number, opts?: { gain?: number; duration?: number }) => void; connect: (dest: AudioNode) => void };
type SfNamespace = { instrument: (ac: AudioContext, name: string, opts?: { soundfont?: string; format?: string }) => Promise<SfPlayer> };
const Sf = Soundfont as unknown as SfNamespace;

// A note as the component stores it: t=onset tick, g=length ticks, n=MIDI note.
type RollNote = { t: number; g: number; n: number };
type RollEl = HTMLElement & {
  sequence: RollNote[];
  timebase: number; // ticks per beat
  redraw?: () => void;
};

const INSTRUMENT = "acoustic_grand_piano"; // GM name for soundfont-player

export function PianoRollSpike() {
  const rollRef = useRef<RollEl | null>(null);
  const instRef = useRef<SfPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [noteCount, setNoteCount] = useState(0);
  const [dump, setDump] = useState<string>("");

  // Seed a haunting little phrase so the page isn't empty on load.
  useEffect(() => {
    const el = rollRef.current;
    if (!el) return;
    const tb = el.timebase || 480;
    el.sequence = [
      { t: 0 * tb, g: 1 * tb, n: 69 }, // A4
      { t: 1 * tb, g: 1 * tb, n: 67 }, // G4
      { t: 2 * tb, g: 2 * tb, n: 72 }, // C5
      { t: 4 * tb, g: 2 * tb, n: 74 }, // D5
    ];
    el.redraw?.();
    setNoteCount(el.sequence.length);
    setReady(true);
  }, []);

  const loadInstrument = async () => {
    if (instRef.current) return instRef.current;
    sound.ensureContext();
    const ctx = sound.ctx;
    const master = sound.master;
    if (!ctx || !master) return null;
    const inst = await Sf.instrument(ctx, INSTRUMENT, { soundfont: "MusyngKite", format: "mp3" });
    inst.connect(master);
    instRef.current = inst;
    return inst;
  };

  const midiToName = (m: number) => {
    const pc = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][((m % 12) + 12) % 12];
    return `${pc}${Math.floor(m / 12) - 1}`;
  };

  // Play whatever is currently in the grid through the GM preview instrument,
  // scheduling each note by its tick onset at 120 BPM.
  const playRoll = async () => {
    const el = rollRef.current;
    const inst = await loadInstrument();
    if (!el || !inst || !sound.ctx) return;
    if (sound.ctx.state === "suspended") await sound.ctx.resume();
    const tb = el.timebase || 480;
    const secPerTick = 60 / 120 / tb; // 120 BPM
    const t0 = sound.ctx.currentTime + 0.05;
    for (const nt of el.sequence) {
      inst.play(midiToName(nt.n), t0 + nt.t * secPerTick, { duration: nt.g * secPerTick, gain: 0.9 });
    }
  };

  const refresh = () => {
    const el = rollRef.current;
    if (!el) return;
    setNoteCount(el.sequence.length);
    setDump(JSON.stringify(el.sequence.map((n) => ({ beat: n.t / (el.timebase || 480), dur: n.g / (el.timebase || 480), note: midiToName(n.n) })), null, 0));
  };

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, sans-serif", color: "#ddd", background: "#111", minHeight: "100vh" }}>
      <div style={{ marginBottom: 12 }}>
        <a href="/" style={{ color: "#6cf" }}>← PULSAR</a>
        <span style={{ marginLeft: 16, opacity: 0.6 }}>piano-roll component SPIKE — evaluation only, no IR / no save / no bake</span>
      </div>

      {/* The off-the-shelf custom element. Attributes configure the grid. */}
      {/* @ts-expect-error custom element, not in JSX intrinsic types */}
      <webaudio-pianoroll
        ref={rollRef}
        width="900"
        height="320"
        editmode="dragpoly"
        xrange="16"
        yrange="24"
        kbwidth="40"
        timebase="480"
        style={{ display: "block", border: "1px solid #333" }}
      />

      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={playRoll} disabled={!ready} style={btn}>▶ Play</button>
        <button onClick={refresh} style={btn}>Read notes</button>
        <span style={{ opacity: 0.7 }}>{noteCount} notes</span>
      </div>

      {dump && (
        <pre style={{ marginTop: 12, padding: 10, background: "#000", color: "#9f9", fontSize: 12, overflow: "auto" }}>
          {dump}
        </pre>
      )}

      <div style={{ marginTop: 20, fontSize: 13, opacity: 0.7, lineHeight: 1.5 }}>
        <strong>Spike checklist</strong> — does the component:
        <ul>
          <li>let you add / move / resize notes pleasantly?</li>
          <li>expose its note data cleanly (the "Read notes" dump → maps to our IR)?</li>
          <li>feel worth keeping vs. a from-scratch canvas grid bound to the IR?</li>
        </ul>
        Note: pitch-bend / swell / vibrato lanes are <em>not</em> here — that's the part we build either way.
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "6px 14px", background: "#2a2a2a", color: "#eee",
  border: "1px solid #444", borderRadius: 4, cursor: "pointer",
};
