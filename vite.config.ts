import { defineConfig, type ViteDevServer } from "vite";
import { resolve } from "node:path";
import { writeFile, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config as loadDotenv } from "dotenv";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

loadDotenv();

// Clean-URL middleware: rewrite extensionless /sound → /sound.html and
// /music → /music.html so the address bar can show clean paths in dev/preview.
const cleanUrls = () => {
  const rewrite = (req: { url?: string }) => {
    if (req.url === "/sound") req.url = "/sound.html";
    else if (req.url === "/music") req.url = "/music.html";
  };
  return {
    name: "clean-urls",
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, _res: unknown, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => { rewrite(req); next(); });
    },
    configurePreviewServer(server: { middlewares: { use: (fn: (req: { url?: string }, _res: unknown, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => { rewrite(req); next(); });
    },
  };
};

// Dev-only writer for /sounds/config.json — the /sound page PUTs new tuning
// values back to disk on every knob change so commits can capture them. Only
// active under `vite dev`; the production build never receives these writes
// (the page still works in prod-preview, but changes only live in
// localStorage if you ever expose it there).
const soundConfigWriter = () => {
  const target = resolve(__dirname, "public/sounds/config.json");
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

// Dev-only writer for offline-rendered Tone.js bake buffers. The browser POSTs
// a WAV blob via POST /__bake-dump__?key=<name>__<pitchKey>; this plugin pipes
// it through ffmpeg into an MP3 at public/sounds/baked/<key>.mp3. Same idea
// as soundConfigWriter — playing the game in dev produces the static files
// you then commit, and prod fetches them with no Tone.js bake at all.
//
// "Existing file wins": we skip the write if the file is already on disk so
// regular gameplay doesn't churn already-good bakes. Delete the file (or the
// whole baked/ dir) to force a re-bake on next play.
const bakeDumpWriter = () => {
  const dir = resolve(__dirname, "public/sounds/baked");
  // Path-traversal guard: a malicious key like "../../etc/foo" would escape
  // the baked/ dir. Allow only the alphabet our bakedKey() function emits.
  const safeKey = (k: string) => /^[A-Za-z0-9_.\-]+$/.test(k);
  const fileExists = async (p: string) => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  };
  const encodeWavToMp3 = (wav: Buffer, outPath: string): Promise<void> =>
    new Promise((resolveEncode, rejectEncode) => {
      // -y overwrite, -i pipe:0 WAV in, -codec:a libmp3lame, -q:a 4 (~165kbps VBR)
      // -loglevel error keeps the dev console quiet on success.
      const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", "pipe:0", "-codec:a", "libmp3lame", "-q:a", "4", outPath]);
      let stderr = "";
      ff.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
      ff.on("error", rejectEncode);
      ff.on("close", (code: number) => {
        if (code === 0) resolveEncode();
        else rejectEncode(new Error(`ffmpeg exited ${code}: ${stderr}`));
      });
      ff.stdin.end(wav);
    });
  return {
    name: "bake-dump-writer",
    configureServer(server: {
      middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void };
    }) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/__bake-dump__") || req.method !== "POST") {
          next();
          return;
        }
        const [, search = ""] = url.split("?");
        const key = new URLSearchParams(search).get("key") ?? "";
        if (!key || !safeKey(key)) {
          res.statusCode = 400;
          res.end("invalid key");
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
          const out = resolve(dir, `${key}.mp3`);
          try {
            await mkdir(dir, { recursive: true });
            if (await fileExists(out)) {
              // Existing file wins — don't overwrite on every replay.
              res.statusCode = 200;
              res.end(JSON.stringify({ ok: true, skipped: true }));
              return;
            }
            const wav = Buffer.concat(chunks);
            await encodeWavToMp3(wav, out);
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, wrote: out }));
            // eslint-disable-next-line no-console
            console.log(`[bake-dump] wrote ${out}`);
          } catch (err) {
            res.statusCode = 500;
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

// Dev-only adapter that serves /api/* by loading the Vercel-style handlers
// (api/*.ts) through Vite's SSR module loader and feeding them a minimal
// VercelRequest/VercelResponse shape. In prod these run on Vercel; this just
// closes the gap locally so the leaderboard can talk to the dev DB.
const devApi = () => {
  type Handler = (req: any, res: any) => void | Promise<void>;
  const routes: Record<string, string> = {
    "/api/highscores": "/api/highscores.ts",
    "/api/replays": "/api/replays.ts",
  };

  const decorateRes = (res: ServerResponse) => {
    const r = res as ServerResponse & {
      status: (code: number) => typeof r;
      json: (body: unknown) => typeof r;
      send: (body: unknown) => typeof r;
    };
    r.status = (code) => {
      r.statusCode = code;
      return r;
    };
    r.json = (body) => {
      if (!r.getHeader("content-type")) r.setHeader("content-type", "application/json");
      r.end(JSON.stringify(body));
      return r;
    };
    r.send = (body) => {
      if (body == null) r.end();
      else if (typeof body === "string" || Buffer.isBuffer(body)) r.end(body as any);
      else r.json(body);
      return r;
    };
    return r;
  };

  const parseBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolveBody, rejectBody) => {
      const method = (req.method ?? "GET").toUpperCase();
      if (method === "GET" || method === "HEAD") return resolveBody(undefined);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.length === 0) return resolveBody(undefined);
        const ct = String(req.headers["content-type"] ?? "");
        if (ct.includes("application/json")) {
          try {
            resolveBody(JSON.parse(raw));
          } catch (err) {
            rejectBody(err);
          }
        } else {
          resolveBody(raw);
        }
      });
      req.on("error", rejectBody);
    });

  return {
    name: "dev-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url ?? "";
        const [pathname, search = ""] = rawUrl.split("?");
        const handlerPath = routes[pathname];
        if (!handlerPath) return next();

        try {
          const mod = await server.ssrLoadModule(handlerPath);
          const handler = (mod.default ?? mod.handler) as Handler | undefined;
          if (typeof handler !== "function") {
            res.statusCode = 500;
            res.end(`No default export from ${handlerPath}`);
            return;
          }

          const query: Record<string, string | string[]> = {};
          for (const [k, v] of new URLSearchParams(search)) {
            const existing = query[k];
            if (existing === undefined) query[k] = v;
            else if (Array.isArray(existing)) existing.push(v);
            else query[k] = [existing, v];
          }

          const body = await parseBody(req);
          const vReq = Object.assign(req, { query, cookies: {}, body });
          const vRes = decorateRes(res);
          await handler(vReq, vRes);
        } catch (err) {
          console.error(`[dev-api] ${pathname} failed:`, err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "dev-api handler threw" }));
          } else {
            res.end();
          }
        }
      });
    },
  };
};

export default defineConfig({
  server: {
    host: true,
  },
  plugins: [react(), tailwindcss(), cleanUrls(), soundConfigWriter(), bakeDumpWriter(), devApi()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        sound: resolve(__dirname, "sound.html"),
        music: resolve(__dirname, "music.html"),
      },
    },
  },
});
