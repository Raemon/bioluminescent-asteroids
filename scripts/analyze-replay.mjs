// Offline replay analysis: pull the most recent saved replay(s) from the DB,
// gunzip the payload, and report header + checkpoint structure. Used to inspect
// a desync's recorded side without the browser. Throwaway diagnostic.
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

// minimal .env loader (DATABASE_URL only)
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL }) });

const rows = await prisma.highscore.findMany({
  where: { replayData: { not: null } },
  orderBy: { createdAt: "desc" },
  take: 5,
  select: { id: true, name: true, score: true, wave: true, createdAt: true, replayData: true },
});

console.log(`Found ${rows.length} recent saved replays\n`);

for (const row of rows) {
  const gz = Buffer.from(row.replayData, "base64");
  let payload;
  try {
    payload = JSON.parse(gunzipSync(gz).toString("utf8"));
  } catch (e) {
    console.log(`#${row.id} ${row.name}: DECODE FAILED — ${e.message}`);
    continue;
  }
  const h = payload.header;
  const cps = payload.checkpoints ?? [];
  const frames = payload.frames ?? [];
  console.log(`=== #${row.id} "${row.name}" score=${row.score} wave=${row.wave} @ ${row.createdAt.toISOString()} ===`);
  console.log(`  v=${h.v} build=${h.build} seed=${h.seed} beatOffset=${h.beatOffset} dims=${h.w}x${h.h}@${h.dpr}`);
  console.log(`  tutorial=${h.tutorial} veteran=${h.veteran} keyVocab=[${h.keyVocab.join(",")}]`);
  console.log(`  startBeat=${JSON.stringify(h.startBeat)}`);
  console.log(`  frames=${frames.length} checkpoints=${cps.length} beatResnaps=${(payload.beatResnaps ?? []).length} debugFrames=${(payload.debugFrames ?? []).length}`);
  // dt sanity (reduce, not spread — long runs overflow Math.min(...dts))
  if (frames.length) {
    let totalT = 0, min = Infinity, max = -Infinity;
    for (const f of frames) { totalT += f[0]; if (f[0] < min) min = f[0]; if (f[0] > max) max = f[0]; }
    console.log(`  dt: total=${totalT.toFixed(2)}s min=${(min*1000).toFixed(2)}ms max=${(max*1000).toFixed(2)}ms`);
  }
  // checkpoint rngState progression — first few + any anomalies
  if (cps.length) {
    console.log(`  first 6 checkpoints (frame: score/combo/ast/blt/aliens rng):`);
    for (const c of cps.slice(0, 6)) {
      console.log(`    f${c.frame}: ${c.score}/${c.beatCombo}/${c.asteroids}/${c.bullets}/${c.aliens} rng=${c.rngState>>>0} beatTime=${c.beatTime.toFixed(3)}`);
    }
  }
  // Full checkpoint dump for the single targeted replay (env TARGET=<id>): every
  //   checkpoint, flagging the frame where rngState first advances (first seeded
  //   draw) and where score/combo/wave first move — the candidate desync windows.
  if (cps.length && String(row.id) === process.env.TARGET) {
    console.log(`  --- FULL CHECKPOINT DUMP (#${row.id}) ---`);
    let prevRng = cps[0].rngState >>> 0;
    let prevScore = cps[0].score, prevWave = cps[0].wave, prevAst = cps[0].asteroids;
    for (const c of cps) {
      const rng = c.rngState >>> 0;
      const flags = [];
      if (rng !== prevRng) flags.push("RNG-ADVANCE");
      if (c.score !== prevScore) flags.push(`score${c.score - prevScore >= 0 ? "+" : ""}${c.score - prevScore}`);
      if (c.wave !== prevWave) flags.push(`WAVE→${c.wave}`);
      if (c.asteroids !== prevAst) flags.push(`ast${c.asteroids - prevAst >= 0 ? "+" : ""}${c.asteroids - prevAst}`);
      console.log(`    f${String(c.frame).padStart(6)}: sc=${String(c.score).padStart(7)} cmb=${String(c.beatCombo).padStart(3)} w=${c.wave} lv=${c.lives} ast=${c.asteroids} blt=${c.bullets} al=${c.aliens} bt=${c.beatTime.toFixed(3)} rng=${String(rng).padStart(10)}${flags.length ? "  <<< " + flags.join(" ") : ""}`);
      prevRng = rng; prevScore = c.score; prevWave = c.wave; prevAst = c.asteroids;
    }
  }
  console.log();
}

await prisma.$disconnect();
