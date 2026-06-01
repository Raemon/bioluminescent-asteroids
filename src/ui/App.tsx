import { Hud } from "./Hud";
import { Overlay } from "./Overlay";
import { FirstWaveHint } from "./FirstWaveHint";
import { TutorialControlsHint } from "./TutorialControlsHint";
import { BeatCalibrator } from "./BeatCalibrator";
import { SettingsDialog } from "./SettingsDialog";
import { PauseButton } from "./PauseButton";

export const App = () => (
  <>
    <Hud />
    <Overlay />
    <FirstWaveHint />
    <TutorialControlsHint />
    <BeatCalibrator />
    <SettingsDialog />
    <PauseButton />
  </>
);
