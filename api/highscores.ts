import type { VercelRequest, VercelResponse } from "@vercel/node";
import { prisma } from "./_lib/prisma.js";

const MAX_NAME_LEN = 16;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

type KillSummary = Record<string, number>;

type IncomingScore = {
  name?: unknown;
  score?: unknown;
  wave?: unknown;
  kill_count?: unknown;
  kill_summary?: unknown;
};

const sanitizeName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, MAX_NAME_LEN);
  if (trimmed.length === 0) return null;
  return trimmed;
};

const sanitizeInt = (raw: unknown, min: number, max: number): number | null => {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < min || i > max) return null;
  return i;
};

const sanitizeKillSummary = (raw: unknown): KillSummary => {
  if (!raw || typeof raw !== "object") return {};
  const out: KillSummary = {};
  let kept = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= 32) break;
    if (typeof k !== "string" || k.length === 0 || k.length > 32) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) continue;
    out[k] = Math.floor(n);
    kept++;
  }
  return out;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const limitRaw = req.query.limit;
    const requested = sanitizeInt(Array.isArray(limitRaw) ? limitRaw[0] : limitRaw, 1, MAX_LIMIT);
    const limit = requested ?? DEFAULT_LIMIT;
    try {
      const rows = await prisma.highscore.findMany({
        orderBy: [{ score: "desc" }, { createdAt: "desc" }],
        take: limit,
      });
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        scores: rows.map((r) => ({
          id: r.id,
          name: r.name,
          score: r.score,
          wave: r.wave,
          kill_count: r.killCount,
          kill_summary: r.killSummary,
          created_at: r.createdAt,
        })),
      });
    } catch (err) {
      // Why: don't leak DB internals to clients — log on the server, return a generic message.
      console.error("[highscores GET] db read failed:", err);
      res.status(500).json({ error: "DB read failed" });
    }
    return;
  }

  if (req.method === "POST") {
    const body = (req.body ?? {}) as IncomingScore;
    const name = sanitizeName(body.name);
    const score = sanitizeInt(body.score, 0, 1_000_000_000);
    const wave = sanitizeInt(body.wave, 1, 10_000) ?? 1;
    const killCount = sanitizeInt(body.kill_count, 0, 1_000_000) ?? 0;
    const killSummary = sanitizeKillSummary(body.kill_summary);
    if (!name || score === null) {
      res.status(400).json({ error: "name and score are required" });
      return;
    }
    try {
      const row = await prisma.highscore.create({
        data: { name, score, wave, killCount, killSummary },
      });
      res.status(201).json({
        score: {
          id: row.id,
          name: row.name,
          score: row.score,
          wave: row.wave,
          kill_count: row.killCount,
          kill_summary: row.killSummary,
          created_at: row.createdAt,
        },
      });
    } catch (err) {
      // Why: don't leak DB internals to clients — log on the server, return a generic message.
      console.error("[highscores POST] db write failed:", err);
      res.status(500).json({ error: "DB write failed" });
    }
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed" });
}
