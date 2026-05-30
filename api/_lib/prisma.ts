import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

// serverless functions get reused across invocations — caching the client
// avoids opening a fresh connection on every request.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL not configured");

export const prisma =
  globalThis.__prisma ??
  new PrismaClient({ adapter: new PrismaNeon({ connectionString }) });

if (process.env.NODE_ENV !== "production") globalThis.__prisma = prisma;
