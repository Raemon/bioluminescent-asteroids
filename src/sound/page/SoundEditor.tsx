// /sound — checkbox-based mixer. Walks the object×action registry (sounds.ts)
// and renders one section per game object, with one checkbox row per action.
// Checked rows play together on a shared 0.5s (BEAT_GRID) beat clock at the
// cadence they'd hit in gameplay; continuous loops start/stop directly off
// the checkbox.
//
// Add a sound → an action in sounds.ts under the right object.
// Add an object → entry in animations.ts + entry in OBJECTS in sounds.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { Sound } from "../../Sound";
import { loadSoundConfig } from "../../soundConfig";
import { BEAT_GRID } from "../../game/rhythmConstants";
import { OBJECTS, type Action } from "./sounds";
import { SoundRow, type RowApi } from "./SoundRow";

const sound = new Sound();

const rowKey = (objectId: string, actionIdx: number) => `${objectId}::${actionIdx}`;

export const SoundEditor = () => {
  const [ready, setReady] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const checkedRef = useRef(checked);
  checkedRef.current = checked;

  const rowsRef = useRef<Map<string, RowApi>>(new Map());

  useEffect(() => {
    let cancelled = false;
    loadSoundConfig().then(() => {
      if (cancelled) return;
      // bgBeat is gated on bgBeatIntensity (0 = silent), which Game ramps
      // 0.08 → 1.0 across waves 1–30. Page has no wave clock; pin to the
      // same wave-6 level the pulsar visual is locked to.
      sound.bgBeatIntensity = 0.08 + (5 / 29) * 0.92;
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const registerRow = useCallback((api: RowApi) => {
    const key = rowKey(api.object.id, api.object.actions.indexOf(api.action));
    rowsRef.current.set(key, api);
    return () => {
      rowsRef.current.delete(key);
    };
  }, []);

  const handleToggle = useCallback((key: string, action: Action, next: boolean) => {
    setChecked((prev) => ({ ...prev, [key]: next }));
    sound.ensureContext();
    if (sound.ctx?.state === "suspended") sound.ctx.resume();
    if (action.trigger.kind !== "loop") return;
    const api = rowsRef.current.get(key);
    if (!api) return;
    if (next && !api.state.loopActive) {
      sound.play(action.sound);
      api.state.loopActive = true;
    } else if (!next && api.state.loopActive) {
      if (action.sound === "thrust") sound.stopThrust();
      else if (action.sound === "reverseThrust") sound.stopReverseThrust();
      else if (action.sound === "sideThrust") sound.stopSideThrust();
      api.state.loopActive = false;
    }
  }, []);

  // Master beat clock — drives all `beat`-triggered rows. Walks every slot
  // crossed since the last frame so it stays robust to dt jitter.
  useEffect(() => {
    if (!ready) return;
    let rafId = 0;
    let masterBeatTime = 0;
    let lastBeatTickIdx = -1;
    let lastHalfBeatTickIdx = -1;
    let lastFrameMs = performance.now();

    const fireSlot = (beatIdx: number, phaseBeats: 0 | 0.5) => {
      for (const api of rowsRef.current.values()) {
        if (!api.isChecked()) continue;
        const trig = api.action.trigger;
        if (trig.kind !== "beat") continue;
        if ((trig.phaseBeats ?? 0) !== phaseBeats) continue;
        if (beatIdx % trig.periodBeats !== 0) continue;
        sound.play(api.action.sound);
        api.fire();
      }
    };

    const tick = (nowMs: number) => {
      const dtMs = nowMs - lastFrameMs;
      lastFrameMs = nowMs;
      const dt = Math.min(0.05, dtMs / 1000);
      masterBeatTime += dt;

      const currentBeatIdx = Math.floor(masterBeatTime / BEAT_GRID);
      while (lastBeatTickIdx < currentBeatIdx) {
        lastBeatTickIdx += 1;
        fireSlot(lastBeatTickIdx, 0);
      }
      const halfBeatNow = Math.floor((masterBeatTime - BEAT_GRID * 0.5) / BEAT_GRID);
      while (lastHalfBeatTickIdx < halfBeatNow) {
        lastHalfBeatTickIdx += 1;
        fireSlot(lastHalfBeatTickIdx, 0.5);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [ready]);

  return (
    <div className="min-h-screen bg-[#04060a] font-mono text-[#d6ecff]">
      <header className="flex items-center justify-between border-b border-[rgba(106,215,255,0.18)] bg-gradient-to-b from-[rgba(106,215,255,0.06)] to-transparent px-4 py-2">
        <div className="flex items-baseline gap-2">
          <a
            href="/"
            className="text-[16px] font-semibold tracking-[0.18em] text-[#6ad7ff] no-underline [text-shadow:0_0_12px_rgba(106,215,255,0.55)] hover:text-[#b8ecff] hover:[text-shadow:0_0_16px_rgba(184,236,255,0.7)]"
          >
            PULSAR
          </a>
          <span className="text-[rgba(214,236,255,0.35)]">/</span>
          <span className="text-[12px] tracking-[0.08em] text-[rgba(214,236,255,0.7)]">sound</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[rgba(214,236,255,0.45)]">
            cycle <strong className="font-medium tracking-[0.04em] text-[#ffd86a]">0.5s</strong> · 120 bpm
          </div>
          <a
            href="/"
            className="rounded-[3px] border border-[rgba(106,215,255,0.25)] px-2 py-[3px] text-[12px] text-[rgba(214,236,255,0.7)] no-underline hover:border-[rgba(106,215,255,0.55)] hover:text-[#6ad7ff]"
          >
            ← game
          </a>
        </div>
      </header>

      <main className="flex w-full justify-center px-4 pt-2 pb-6 [&_section:first-child_.se-row:first-child]:border-t-0">
        <div className="flex w-fit flex-col">
          {OBJECTS.map((object) => (
            <section key={object.id} className="flex flex-col">
              {object.actions.map((action, idx) => {
                const key = rowKey(object.id, idx);
                return (
                  <SoundRow
                    key={key}
                    object={object}
                    action={action}
                    showObjectLabel={idx === 0}
                    checked={!!checked[key]}
                    onToggle={(next) => handleToggle(key, action, next)}
                    registerRow={registerRow}
                  />
                );
              })}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
};
