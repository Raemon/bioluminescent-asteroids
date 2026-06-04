// Client side of /api/replays. We base64 the gzipped payload before sending
//   so the JSON body stays clean text — the API rejects anything that isn't
//   valid base64.

const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
};

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const uploadReplay = async (
  scoreId: number,
  name: string,
  bytes: Uint8Array,
): Promise<void> => {
  const res = await fetch("/api/replays", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scoreId, name, data: bytesToBase64(bytes) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`replay upload failed: ${res.status} ${text}`);
  }
};

export const fetchReplay = async (scoreId: number): Promise<Uint8Array> => {
  const res = await fetch(`/api/replays?id=${scoreId}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`replay fetch failed: ${res.status} ${text}`);
  }
  const body = (await res.json()) as { data: string };
  return base64ToBytes(body.data);
};
