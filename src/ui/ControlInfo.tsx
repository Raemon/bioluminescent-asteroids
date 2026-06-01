type Props = {
  id?: string;
  className?: string;
};

export const ControlInfo = ({ id = "overlay-sub", className }: Props) => (
  <p id={id} className={className}>
    <span className="key">←</span> <span className="key">→</span> rotate &nbsp;·&nbsp;
    <span className="key">↑</span> <span className="key">↓</span> thrust &nbsp;·&nbsp;
    <span className="key">Z</span> <span className="key">X</span> side thrust &nbsp;·&nbsp;
    <span className="key">space</span> fire &nbsp;·&nbsp;
    <span className="key">esc</span> pause
  </p>
);
