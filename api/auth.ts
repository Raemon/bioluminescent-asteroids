import type { VercelRequest, VercelResponse } from "@vercel/node";
import { prisma } from "./_lib/prisma.js";
import { googleAuthConfigured, verifyGoogleToken } from "./_lib/googleAuth.js";
import { recomputeUserStats, toPublicUser } from "./_lib/users.js";

// Callsign length cap mirrors highscores.ts MAX_NAME_LEN and the client input's
//   maxLength — one source of truth would be nicer, but the API is deployed as
//   isolated serverless files.
const MAX_NAME_LEN = 16;

const sanitizeName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, MAX_NAME_LEN);
  if (trimmed.length === 0) return null;
  return trimmed;
};

// Find-or-create the user for a verified Google identity, refreshing the mutable
//   profile fields (Google display name / avatar can change) and the login
//   timestamp on every sign-in.
const upsertUser = async (identity: {
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}) => {
  return prisma.user.upsert({
    where: { googleSub: identity.sub },
    update: {
      email: identity.email,
      displayName: identity.name,
      picture: identity.picture,
      lastLoginAt: new Date(),
    },
    create: {
      googleSub: identity.sub,
      email: identity.email,
      displayName: identity.name,
      picture: identity.picture,
      lastLoginAt: new Date(),
    },
  });
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!googleAuthConfigured()) {
    res.status(503).json({ error: "Google sign-in is not configured on this server." });
    return;
  }

  const body = (req.body ?? {}) as { idToken?: unknown; action?: unknown; username?: unknown };
  const identity = await verifyGoogleToken(body.idToken);
  if (!identity) {
    res.status(401).json({ error: "Invalid or expired Google token." });
    return;
  }

  const action = typeof body.action === "string" ? body.action : "signin";

  try {
    // Plain sign-in: upsert and hand back the current profile + stats. New users
    //   have no username yet — the client then prompts them to claim one.
    if (action === "signin") {
      const user = await upsertUser(identity);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ user: toPublicUser(user) });
      return;
    }

    if (action === "claim") {
      const username = sanitizeName(body.username);
      if (!username) {
        res.status(400).json({ error: "Enter a callsign to claim." });
        return;
      }
      const usernameLower = username.toLowerCase();

      // Serialize the uniqueness check, the claim, and the adoption so two
      //   pilots racing for the same callsign can't both win.
      const result = await prisma.$transaction(async (tx) => {
        const me = await tx.user.upsert({
          where: { googleSub: identity.sub },
          update: {
            email: identity.email,
            displayName: identity.name,
            picture: identity.picture,
            lastLoginAt: new Date(),
          },
          create: {
            googleSub: identity.sub,
            email: identity.email,
            displayName: identity.name,
            picture: identity.picture,
            lastLoginAt: new Date(),
          },
        });

        const holder = await tx.user.findUnique({ where: { usernameLower } });
        if (holder && holder.id !== me.id) {
          return { conflict: true as const };
        }

        // Idempotent: re-claiming the same callsign just refreshes stats.
        await tx.user.update({
          where: { id: me.id },
          data: { username, usernameLower },
        });

        // Adopt every anonymous row under this callsign (case-insensitive) plus
        //   any already linked to this user — recompute covers the whole set.
        await tx.highscore.updateMany({
          where: {
            userId: null,
            name: { equals: username, mode: "insensitive" },
          },
          data: { userId: me.id },
        });

        return { conflict: false as const, userId: me.id };
      });

      if (result.conflict) {
        res.status(409).json({ error: "That callsign is already claimed by another pilot." });
        return;
      }

      await recomputeUserStats(result.userId);
      const fresh = await prisma.user.findUnique({ where: { id: result.userId } });
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ user: fresh ? toPublicUser(fresh) : null });
      return;
    }

    res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    console.error("[auth POST] failed:", err);
    res.status(500).json({ error: "Auth request failed." });
  }
}
