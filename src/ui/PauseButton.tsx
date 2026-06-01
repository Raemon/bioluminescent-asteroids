import { useEffect, useState } from "react";

// Fixed top-right pause button. Visible only during live play — hidden on the
//   title/pause/gameover overlays where pressing it would be redundant or noisy.
//   Clicking dispatches "game:togglePause", which Game.ts wires to togglePause().
export const PauseButton = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<{ state: string }>).detail;
      setVisible(detail.state === "playing" || detail.state === "dying");
    };
    window.addEventListener("game:state", onState as EventListener);
    return () => window.removeEventListener("game:state", onState as EventListener);
  }, []);

  const onClick = () => {
    window.dispatchEvent(new CustomEvent("game:togglePause"));
  };

  if (!visible) return null;

  return (
    <button
      id="pause-button"
      type="button"
      aria-label="Pause"
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="7" y="5" width="4" height="14" rx="1" />
        <rect x="13" y="5" width="4" height="14" rx="1" />
      </svg>
      <span className="pause-button__tooltip" aria-hidden="true">ESC to Pause</span>
    </button>
  );
};
