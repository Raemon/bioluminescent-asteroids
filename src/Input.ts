// Shared input surface — the live Input class and the ReplayInput shim both
// implement this so gameUpdate doesn't need to know which one is driving.
export interface IInput {
  down(k: string): boolean;
  pressed(k: string): boolean;
  endFrame(): void;
  // Set of keys currently held — read by the replay recorder each frame to
  // diff against the previous snapshot.
  readonly keys: ReadonlySet<string>;
}

export class Input implements IInput {
  keys = new Set<string>();
  justPressed = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (!this.keys.has(k)) this.justPressed.add(k);
      this.keys.add(k);
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " ", "escape", "esc"].includes(k)) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
    });
  }

  down(k: string): boolean {
    return this.keys.has(k.toLowerCase());
  }

  pressed(k: string): boolean {
    return this.justPressed.has(k.toLowerCase());
  }

  endFrame() {
    this.justPressed.clear();
  }

  // Push a synthetic key state from non-keyboard sources (on-screen touch
  //   buttons). Mirrors what keydown/keyup do to keys + justPressed so the
  //   rest of the input layer doesn't need to know the press came from a
  //   finger instead of a key.
  setVirtual(k: string, down: boolean) {
    const key = k.toLowerCase();
    if (down) {
      if (!this.keys.has(key)) this.justPressed.add(key);
      this.keys.add(key);
    } else {
      this.keys.delete(key);
    }
  }
}
