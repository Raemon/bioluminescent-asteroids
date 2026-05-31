import { useEffect, useState } from "react";
import { TutorialPanel } from "./TutorialPanel";

// Overlay shell: title, instructions, leaderboard, score-entry, abort-mission.
// Hidden/visible state is still toggled by the game via .hidden on #overlay,
// so React just renders the static structure and lets game/hud.ts /
// game/scoreEntry.ts continue to mutate textContent and classList by ID.

const isLocalhost = () =>
  typeof location !== "undefined" &&
  ["localhost", "127.0.0.1", "::1"].includes(location.hostname);

export const Overlay = () => {
  const [tutorialOpen, setTutorialOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setTutorialOpen(true);
    const onClose = () => setTutorialOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && tutorialOpen) {
        e.stopPropagation();
        closeTutorial();
      }
    };
    const closeTutorial = () => {
      setTutorialOpen(false);
      window.dispatchEvent(new CustomEvent("tutorial-close"));
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("tutorial-open-request", onOpen);
    window.addEventListener("tutorial-close-request", onClose);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("tutorial-open-request", onOpen);
      window.removeEventListener("tutorial-close-request", onClose);
    };
  }, [tutorialOpen]);

  const openTutorial = (e: React.MouseEvent) => {
    e.stopPropagation();
    setTutorialOpen(true);
    window.dispatchEvent(new CustomEvent("tutorial-open"));
  };

  const closeTutorial = () => {
    setTutorialOpen(false);
    window.dispatchEvent(new CustomEvent("tutorial-close"));
  };

  return (
    <div id="overlay" className="hidden">
      <button id="tutorial-link" type="button" onClick={openTutorial}>
        tutorial
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
        <h3 id="overlay-subtitle">A meditative rhythm journey</h3>
      </div>
      <button id="overlay-start" type="button">
        Begin
      </button>
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
      <TutorialPanel open={tutorialOpen} onClose={closeTutorial} />
    </div>
  );
};
