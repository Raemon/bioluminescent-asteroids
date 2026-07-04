// Instructions panel. The two canvas elements (#instructions-demo-basics,
// #instructions-demo-rhythm) keep their stable IDs so instructions.ts's
// installInstructionsDemos() can still query them and start/stop the demos
// on the instructions-open/instructions-close custom events.

import { ControlInfo } from "./ControlInfo";

type Props = {
  open: boolean;
  onClose: () => void;
};

export const InstructionsPanel = ({ open, onClose }: Props) => {
  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      id="instructions-panel"
      className={open ? "" : "hidden"}
      role="dialog"
      aria-labelledby="instructions-heading"
      aria-modal="true"
      onClick={handleBackdrop}
    >
      <button id="instructions-close" type="button" aria-label="Close instructions" onClick={onClose}>
        ×
      </button>
      <div id="instructions-scroll">
        <h2 id="instructions-heading">Pilot Briefing</h2>
        <section className="instructions-section">
          <h3>Controls</h3>
          <ControlInfo id="instructions-controls" />
        </section>
        <section className="instructions-section instructions-section--text-left">
          <div className="instructions-text">
            <h3>Fly &amp; Fire</h3>
            <p>
              Rotate, thrust, shoot. There's no drag — momentum carries
              you. Larger rocks split into smaller ones.
            </p>
          </div>
          <canvas className="instructions-demo" id="instructions-demo-basics" width={360} height={200} />
        </section>
        <section className="instructions-section instructions-section--text-right">
          <canvas className="instructions-demo" id="instructions-demo-rhythm" width={360} height={220} />
          <div className="instructions-text">
            <h3>Rhythm</h3>
            <p>
              Dotted lines trace where each asteroid will be on the next
              beats. Line up your reticule on a dot and fire <em>on the
              beat</em> for a rhythm hit. Consecutive rhythm hits stack a
              multiplier and unlock bonuses.
            </p>
          </div>
        </section>
        <p id="instructions-dismiss">press <span className="key">esc</span> or click outside to close</p>
      </div>
    </div>
  );
};
