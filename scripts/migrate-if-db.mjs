import { spawnSync } from "node:child_process";
import "dotenv/config";

const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!url) {
  console.log("migrate-if-db: no database url configured, skipping migrate deploy");
  process.exit(0);
}
const r = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit" });
process.exit(r.status ?? 1);
