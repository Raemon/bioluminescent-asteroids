import type { VercelRequest, VercelResponse } from "@vercel/node";
import { prisma } from "./_lib/prisma.js";

// 256 KB after base64 expansion (≈190 KB binary). Typical replays land at
//   ~3-8 KB gzipped, so this caps clearly-malicious payloads without rejecting
//   any real run.
const MAX_REPLAY_B64_LEN = 256 * 1024;
const MAX_NAME_LEN = 16;

type IncomingReplay = {
  scoreId?: unknown;
  name?: unknown;
  data?: unknown;  // base64 of gzipped JSON
};

const sanitizeInt = (raw: unknown, min: number, max: number): number | null => {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < min || i > max) return null;
  return i;
};

const sanitizeName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, MAX_NAME_LEN);
  return trimmed.length === 0 ? null : trimmed;
};

const isBase64 = (s: string): boolean => /^[A-Za-z0-9+/=]+$/.test(s);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const idRaw = req.query.id;
    const id = sanitizeInt(Array.isArray(idRaw) ? idRaw[0] : idRaw, 1, 2_147_483_647);
    if (id === null) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    try {
      const row = await prisma.highscore.findUnique({
        where: { id },
        select: { replayData: true },
      });
      if (!row || !row.replayData) {
        res.status(404).json({ error: "no replay for that score" });
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
      res.status(200).json({ data: row.replayData });
    } catch (err) {
      console.error("[replays GET] db read failed:", err);
      res.status(500).json({ error: "DB read failed" });
    }
    return;
  }

  if (req.method === "POST") {
    const body = (req.body ?? {}) as IncomingReplay;
    const scoreId = sanitizeInt(body.scoreId, 1, 2_147_483_647);
    const name = sanitizeName(body.name);
    if (scoreId === null || !name) {
      res.status(400).json({ error: "scoreId and name are required" });
      return;
    }
    if (typeof body.data !== "string" || body.data.length === 0) {
      res.status(400).json({ error: "data is required" });
      return;
    }
    if (body.data.length > MAX_REPLAY_B64_LEN) {
      res.status(413).json({ error: "replay too large" });
      return;
    }
    if (!isBase64(body.data)) {
      res.status(400).json({ error: "data must be base64" });
      return;
    }
    try {
      // Bind the upload to the (scoreId, name) pair so a watcher can't overwrite
      //   another pilot's replay just by guessing an id. The name+id pair is
      //   already enforced as the canonical identity in the leaderboard UI.
      const row = await prisma.highscore.findUnique({
        where: { id: scoreId },
        select: { id: true, name: true, replayData: true },
      });
      if (!row) {
        res.status(404).json({ error: "no such score" });
        return;
      }
      if (row.name.toLowerCase() !== name.toLowerCase()) {
        res.status(403).json({ error: "name does not match score" });
        return;
      }
      if (row.replayData) {
        // Single-write per score keeps things tidy and stops accidental
        //   overwrites if the user clicks twice.
        res.status(409).json({ error: "replay already saved" });
        return;
      }
      await prisma.highscore.update({
        where: { id: scoreId },
        data: { replayData: body.data },
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error("[replays POST] db write failed:", err);
      res.status(500).json({ error: "DB write failed" });
    }
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed" });
}
