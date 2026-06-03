#!/usr/bin/env node
// Generate a Dev Log entry from commits about to be merged into main.
//
// Runs as part of `yarn merge`, BEFORE the checkout/merge step, so the
// resulting public/devlog.json change rides along with the merge commit.
//
// - Reads git log main..HEAD (commits this branch is about to ship)
// - Reads a bounded diff stat for additional context
// - Calls the Anthropic API (claude-sonnet-4-6) for a terse changelog
// - Appends a new entry to public/devlog.json
// - Stages the file so it lands in the merge
//
// No-ops cleanly (exit 0, no file change) when there are no new commits.
//
// Env:
//   ANTHROPIC_API_KEY  required
//   DEVLOG_BASE        branch to diff against (default: main)
//   DEVLOG_DRY_RUN     "1" → print entry to stdout, don't write or stage
//   DEVLOG_SKIP        "1" → skip entirely (escape hatch)

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEVLOG_PATH = join(projectRoot, "public", "devlog.json");
const BASE = process.env.DEVLOG_BASE ?? "main";
const DRY_RUN = process.env.DEVLOG_DRY_RUN === "1";
const SKIP = process.env.DEVLOG_SKIP === "1";

const MODEL = "claude-sonnet-4-6";
const MAX_DIFF_CHARS = 60_000;
const MAX_OUTPUT_TOKENS = 1024;

const log = (...a) => console.log("[devlog]", ...a);
const warn = (...a) => console.warn("[devlog]", ...a);

if (SKIP) {
  log("DEVLOG_SKIP=1 — skipping.");
  process.exit(0);
}

const loadDotenv = () => {
  const envPath = join(projectRoot, ".env");
  if (!existsSync(envPath)) return;
  const txt = readFileSync(envPath, "utf8");
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
};
loadDotenv();

const git = (...args) =>
  execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();

const ensureBranchExists = (name) => {
  try {
    git("rev-parse", "--verify", name);
    return true;
  } catch {
    return false;
  }
};

if (!ensureBranchExists(BASE)) {
  warn(`base branch "${BASE}" not found — nothing to compare against; skipping.`);
  process.exit(0);
}

const currentBranch = git("branch", "--show-current");
if (currentBranch === BASE) {
  log(`already on "${BASE}"; nothing to summarize. Skipping.`);
  process.exit(0);
}

const commitsRaw = git("log", `${BASE}..HEAD`, "--pretty=format:%H%x1f%h%x1f%s%x1f%b%x1e");
if (!commitsRaw) {
  log(`no commits in ${BASE}..HEAD; nothing to summarize. Skipping.`);
  process.exit(0);
}

const commits = commitsRaw
  .split("\x1e")
  .map((rec) => rec.trim())
  .filter(Boolean)
  .map((rec) => {
    const [hash, short, subject, body] = rec.split("\x1f");
    return { hash, short, subject: subject ?? "", body: (body ?? "").trim() };
  });

log(`found ${commits.length} commit(s) in ${BASE}..HEAD`);

let diffstat = "";
try {
  diffstat = git("diff", "--stat", `${BASE}...HEAD`);
} catch (e) {
  warn("git diff --stat failed:", e?.message ?? e);
}

let diff = "";
try {
  diff = git("diff", "--unified=1", `${BASE}...HEAD`);
} catch (e) {
  warn("git diff failed:", e?.message ?? e);
}
if (diff.length > MAX_DIFF_CHARS) {
  diff = diff.slice(0, MAX_DIFF_CHARS) + `\n\n…[diff truncated, ${diff.length - MAX_DIFF_CHARS} chars omitted]`;
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  warn("ANTHROPIC_API_KEY is not set. Add it to .env or env to enable devlog generation.");
  warn("Skipping devlog generation; the merge will continue without a new entry.");
  process.exit(0);
}

const commitsBlock = commits
  .map((c, i) => {
    const body = c.body ? `\n${c.body}` : "";
    return `--- commit ${i + 1} (${c.short}) ---\n${c.subject}${body}`;
  })
  .join("\n\n");

