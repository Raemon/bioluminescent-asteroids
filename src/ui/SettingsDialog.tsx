import { useEffect, useState } from "react";
import { loadBeatOffset, clampBeatOffset } from "../game/beatCalibration";
import { isStartTutorialEnabled, setStartTutorialEnabled } from "../game/lifecycle";
import { getRecentName, saveRecentName } from "../game/highscores";

// Settings panel opened by the HUD gear. Everything here is persisted player
//   state: the rhythm-latency offset (also editable via the tap calibrator),
//   whether the wave-1 tutorial plays, and the pilot callsign. It talks to the
//   game through events (so the running offset updates live) and reads the
//   stored values directly when it opens.

const OFFSET_MIN_MS = -200;
const OFFSET_MAX_MS = 350;
const OFFSET_STEP_MS = 5;

export const SettingsDialog = () => {
  const [open, setOpen] = useState(false);
  const [offsetMs, setOffsetMs] = useState(0);
  const [tutorial, setTutorial] = useState(true);
  const [callsign, setCallsign] = useState("");

  // Snapshot the persisted values each time we open so the controls reflect
  //   reality (e.g. the tutorial flag may have flipped off at 6x rhythm).
  const openDialog = () => {
    setOffsetMs(Math.round((loadBeatOffset() ?? 0) * 1000));
    setTutorial(isStartTutorialEnabled());
    setCallsign(getRecentName());
    setOpen(true);
    // freezes the sim if a run is in progress (see Game / updateGame).
    window.dispatchEvent(new CustomEvent("settings:opened"));
  };

  const closeDialog = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("settings:closed"));
  };

  // While open, swallow keys at capture so the game behind doesn't act on them
  //   (typing in the callsign field still works — we don't preventDefault).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        closeDialog();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const applyOffset = (ms: number) => {
    const clamped = Math.round(clampBeatOffset(ms / 1000) * 1000);
    setOffsetMs(clamped);
    window.dispatchEvent(new CustomEvent("beat-offset:set", { detail: { offsetSec: clamped / 1000 } }));
  };

  const resync = () => {
    // dispatch the request first so `calibrating` latches before `settings:closed`
    //   clears `settingsOpen` — the sim stays frozen across the hand-off mid-run.
    window.dispatchEvent(new CustomEvent("beat-calibrator:request"));
    closeDialog();
  };

  const toggleTutorial = (enabled: boolean) => {
    setTutorial(enabled);
    setStartTutorialEnabled(enabled);
  };

  const updateCallsign = (name: string) => {
    const v = name.toUpperCase().slice(0, 16);
    setCallsign(v);
    saveRecentName(v);
  };

  return (
    <>
      <button id="settings-gear" type="button" title="Settings" aria-label="Settings" onClick={openDialog}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
    <div id="settings-dialog" onClick={closeDialog}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <h2 className="settings-title">Settings</h2>

        <section className="settings-row">
          <div className="settings-label">
            Rhythm latency
            <span className="settings-hint">how late your taps land vs. the beat you hear</span>
          </div>
          <div className="settings-latency">
            <button type="button" className="settings-step" onClick={() => applyOffset(offsetMs - OFFSET_STEP_MS)}>−</button>
            <input
              type="range"
              min={OFFSET_MIN_MS}
              max={OFFSET_MAX_MS}
              step={OFFSET_STEP_MS}
              value={offsetMs}
              onChange={(e) => applyOffset(Number(e.target.value))}
            />
            <button type="button" className="settings-step" onClick={() => applyOffset(offsetMs + OFFSET_STEP_MS)}>+</button>
            <span className="settings-ms">{offsetMs >= 0 ? "+" : "−"}{Math.abs(offsetMs)} ms</span>
          </div>
          <button type="button" className="settings-resync" onClick={resync}>Resync the beat ▸</button>
        </section>

        <section className="settings-row">
          <label className="settings-check">
            <input type="checkbox" checked={tutorial} onChange={(e) => toggleTutorial(e.target.checked)} />
            <span>Show the rhythm tutorial at the start</span>
          </label>
          <span className="settings-hint">turns itself off once you reach 6× rhythm</span>
        </section>

        <section className="settings-row">
          <label className="settings-field">
            <span>Pilot callsign</span>
            <input
              type="text"
              value={callsign}
              maxLength={16}
              spellCheck={false}
              autoCapitalize="characters"
              placeholder="—"
              onChange={(e) => updateCallsign(e.target.value)}
            />
          </label>
        </section>

        <button type="button" className="settings-done" onClick={closeDialog}>Done</button>
      </div>
    </div>
      )}
    </>
  );
};
