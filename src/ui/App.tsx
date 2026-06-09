import { Hud } from "./Hud";
import { Overlay } from "./Overlay";
import { FirstWaveHint } from "./FirstWaveHint";
import { TutorialControlsHint } from "./TutorialControlsHint";
import { RhythmLossHint } from "./RhythmLossHint";
import { BeatCalibrator } from "./BeatCalibrator";
import { IntroSequence } from "./IntroSequence";
import { SettingsDialog } from "./SettingsDialog";
import { PauseButton } from "./PauseButton";
import { DevLogPopup } from "./DevLogPopup";
import { TouchControls } from "./TouchControls";

export const App = () => (
  <>
    <Hud />
    <Overlay />
    <FirstWaveHint />
    <TutorialControlsHint />
    <RhythmLossHint />
    <BeatCalibrator />
    <IntroSequence />
    <SettingsDialog />
    <PauseButton />
    <DevLogPopup />
    <TouchControls />
  </>
);