const userPrompt = `You are writing a terse, factual "What's new" changelog entry for the players of Pulsar, an arcade game.

Below is the list of git commits being merged into ${BASE}, followed by a diff summary and (truncated) diff. Write a short changelog entry summarizing the player-visible changes.

REQUIREMENTS:
- Output STRICT JSON only, no prose around it, no markdown fences. Schema:
  {
    "title": "short headline, <= 60 chars, no trailing punctuation",
    "sections": [
      { "heading": "New" | "Fixed" | "Changed" | "Tuning", "items": ["bullet", "bullet"] }
    ]
  }
- Use 1–4 sections. Omit any section that has no items. Always lead with "New" if there is new content.
- Each bullet: one short sentence, present tense, player-facing language. Skip internal refactors and code-only changes that players cannot notice.
- If literally every commit is internal-only (no player-visible effect), still produce a valid JSON object with a single "Changed" section containing one neutral bullet like "Behind-the-scenes improvements."
- Do not invent features that aren't in the diff. Do not mention commit hashes or author names.
- Aim for 3–8 bullets total across all sections.

COMMITS:
${commitsBlock}

DIFF SUMMARY:
${diffstat || "(none)"}

DIFF (may be truncated):
${diff || "(none)"}
`;

log(`calling Anthropic (${MODEL})…`);

const callAnthropic = async () => {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }
  const json = await res.json();
  const text = (json.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Anthropic returned empty content");
  return text;
};

let llmText;
try {
  llmText = await callAnthropic();
} catch (e) {
  warn("LLM call failed:", e?.message ?? e);
  warn("Skipping devlog generation; the merge will continue without a new entry.");
  process.exit(0);
}

const extractJson = (raw) => {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : raw;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    throw new Error("no JSON object in LLM output");
  }
  return JSON.parse(body.slice(first, last + 1));
};

let parsed;
try {
  parsed = extractJson(llmText);
} catch (e) {
  warn("could not parse LLM output as JSON:", e?.message ?? e);
  warn("Raw output was:\n" + llmText);
  process.exit(0);
}

const sanitizeStr = (v, maxLen) => {
  if (typeof v !== "string") return "";
  return v.replace(/\s+/g, " ").trim().slice(0, maxLen);
};

const title = sanitizeStr(parsed.title, 80);
if (!title) {
  warn("LLM output had no title; skipping.");
  process.exit(0);
}

const ALLOWED_HEADINGS = new Set(["New", "Fixed", "Changed", "Tuning"]);
const sections = Array.isArray(parsed.sections)
  ? parsed.sections
      .map((s) => {
        const heading = sanitizeStr(s?.heading, 20);
        if (!ALLOWED_HEADINGS.has(heading)) return null;
        const items = Array.isArray(s?.items)
          ? s.items.map((it) => sanitizeStr(it, 240)).filter(Boolean).slice(0, 10)
          : [];
        if (items.length === 0) return null;
        return { heading, items };
      })
      .filter(Boolean)
  : [];

if (sections.length === 0) {
  warn("LLM output had no usable sections; skipping.");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const headShort = commits[0].short;
const id = `${today}-${headShort}`;

const entry = {
  id,
  date: today,
  title,
  sections,
  commits: commits.map((c) => c.short),
};

if (DRY_RUN) {
  log("DRY RUN — entry that would be written:");
  console.log(JSON.stringify(entry, null, 2));
  process.exit(0);
}

let existing = [];
if (existsSync(DEVLOG_PATH)) {
  try {
    const parsedExisting = JSON.parse(readFileSync(DEVLOG_PATH, "utf8"));
    if (Array.isArray(parsedExisting)) existing = parsedExisting;
  } catch (e) {
    warn(`could not parse existing ${DEVLOG_PATH}, starting fresh:`, e?.message ?? e);
  }
}

const filtered = existing.filter((e) => e?.id !== id);
const next = [entry, ...filtered].slice(0, 50);

writeFileSync(DEVLOG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
log(`wrote entry "${title}" → ${DEVLOG_PATH}`);

try {
  git("add", DEVLOG_PATH);
  log("staged devlog.json");
} catch (e) {
  warn("git add failed (non-fatal):", e?.message ?? e);
}
