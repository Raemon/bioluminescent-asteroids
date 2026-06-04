// Replay wire format. JSON shape is stable across (v: 1) revisions; bump the
// version when the binary layout or sim semantics change.

export const REPLAY_FORMAT_VERSION = 1;

export type ReplayHeader = {
  v: number;
  build: string;
  seed: number;
  beatOffset: number;
  w: number;
  h: number;
  dpr: number;
  keyVocab: string[];
  startedAt: number;
  score: number;
  wave: number;
  maxCombo: number;
  killCount: number;
};

// One frame = [dtMs, downMask, upMask]. Masks are bit-indexed against header.keyVocab.
export type ReplayFrame = [number, number, number];

export type ReplayPayload = {
  header: ReplayHeader;
  frames: ReplayFrame[];
};

// ---------- (de)serialisation ----------

export const encodeReplay = async (payload: ReplayPayload): Promise<Uint8Array> => {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return await gzip(bytes);
};

export const decodeReplay = async (gz: Uint8Array): Promise<ReplayPayload> => {
  const bytes = await gunzip(gz);
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as ReplayPayload;
};

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
};

const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
};
