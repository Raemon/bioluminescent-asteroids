import { useEffect, useState } from "react";
import { InstructionsPanel } from "./InstructionsPanel";
import { ControlInfo } from "./ControlInfo";

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
  const [devlogUnseen, setDevlogUnseen] = useState(false);

  useEffect(() => {
    const onOpen = () => setInstructionsOpen(true);
    const onClose = () => setInstructionsOpen(false);
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<{ state: string }>).detail;
      setPaused(detail.state === "paused");
    };
    const onUnseen = (e: Event) => {
      const detail = (e as CustomEvent<{ unseen: boolean }>).detail;
      setDevlogUnseen(!!detail?.unseen);
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
    window.addEventListener("devlog:unseen", onUnseen as EventListener);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("instructions-open-request", onOpen);
      window.removeEventListener("instructions-close-request", onClose);
      window.removeEventListener("game:state", onState as EventListener);
      window.removeEventListener("devlog:unseen", onUnseen as EventListener);
    };
  }, [instructionsOpen]);

  const startTutorial = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent("tutorial:request"));
  };

  const toggleDevLog = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDevlogUnseen(false);
    window.dispatchEvent(new CustomEvent("devlog:toggle"));
  };

  const closeInstructions = () => {
    setInstructionsOpen(false);
    window.dispatchEvent(new CustomEvent("instructions-close"));
  };

  return (
    <div id="overlay" className="hidden">
      <button id="instructions-link" type="button" onClick={startTutorial}>
        tutorial
      </button>
      <button
        id="devlog-link"
        type="button"
        className={devlogUnseen ? "has-unseen" : ""}
        onClick={toggleDevLog}
      >
        dev log
      </button>
      <a
        id="sound-link"
        href="/sound"
        className={isLocalhost() ? "" : "hidden"}
      >
        sound →
      </a>
      <div id="overlay-title-group">
        <h1 id="overlay-title">Pulsar Drift</h1>
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
        <button type="submit" id="score-entry-submit">Save Score</button>
        <p id="score-entry-status" className="score-entry-status" />
      </form>
      <div id="leaderboard" className="hidden">
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
