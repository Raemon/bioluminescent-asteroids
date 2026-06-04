import type { VercelRequest, VercelResponse } from "@vercel/node";
import { prisma } from "./_lib/prisma.js";

const MAX_NAME_LEN = 16;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;
const TOP_PILOTS_LIMIT = 20;
// Pull a generous window so 20 unique pilots are reachable even when a few
//   pilots occupy many of the top slots.
const TOP_PILOTS_SCAN = 300;
const TOP_ROWS_CACHE_LIMIT = 100;

type KillSummary = Record<string, number>;

type IncomingScore = {
  name?: unknown;
  score?: unknown;
  wave?: unknown;
  max_combo?: unknown;
  kill_count?: unknown;
  kill_summary?: unknown;
};

type RowOut = {
  id: number;
  name: string;
  score: number;
  wave: number;
  max_combo: number;
  kill_count: number;
  kill_summary: KillSummary;
  created_at: Date | string;
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

const toRowOut = (r: {
  id: number;
  name: string;
  score: number;
  wave: number;
  maxCombo: number;
  killCount: number;
  killSummary: unknown;
  createdAt: Date;
}): RowOut => ({
  id: r.id,
  name: r.name,
  score: r.score,
  wave: r.wave,
  max_combo: r.maxCombo,
  kill_count: r.killCount,
  kill_summary: (r.killSummary ?? {}) as KillSummary,
  created_at: r.createdAt,
});

// Mirrors src/game/scoreEntry.ts dedupeByName: for each pilot, keep best-by-
//   score, best-by-wave, best-by-rhythm; collapse to a single row when one run
//   holds multiple PBs. Returns rows for the first `pilotLimit` unique pilots
//   encountered in `rows` (which the caller has already sorted by score desc).
const dedupeByPilot = (rows: RowOut[], pilotLimit: number): RowOut[] => {
  const byPilot = new Map<string, RowOut[]>();
  const pilotOrder: string[] = [];
  for (const row of rows) {
    const key = row.name.toLowerCase();
    let list = byPilot.get(key);
    if (!list) {
      if (pilotOrder.length >= pilotLimit) continue;
      list = [];
      byPilot.set(key, list);
      pilotOrder.push(key);
    }
    list.push(row);
  }
  const keptIds = new Set<number>();
  const out: RowOut[] = [];
  for (const key of pilotOrder) {
    const pilotRows = byPilot.get(key)!;
    const bestScore = pickBest(pilotRows, (a, b) =>
      a.score !== b.score ? a.score > b.score : (a.max_combo ?? 0) > (b.max_combo ?? 0),
    );
    const bestWave = pickBest(pilotRows, (a, b) => {
      const aw = a.wave ?? 0, bw = b.wave ?? 0;
      return aw !== bw ? aw > bw : a.score > b.score;
    });
    const bestRhythm = pickBest(pilotRows, (a, b) => {
      const ac = a.max_combo ?? 0, bc = b.max_combo ?? 0;
      return ac !== bc ? ac > bc : a.score > b.score;
    });
    for (const row of [bestScore, bestWave, bestRhythm]) {
      if (row && !keptIds.has(row.id)) {
        keptIds.add(row.id);
        out.push(row);
      }
    }
  }
  return out;
};

const pickBest = (rows: RowOut[], better: (a: RowOut, b: RowOut) => boolean): RowOut | null => {
  let best: RowOut | null = null;
  for (const row of rows) {
    if (!best || better(row, best)) best = row;
  }
  return best;
};

// Module-level cache survives across warm-invocation reuse on the same
//   serverless instance. Cross-instance staleness is bounded by the edge
//   Cache-Control TTL set on responses below. POSTs clear the local cache so
//   the next read on this instance reflects the new row.
type CacheEntry<T> = { value: T; expires: number };
const CACHE_TTL_MS = 60_000;
let topPilotsCache: CacheEntry<RowOut[]> | null = null;
let topRowsCache: CacheEntry<RowOut[]> | null = null;

const readCache = <T>(entry: CacheEntry<T> | null): T | null => {
  if (!entry) return null;
  if (entry.expires < Date.now()) return null;
  return entry.value;
};

const invalidateCaches = () => {
  topPilotsCache = null;
  topRowsCache = null;
};

const fetchTopPilots = async (): Promise<RowOut[]> => {
  const cached = readCache(topPilotsCache);
  if (cached) return cached;
  const rows = await prisma.highscore.findMany({
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    take: TOP_PILOTS_SCAN,
  });
  const deduped = dedupeByPilot(rows.map(toRowOut), TOP_PILOTS_LIMIT);
  topPilotsCache = { value: deduped, expires: Date.now() + CACHE_TTL_MS };
  return deduped;
};

const fetchTopRows = async (): Promise<RowOut[]> => {
  const cached = readCache(topRowsCache);
  if (cached) return cached;
  const rows = await prisma.highscore.findMany({
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    take: TOP_ROWS_CACHE_LIMIT,
  });
  const mapped = rows.map(toRowOut);
  topRowsCache = { value: mapped, expires: Date.now() + CACHE_TTL_MS };
  return mapped;
};

const setEdgeCache = (res: VercelResponse) => {
  // Short edge cache bounds cross-instance staleness; SWR lets the edge serve
  //   a slightly stale payload while a background revalidation fetches fresh.
  res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const modeRaw = req.query.mode;
    const mode = Array.isArray(modeRaw) ? modeRaw[0] : modeRaw;

    if (mode === "top-pilots") {
      try {
        const rows = await fetchTopPilots();
        setEdgeCache(res);
        res.status(200).json({ scores: rows });
      } catch (err) {
        console.error("[highscores GET top-pilots] db read failed:", err);
        res.status(500).json({ error: "DB read failed" });
      }
      return;
    }

    const limitRaw = req.query.limit;
    const offsetRaw = req.query.offset;
    const requested = sanitizeInt(Array.isArray(limitRaw) ? limitRaw[0] : limitRaw, 1, MAX_LIMIT);
    const limit = requested ?? DEFAULT_LIMIT;
    const offset = sanitizeInt(Array.isArray(offsetRaw) ? offsetRaw[0] : offsetRaw, 0, 1_000_000) ?? 0;

    // The hot read path is "first page, no offset" — that's what gets cached.
    //   Paged reads past the cache window fall through to a direct DB query.
    if (offset === 0 && limit <= TOP_ROWS_CACHE_LIMIT) {
      try {
        const rows = await fetchTopRows();
        setEdgeCache(res);
        res.status(200).json({ scores: rows.slice(0, limit) });
      } catch (err) {
        console.error("[highscores GET] db read failed:", err);
        res.status(500).json({ error: "DB read failed" });
      }
      return;
    }

    try {
      const rows = await prisma.highscore.findMany({
        orderBy: [{ score: "desc" }, { createdAt: "desc" }],
        take: limit,
        skip: offset,
      });
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ scores: rows.map(toRowOut) });
    } catch (err) {
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
    const maxCombo = sanitizeInt(body.max_combo, 0, 1_000_000) ?? 0;
    const killCount = sanitizeInt(body.kill_count, 0, 1_000_000) ?? 0;
    const killSummary = sanitizeKillSummary(body.kill_summary);
    if (!name || score === null) {
      res.status(400).json({ error: "name and score are required" });
      return;
    }
    try {
      const row = await prisma.highscore.create({
        data: { name, score, wave, maxCombo, killCount, killSummary },
      });
      // Clear local cache so the next read on this instance reflects the new
      //   row. Other warm instances still serve their cached payload until
      //   their TTL expires or they receive their own POST.
      invalidateCaches();
      // Warm both caches in the background so the next GET on this instance
      //   doesn't pay the DB round-trip. Errors here are non-fatal.
      void fetchTopPilots().catch((err) =>
        console.error("[highscores POST] cache warm top-pilots failed:", err),
      );
      void fetchTopRows().catch((err) =>
        console.error("[highscores POST] cache warm top-rows failed:", err),
      );
      res.status(201).json({ score: toRowOut(row) });
    } catch (err) {
      console.error("[highscores POST] db write failed:", err);
      res.status(500).json({ error: "DB write failed" });
    }
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed" });
}
