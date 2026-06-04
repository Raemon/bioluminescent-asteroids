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
}
