// Google sign-in for claiming a callsign. Uses Google Identity Services (the
//   lightweight `accounts.google.com/gsi/client` script) — no OAuth redirect,
//   no session cookies. The browser gets an ID token (a JWT) which we send with
//   score submissions; the server verifies it. Everything degrades gracefully
//   when VITE_GOOGLE_CLIENT_ID is unset: isAuthAvailable() is false and the UI
//   simply omits the sign-in affordance.

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

type AuthState = {
  token: string;
  expiresAt: number; // ms epoch
  user: PublicUser | null;
};

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const TOKEN_KEY = "pulsar.auth.token";
const USER_KEY = "pulsar.auth.user";

// Minimal shape of the pieces of the GIS global we touch.
type GsiId = {
  initialize: (cfg: {
    client_id: string;
    callback: (resp: { credential?: string }) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }) => void;
  renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
  disableAutoSelect: () => void;
};
declare global {
  interface Window {
    google?: { accounts?: { id?: GsiId } };
  }
}

let state: AuthState | null = null;
const listeners = new Set<() => void>();
let gisReady: Promise<boolean> | null = null;
let initialized = false;

export const isAuthAvailable = (): boolean => CLIENT_ID.length > 0;

export const onAuthChange = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const emit = () => listeners.forEach((cb) => cb());

// Decode a JWT payload without verifying it — for reading `exp` and profile
//   fields to render locally. The server does the real verification.
const decodeJwt = (token: string): Record<string, unknown> | null => {
  try {
    const part = token.split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const persist = () => {
  try {
    if (state) {
      localStorage.setItem(TOKEN_KEY, state.token);
      localStorage.setItem(USER_KEY, JSON.stringify(state.user));
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  } catch {
    // localStorage may be blocked; in-memory state still works for the session.
  }
};

const restore = () => {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    const payload = decodeJwt(token);
    const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : 0;
    // Drop an already-expired token — a stale one only yields 401s on submit.
    if (!exp || exp <= Date.now()) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      return;
    }
    let user: PublicUser | null = null;
    const rawUser = localStorage.getItem(USER_KEY);
    if (rawUser) user = JSON.parse(rawUser) as PublicUser;
    state = { token, expiresAt: exp, user };
  } catch {
    // ignore corrupt cache
  }
};

export const isSignedIn = (): boolean =>
  state !== null && state.expiresAt > Date.now();

export const currentUser = (): PublicUser | null => (isSignedIn() ? state!.user : null);

// The token to attach to a score submission, or null if signed out / expired.
export const getIdToken = (): string | null =>
  state && state.expiresAt > Date.now() ? state.token : null;

// Load the GIS script once and initialize the id client with our callback.
const loadGis = (): Promise<boolean> => {
  if (!isAuthAvailable()) return Promise.resolve(false);
  if (gisReady) return gisReady;
  gisReady = new Promise<boolean>((resolve) => {
    if (window.google?.accounts?.id) return resolve(true);
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(!!window.google?.accounts?.id);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return gisReady;
};

const ensureInitialized = async (): Promise<boolean> => {
  const ok = await loadGis();
  if (!ok) return false;
  if (!initialized) {
    window.google!.accounts!.id!.initialize({
      client_id: CLIENT_ID,
      callback: (resp) => void handleCredential(resp.credential),
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    initialized = true;
  }
  return true;
};

// GIS hands us a fresh ID token. Adopt it locally (so the button flips to the
//   signed-in state instantly), then confirm with the server, which returns the
//   canonical user + stats (including any claimed callsign).
const handleCredential = async (credential: string | undefined) => {
  if (!credential) return;
  const payload = decodeJwt(credential);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : Date.now() + 3_600_000;
  const fallbackUser: PublicUser = {
    username: null,
    displayName: (payload?.name as string) ?? null,
    picture: (payload?.picture as string) ?? null,
    memberSince: new Date().toISOString(),
    stats: { gamesPlayed: 0, bestScore: 0, bestWave: 0, bestCombo: 0, totalKills: 0, totalScore: 0, lastPlayedAt: null },
  };
  state = { token: credential, expiresAt: exp, user: fallbackUser };
  persist();
  emit();
  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: credential, action: "signin" }),
    });
    if (res.ok) {
      const body = (await res.json()) as { user: PublicUser };
      if (state) state.user = body.user;
      persist();
      emit();
    }
  } catch {
    // Keep the optimistic local state; the token still works for submitting.
  }
};

// Render Google's official sign-in button into a container. Safe to call
//   repeatedly (it clears the container first). No-op when auth is unavailable.
export const renderSignInButton = async (el: HTMLElement) => {
  const ok = await ensureInitialized();
  if (!ok) return;
  el.innerHTML = "";
  window.google!.accounts!.id!.renderButton(el, {
    type: "standard",
    theme: "filled_black",
    size: "medium",
    shape: "pill",
    text: "signin_with",
    logo_alignment: "left",
  });
};

export const signOut = () => {
  try {
    window.google?.accounts?.id?.disableAutoSelect();
  } catch {
    // GIS may not be loaded yet; clearing local state is enough.
  }
  state = null;
  persist();
  emit();
};

// Claim (or re-claim) a callsign for the signed-in pilot. Returns the updated
//   user on success. Throws with a human-readable message on conflict / error
//   so the caller can surface it in the score-entry status line.
export const claimUsername = async (username: string): Promise<PublicUser> => {
  const token = getIdToken();
  if (!token) throw new Error("Sign in first.");
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken: token, action: "claim", username }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Claim failed (${res.status}).`);
  }
  const body = (await res.json()) as { user: PublicUser };
  if (state) state.user = body.user;
  persist();
  emit();
  return body.user;
};

// Called once on boot: restore any cached token and refresh the profile in the
//   background so stats/claim status are current.
export const initAuth = () => {
  if (!isAuthAvailable()) return;
  restore();
  // Warm the GIS client so the sign-in button renders instantly when the
  //   score-entry form first appears.
  void ensureInitialized();
  // Refresh the server-side user snapshot behind the restored token.
  const token = getIdToken();
  if (token) {
    void fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: token, action: "signin" }),
    })
      .then(async (res) => {
        if (!res.ok) {
          // Token rejected (expired/revoked) — drop it so the UI shows sign-in.
          if (res.status === 401) signOut();
          return;
        }
        const body = (await res.json()) as { user: PublicUser };
        if (state) {
          state.user = body.user;
          persist();
          emit();
        }
      })
      .catch(() => {
        // offline / transient — keep cached state
      });
  }
};
