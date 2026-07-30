# Google sign-in + claimed callsigns — setup

Adds "Sign in with Google" to the score-entry form so a pilot can **claim a
callsign** (nobody else can then submit under it) and accumulate **persistent
lifetime stats**. Uses [Google Identity Services][gis] (the lightweight ID-token
button) — no OAuth redirect, no session cookies. The browser gets a signed JWT,
sends it with score submissions, and the serverless API verifies it with
`google-auth-library`.

Everything degrades gracefully: with no client ID configured, the sign-in UI is
simply hidden and guest play works exactly as before.

## 1. Create the OAuth client ID (only you can do this)

1. Go to <https://console.cloud.google.com/apis/credentials> and pick (or
   create) a project.
2. If prompted, configure the **OAuth consent screen**: User type **External**,
   app name "Pulsar", your support email. You can leave it in "Testing" while
   developing, then **Publish** it so any Google user can sign in.
3. **Create Credentials → OAuth client ID → Application type: Web application.**
4. Under **Authorized JavaScript origins** add every origin the button loads on:
   - `https://playpulsar.com`
   - `https://www.playpulsar.com` (if used)
   - `http://localhost:5173` (dev — add the exact port; if the dev server
     auto-picks another port, add that origin too, or run with `PORT=5173`)
   You do **not** need Authorized redirect URIs — the ID-token button doesn't
   redirect.
5. Copy the **Client ID** (looks like `1234567890-abc123.apps.googleusercontent.com`).
   It's a public value — safe to expose in the browser bundle.

## 2. Set environment variables

The same client-ID value is used on the client (audience the button requests)
and the server (audience the token is verified against).

**Local** — add to `.env.local`:

```
VITE_GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
```

`.env.local` also needs `DATABASE_URL` (and optionally `DIRECT_DATABASE_URL`)
for the local API routes to reach the DB — pull them with `vercel env pull` if
they aren't already there.

**Vercel** — add both vars in Project → Settings → Environment Variables
(Production + Preview). `VITE_`-prefixed vars are read at **build time**, so
trigger a fresh deploy after adding them.

## 3. Run the database migration

A migration was added at
`prisma/migrations/20260730000000_add_users_and_ownership/` — it creates the
`users` table and adds `highscores.user_id`.

- Local dev DB: `npm run db:migrate`
- Production (Neon): `npm run db:deploy`

Both read the connection string from `DIRECT_DATABASE_URL ?? DATABASE_URL`
(see `prisma.config.ts`).

## How it behaves

- **Claim locks the name.** Signing in and claiming a callsign reserves it
  (case-insensitive). After that, submitting under it requires being signed in
  as the owner (HTTP 403 otherwise). **Unclaimed** names stay open to guests —
  existing anonymous scores are unaffected.
- **Adoption.** When you claim a callsign, all existing *anonymous* highscores
  matching that name are linked to your account and folded into your stats
  (first-come-first-served, since names were never protected before).
- **Persistent stats.** Each signed-in run bumps your lifetime totals (games
  played, best score / wave / combo, total kills, total score, last played).
  Shown as a line under the form right after you submit, and as a banner atop
  your pilot-profile page on the leaderboard.

## Files

- `prisma/schema.prisma` — `User` model + `Highscore.userId`.
- `api/_lib/googleAuth.ts` — ID-token verification.
- `api/_lib/users.ts` — public-user serialization + stat recompute.
- `api/auth.ts` — `POST` sign-in / claim endpoint.
- `api/highscores.ts` — name protection + stat bump on submit; profile stats.
- `src/game/auth.ts` — client GIS loader, session state, claim call.
- `src/game/scoreEntry.ts` — sign-in / claim UI, stats line, profile banner.

[gis]: https://developers.google.com/identity/gsi/web
