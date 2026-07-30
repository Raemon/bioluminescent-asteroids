import { useEffect, useState } from "react";
import { InstructionsPanel } from "./InstructionsPanel";
import { ControlInfo } from "./ControlInfo";
import { DevLog } from "./DevLog";

// Overlay shell: title, instructions, leaderboard, score-entry, abort-mission.
// Hidden/visible state is still toggled by the game via .hidden on #overlay,
// so React just renders the static structure and lets game/hud.ts /
// game/scoreEntry.ts continue to mutate textContent and classList by ID.

const isLocalhost = () =>
  typeof location !== "undefined" &&
  ["localhost", "127.0.0.1", "::1"].includes(location.hostname);

export const Overlay = () => {
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const onOpen = () => setInstructionsOpen(true);
    const onClose = () => setInstructionsOpen(false);
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<{ state: string }>).detail;
      setPaused(detail.state === "paused");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && instructionsOpen) {
        e.stopPropagation();
        closeInstructions();
      }
    };
    const closeInstructions = () => {
      setInstructionsOpen(false);
      window.dispatchEvent(new CustomEvent("instructions-close"));
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("instructions-open-request", onOpen);
    window.addEventListener("instructions-close-request", onClose);
    window.addEventListener("game:state", onState as EventListener);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("instructions-open-request", onOpen);
      window.removeEventListener("instructions-close-request", onClose);
      window.removeEventListener("game:state", onState as EventListener);
    };
  }, [instructionsOpen]);

  const closeInstructions = () => {
    setInstructionsOpen(false);
    window.dispatchEvent(new CustomEvent("instructions-close"));
  };

  return (
    <div id="overlay" className="hidden">
      <DevLog />
      <a
        id="sound-link"
        href="/sound"
        className={isLocalhost() ? "" : "hidden"}
      >
        sound →
      </a>
      <a
        id="music-link"
        href="/music"
        className={isLocalhost() ? "" : "hidden"}
      >
        music →
      </a>
      <div id="overlay-title-group">
        <h1 id="overlay-title">Pulsar</h1>
        <p id="overlay-subtitle">A Meditative Rhythm Journey</p>
      </div>
      <div id="overlay-start-group">
        <button id="overlay-start" type="button">
          Start
        </button>
      </div>
      {paused && <ControlInfo id="overlay-pause-controls" className="overlay-pause-controls" />}
      <div id="gameover-stack" className="hidden">
        <div id="gameover-text-column">
          <div id="gameover-wave" className="go-line go-wave" />
          <div id="gameover-peak" className="go-line go-peak">
            <span id="gameover-peak-label">Peak Rhythm</span>
            <span id="gameover-peak-value" />
          </div>
          <div id="gameover-score" className="go-line go-score" />
        </div>
      </div>
      <canvas id="killed-row" className="hidden" width={0} height={0} />
      {/* Masks the synchronous catch-up re-sim when the game-over highlight clip
          loops — fades the replay backdrop to black, the hitch happens unseen,
          then fades back. Sits above the canvas but below the gameover text/form. */}
      <div id="highlight-fade" />
      <form id="score-entry" className="hidden" autoComplete="off" noValidate>
        <label htmlFor="score-entry-name">Enter callsign</label>
        <input
          id="score-entry-name"
          name="name"
          type="text"
          maxLength={16}
          spellCheck={false}
          autoCapitalize="characters"
        />
        {/* Google sign-in / callsign-claim area. Populated imperatively by
            game/scoreEntry.ts; hidden when VITE_GOOGLE_CLIENT_ID is unset. */}
        <div id="score-entry-auth" className="hidden" />
        <label id="replay-save-toggle">
          <input id="replay-save-toggle-input" type="checkbox" />
          <span>Save replay</span>
        </label>
        <button type="submit" id="score-entry-submit">Save</button>
        <p id="score-entry-status" className="score-entry-status" />
        <p id="score-entry-stats" className="score-entry-stats hidden" />
      </form>
      <div id="leaderboard" className="hidden">
        {/* Claimed-pilot stats banner; shown/populated by game/scoreEntry.ts on
            the pilot-profile view, hidden on the hall-of-fame / standing views. */}
        <div id="leaderboard-profile-banner" className="hidden" />
        <ol id="leaderboard-list" />
        <div id="leaderboard-footer">
          <label id="leaderboard-top-only">
            <input id="leaderboard-top-only-input" type="checkbox" defaultChecked />
            <span>Top entries only</span>
          </label>
          <button id="leaderboard-show-more" type="button">show more</button>
        </div>
      </div>
      <button id="abort-mission" type="button" className="hidden">
        Abort Mission
      </button>
      <InstructionsPanel open={instructionsOpen} onClose={closeInstructions} />
    </div>
  );
};
