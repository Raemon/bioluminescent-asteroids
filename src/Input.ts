export class Input {
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
