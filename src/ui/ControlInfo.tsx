import { Fragment } from "react";
import { TUTORIAL_CONTROLS } from "../game/controlBindings";

type Props = {
  id: string;
  className?: string;
};

// Renders TUTORIAL_CONTROLS so any edit to that list propagates here automatically.
//   The glyphs show the primary (arrow) scheme; WASD is bound to the same actions
//   by default, so it gets a trailing mention rather than a second set of glyphs.
export const ControlInfo = ({ id, className }: Props) => (
  <p id={id} className={className}>
    {TUTORIAL_CONTROLS.map((ctrl, i) => (
      <Fragment key={ctrl.label}>
        {i > 0 && <>&nbsp;·&nbsp;</>}
        {ctrl.keys.map((k, j) => (
          <Fragment key={k.action}>
            {j > 0 ? " " : ""}
            <span className="key">{k.glyph}</span>
          </Fragment>
        ))}{" "}
        {ctrl.label}
      </Fragment>
    ))}
    &nbsp;·&nbsp;<span className="key">WASD</span> also works
  </p>
);
