import { useEffect, useRef, useState } from "react";
import { loadBeatOffset, clampBeatOffset } from "../game/beatCalibration";
import { isStartTutorialEnabled, setStartTutorialEnabled } from "../game/lifecycle";
import { getRecentName, saveRecentName } from "../game/highscores";
import {
  ACTION_LABELS,
  ACTION_ORDER,
  type Bindings,
  type ControlAction,
  formatKey,
  getBindings,
  normalizeKey,
  resetBindings,
  saveBindings,
} from "../game/controlBindings";

// Settings panel opened by the HUD gear. Everything here is persisted player
//   state: the rhythm-latency offset (also editable via the tap calibrator),
//   whether the wave-1 tutorial plays, the pilot callsign, and the keyboard
//   bindings. It talks to the game through events (so the running offset
//   updates live) and reads the stored values directly when it opens.

const OFFSET_MIN_MS = -200;
const OFFSET_MAX_MS = 350;
const OFFSET_STEP_MS = 5;

type CaptureTarget = { action: ControlAction } | null;

export const SettingsDialog = () => {
  const [open, setOpen] = useState(false);
  const [offsetMs, setOffsetMs] = useState(0);
  const [tutorial, setTutorial] = useState(true);
  const [callsign, setCallsign] = useState("");
  const [bindings, setBindings] = useState<Bindings>(() => getBindings());
  const [capture, setCapture] = useState<CaptureTarget>(null);
  const captureRef = useRef<CaptureTarget>(null);
  captureRef.current = capture;

  // Snapshot the persisted values each time we open so the controls reflect
  //   reality (e.g. the tutorial flag may have flipped off at 6x rhythm).
  const openDialog = () => {
    setOffsetMs(Math.round((loadBeatOffset() ?? 0) * 1000));
    setTutorial(isStartTutorialEnabled());
    setCallsign(getRecentName());
    setBindings(getBindings());
    setCapture(null);
    setOpen(true);
    // freezes the sim if a run is in progress (see Game / updateGame).
    window.dispatchEvent(new CustomEvent("settings:opened"));
  };

  const closeDialog = () => {
    setOpen(false);
    setCapture(null);
    window.dispatchEvent(new CustomEvent("settings:closed"));
  };

  // While open, swallow keys at capture so the game behind doesn't act on them
  //   (typing in the callsign field still works — we don't preventDefault).
  //   When a binding capture is active, the next key press becomes the binding
  //   instead of acting on the dialog.
  useEffect(() => {
    const onReopen = () => openDialog();
    window.addEventListener("settings:open-request", onReopen);
    return () => window.removeEventListener("settings:open-request", onReopen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      const target = captureRef.current;
      if (target) {
        e.preventDefault();
        if (e.key === "Escape") { setCapture(null); return; }
        applyBinding(target.action, normalizeKey(e.key));
        setCapture(null);
        return;
      }
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

  const applyBinding = (action: ControlAction, key: string) => {
    const next: Bindings = { ...bindings } as Bindings;
    for (const a of ACTION_ORDER) {
      if (a === action) continue;
      const filtered = bindings[a].filter((k) => k !== key);
      if (filtered.length !== bindings[a].length) next[a] = filtered;
    }
    next[action] = [key];
    setBindings(next);
    saveBindings(next);
  };

  const clearBinding = (action: ControlAction) => {
    const next: Bindings = { ...bindings, [action]: [] } as Bindings;
    setBindings(next);
    saveBindings(next);
  };

  const resetControls = () => {
    resetBindings();
    setBindings(getBindings());
    setCapture(null);
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

        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-section-title">Pilot</span>
          </div>
          <label className="settings-field">
            <span>Callsign</span>
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

        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-section-title">Rhythm Latency Calibration</span>
            <button type="button" className="settings-link" onClick={resync}>Resync the beat ▸</button>
          </div>
          <div className="settings-row">
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
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-section-title">Tutorial</span>
          </div>
          <label className="settings-check">
            <input type="checkbox" checked={tutorial} onChange={(e) => toggleTutorial(e.target.checked)} />
            <span>Show the rhythm tutorial at the start</span>
          </label>
          <span className="settings-hint">turns itself off once you reach 6× rhythm</span>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-section-title">Controls</span>
            <button type="button" className="settings-link" onClick={resetControls}>Reset defaults ▸</button>
          </div>
          <div className="settings-controls-grid">
            {ACTION_ORDER.map((action) => {
              const k = bindings[action][0];
              const isCapturing = capture?.action === action;
              return (
                <div key={action} className="settings-control-row">
                  <span className="settings-control-label">{ACTION_LABELS[action]}</span>
                  <button
                    type="button"
                    className={`settings-key-chip${isCapturing ? " settings-key-chip--listening" : ""}${!k ? " settings-key-chip--empty" : ""}`}
                    onClick={() => setCapture({ action })}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (k) clearBinding(action);
                    }}
                    title={k ? "Click to rebind · Right-click to clear" : "Click to bind"}
                  >
                    {isCapturing ? "press a key…" : k ? formatKey(k) : "—"}
                  </button>
                </div>
              );
            })}
          </div>
          <span className="settings-hint">click to rebind · right-click to clear</span>
        </section>

        <button type="button" className="settings-done" onClick={closeDialog}>Done</button>
      </div>
    </div>
      )}
    </>
  );
};
