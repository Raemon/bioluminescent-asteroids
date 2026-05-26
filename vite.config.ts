import { defineConfig } from "vite";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

// Clean-URL middleware: rewrite extensionless /soundeditor → /soundeditor.html
// so the address bar can show /soundeditor in dev/preview.
const cleanUrls = () => ({
  name: "clean-urls",
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, _res: unknown, next: () => void) => void) => void } }) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/soundeditor") req.url = "/soundeditor.html";
      next();
    });
  },
  configurePreviewServer(server: { middlewares: { use: (fn: (req: { url?: string }, _res: unknown, next: () => void) => void) => void } }) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/soundeditor") req.url = "/soundeditor.html";
      next();
    });
  },
});

// Dev-only writer for /sounds/config.json — the sound editor PUTs new
// tuning values back to disk on every knob change so commits can capture
// them. Only active under `vite dev`; the production build never receives
// these writes (the editor still works in prod-preview, but changes only
// live in localStorage if you ever expose it there).
const soundConfigWriter = () => {
  const target = resolve(__dirname, "sounds/config.json");
  return {
    name: "sound-config-writer",
    configureServer(server: {
      middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void };
    }) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__sound-config__" || req.method !== "POST") {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            // Validate JSON before writing — don't trash the file on a
            // malformed payload.
            JSON.parse(body);
            await writeFile(target, body, "utf8");
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
        req.on("error", () => {
          res.statusCode = 500;
          res.end("read error");
        });
      });
    },
  };
};

export default defineConfig({
  server: {
    host: true,
  },
  plugins: [cleanUrls(), soundConfigWriter()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        soundeditor: resolve(__dirname, "soundeditor.html"),
      },
    },
  },
});
