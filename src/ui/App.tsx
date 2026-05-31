import { Hud } from "./Hud";
import { Overlay } from "./Overlay";
import { FirstWaveHint } from "./FirstWaveHint";
import { BeatCalibrator } from "./BeatCalibrator";
import { SettingsDialog } from "./SettingsDialog";

export const App = () => (
  <>
    <Hud />
    <Overlay />
    <FirstWaveHint />
    <BeatCalibrator />
    <SettingsDialog />
  </>
);
