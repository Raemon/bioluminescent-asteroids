import { spawnSync } from "node:child_process";
if (!process.env.__T) { const r = spawnSync(process.execPath, ["--import","tsx",new URL(import.meta.url).pathname], {stdio:"inherit",env:{...process.env,__T:"1"}}); process.exit(r.status??1); }
globalThis.__comboLog = true;
const DIMS={w:1920,h:1080,dpr:2};
const { installHeadlessStubs } = await import("./headless-stubs.mjs");
const { makeCanvas } = await import("./headless-stubs.mjs");
const { windowStub } = installHeadlessStubs(DIMS);
// load #338 from DB
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
for (const l of readFileSync(new URL("../.env",import.meta.url),"utf8").split("\n")){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,"");}
const { PrismaClient } = await import("@prisma/client");
const { PrismaNeon } = await import("@prisma/adapter-neon");
const prisma=new PrismaClient({adapter:new PrismaNeon({connectionString:process.env.DATABASE_URL})});
const row=await prisma.highscore.findUnique({where:{id:338},select:{replayData:true}});
await prisma.$disconnect();
const payload=JSON.parse(gunzipSync(Buffer.from(row.replayData,"base64")).toString("utf8"));
const { Game } = await import("../src/Game.ts");
const { startReplay } = await import("../src/game/lifecycle.ts");
const { encodeReplay } = await import("../src/game/replayFormat.ts");
const g = new Game(makeCanvas(DIMS.w,DIMS.h));
console.log("=== RE-SIM combo trace (only the [combo] lines near f540 matter) ===");
await startReplay(g, await encodeReplay(payload));
