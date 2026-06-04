import type { IInput } from "../Input";

// Drop-in IInput for replay playback. The ReplayPlayer rebuilds `keys` and
// `justPressed` each frame from the recorded down/up bitmasks before the
// normal updatePlaying() reads from it.
export class ReplayInput implements IInput {
  keys = new Set<string>();
  justPressed = new Set<string>();

  applyFrame(downKeys: readonly string[], upKeys: readonly string[]): void {
    this.justPressed.clear();
    for (const k of downKeys) {
      if (!this.keys.has(k)) this.justPressed.add(k);
      this.keys.add(k);
    }
    for (const k of upKeys) this.keys.delete(k);
  }

  down(k: string): boolean {
    return this.keys.has(k.toLowerCase());
  }

  pressed(k: string): boolean {
    return this.justPressed.has(k.toLowerCase());
  }

  endFrame(): void {
    this.justPressed.clear();
  }
}
