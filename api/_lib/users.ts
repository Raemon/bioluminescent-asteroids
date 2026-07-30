import { prisma } from "./prisma.js";

// The user shape returned to the browser. Never leaks googleSub or email —
//   just the claimed callsign, avatar, and the denormalized lifetime stats the
//   profile banner renders.
export type PublicUser = {
  username: string | null;
  displayName: string | null;
  picture: string | null;
  memberSince: string;
  stats: {
    gamesPlayed: number;
    bestScore: number;
    bestWave: number;
    bestCombo: number;
    totalKills: number;
    totalScore: number;
    lastPlayedAt: string | null;
  };
};

type UserRow = {
  username: string | null;
  displayName: string | null;
  picture: string | null;
  createdAt: Date;
  gamesPlayed: number;
  bestScore: number;
  bestWave: number;
  bestCombo: number;
  totalKills: number;
  totalScore: bigint;
  lastPlayedAt: Date | null;
};

export const toPublicUser = (u: UserRow): PublicUser => ({
  username: u.username,
  displayName: u.displayName,
  picture: u.picture,
  memberSince: u.createdAt.toISOString(),
  stats: {
    gamesPlayed: u.gamesPlayed,
    bestScore: u.bestScore,
    bestWave: u.bestWave,
    bestCombo: u.bestCombo,
    totalKills: u.totalKills,
    // totalScore can exceed 2^31 across many runs; it's a BigInt column. Clamp
    //   to a JS-safe number for the JSON payload — display only, so precision
    //   past 2^53 is irrelevant.
    totalScore: Number(u.totalScore),
    lastPlayedAt: u.lastPlayedAt ? u.lastPlayedAt.toISOString() : null,
  },
});

// Recompute a user's lifetime stats from scratch over every linked highscore.
//   Used after a claim adopts a batch of anonymous rows (an incremental bump
//   would miss the adopted history). Aggregates in SQL so we never pull rows.
export const recomputeUserStats = async (userId: number): Promise<void> => {
  const agg = await prisma.highscore.aggregate({
    where: { userId },
    _count: { _all: true },
    _max: { score: true, wave: true, maxCombo: true },
    _sum: { killCount: true, score: true },
  });
  await prisma.user.update({
    where: { id: userId },
    data: {
      gamesPlayed: agg._count._all,
      bestScore: agg._max.score ?? 0,
      bestWave: agg._max.wave ?? 0,
      bestCombo: agg._max.maxCombo ?? 0,
      totalKills: agg._sum.killCount ?? 0,
      totalScore: BigInt(agg._sum.score ?? 0),
    },
  });
};
