import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MusicMixer } from "./MusicMixer";
import "../../style.css";

const rootEl = document.getElementById("music-root");
if (!rootEl) throw new Error("Music editor root #music-root not found");
createRoot(rootEl).render(
  <StrictMode>
    <MusicMixer />
  </StrictMode>,
);
