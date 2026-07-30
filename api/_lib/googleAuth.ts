import { OAuth2Client } from "google-auth-library";

// Verified identity extracted from a Google ID token (the JWT the browser gets
//   back from Google Identity Services). `sub` is the stable per-account id we
//   key users on; email/name/picture are best-effort profile fields.
export type GoogleIdentity = {
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
};

// The OAuth client id is the token's expected audience. Same value the browser
//   initializes GIS with; a token minted for a different client is rejected.
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? process.env.VITE_GOOGLE_CLIENT_ID ?? "";

// Reused across warm invocations — construction is cheap but the client caches
//   Google's public signing keys internally, so keeping one instance avoids
//   re-fetching the JWKS on every verify.
let client: OAuth2Client | null = null;
const getClient = (): OAuth2Client => {
  if (!client) client = new OAuth2Client(CLIENT_ID);
  return client;
};

export const googleAuthConfigured = (): boolean => CLIENT_ID.length > 0;

// Verify a Google ID token and return the identity, or null if the token is
//   missing, malformed, expired, or not minted for our client. Never throws on
//   an invalid token — callers treat null as "not authenticated".
export const verifyGoogleToken = async (
  idToken: unknown,
): Promise<GoogleIdentity | null> => {
  if (typeof idToken !== "string" || idToken.length === 0) return null;
  if (!googleAuthConfigured()) return null;
  try {
    const ticket = await getClient().verifyIdToken({
      idToken,
      audience: CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) return null;
    // Only accept verified-email tokens for anything email-derived; an
    //   unverified email shouldn't be trusted, but the account (sub) is still
    //   valid for identity/ownership purposes.
    const emailOk = payload.email && payload.email_verified;
    return {
      sub: payload.sub,
      email: emailOk ? payload.email! : null,
      name: payload.name ?? null,
      picture: payload.picture ?? null,
    };
  } catch {
    return null;
  }
};
