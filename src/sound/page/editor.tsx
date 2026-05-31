import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SoundEditor } from "./SoundEditor";
import "../../style.css";

const rootEl = document.getElementById("sound-root");
if (!rootEl) throw new Error("Sound editor root #sound-root not found");
createRoot(rootEl).render(
  <StrictMode>
    <SoundEditor />
  </StrictMode>,
);
