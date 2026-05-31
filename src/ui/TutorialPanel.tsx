// Tutorial panel. The two canvas elements (#tutorial-demo-basics,
// #tutorial-demo-rhythm) keep their stable IDs so tutorial.ts's
// installTutorialDemos() can still query them and start/stop the demos
// on the tutorial-open/tutorial-close custom events.

type Props = {
  open: boolean;
  onClose: () => void;
};

export const TutorialPanel = ({ open, onClose }: Props) => {
  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      id="tutorial-panel"
      className={open ? "" : "hidden"}
      role="dialog"
      aria-labelledby="tutorial-heading"
      aria-modal="true"
      onClick={handleBackdrop}
    >
      <button id="tutorial-close" type="button" aria-label="Close tutorial" onClick={onClose}>
        ×
      </button>
      <div id="tutorial-scroll">
        <h2 id="tutorial-heading">Pilot Briefing</h2>
        <section className="tutorial-section">
          <h3>Controls</h3>
          <p>
            <span className="key">←</span> <span className="key">→</span> rotate &nbsp;·&nbsp;
            <span className="key">↑</span> <span className="key">↓</span> thrust &nbsp;·&nbsp;
            <span className="key">space</span> fire &nbsp;·&nbsp;
            <span className="key">esc</span> pause
          </p>
        </section>
        <section className="tutorial-section tutorial-section--text-left">
          <div className="tutorial-text">
            <h3>Fly &amp; Fire</h3>
            <p>
              Rotate, thrust, shoot. There's no drag — momentum carries
              you. Larger rocks split into smaller ones.
            </p>
          </div>
          <canvas className="tutorial-demo" id="tutorial-demo-basics" width={360} height={200} />
        </section>
        <section className="tutorial-section tutorial-section--text-right">
          <canvas className="tutorial-demo" id="tutorial-demo-rhythm" width={360} height={220} />
          <div className="tutorial-text">
            <h3>Rhythm</h3>
            <p>
              Dotted lines trace where each asteroid will be on the next
              beats. Line up your reticule on a dot and fire <em>on the
              beat</em> for a rhythm hit. Consecutive rhythm hits stack a
              multiplier and unlock bonuses.
            </p>
          </div>
        </section>
        <p id="tutorial-dismiss">press <span className="key">esc</span> or click outside to close</p>
      </div>
    </div>
  );
};
