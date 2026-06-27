import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PianoRollSpike } from "./PianoRollSpike";
import "../../style.css";

const rootEl = document.getElementById("piano-roll-root");
if (!rootEl) throw new Error("Piano-roll spike root #piano-roll-root not found");
createRoot(rootEl).render(
  <StrictMode>
    <PianoRollSpike />
  </StrictMode>,
);
