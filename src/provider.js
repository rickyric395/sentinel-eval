// Model access with record / replay, so the whole suite runs offline from fixtures.
//
// Three modes:
//   replay (default) — no network, no API key. Reads fixtures/<promptId>.json.
//   record           — calls the API and writes fixtures. Needs GEMINI_API_KEY.
//   live             — calls the API, writes nothing. For one-off experiments.
//
// Why record/replay exists: a portfolio repo nobody can run is a portfolio repo
// nobody reads. Replay also makes the regression gate deterministic in CI.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Read .env if it's there, without a dependency. Real environment variables win, so
// `MODEL=x npm run record` still overrides the file.
function loadDotEnv() {
  let text;
  try {
    text = readFileSync(path.join(ROOT, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (value && process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
loadDotEnv();

export const MODEL = process.env.MODEL || "gemini-2.5-flash";

const KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GENERATIVE_AI_API_KEY;

// Free-tier Gemini is rate-limited per minute, so calls are serialised with a
// gap between them. Raise DELAY if you still see 429s.
const DELAY_MS = Number(process.env.SENTINEL_DELAY_MS ?? 1100);
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Provider {
  /**
   * @param {"replay"|"record"|"live"} mode
   * @param {string} promptId
   * @param {{model?: string, fixture?: string}} [opts]
   *   model   — the model this provider calls. Defaults to MODEL. The Pareto sweep varies
   *             the agent's model while pinning the judge's, which is only meaningful if a
   *             provider carries its own model rather than reading one global.
   *   fixture — fixture file path relative to the repo root. Defaults to the historical
   *             fixtures/<promptId>.json, so existing recordings keep replaying untouched.
   */
  constructor(mode, promptId, opts = {}) {
    this.mode = mode;
    this.promptId = promptId;
    this.model = opts.model || MODEL;
    this.fixtures = {};
    this.used = new Set();
    this.dirty = false;
    this.calls = 0;
    this.fixturePath = path.join(ROOT, opts.fixture || path.join("fixtures", `${promptId}.json`));
  }

  async load() {
    if (this.mode === "record" || this.mode === "live") {
      if (!KEY) {
        throw new Error(
          `Mode "${this.mode}" needs an API key.\n` +
            `  export GEMINI_API_KEY=your_key_here   (free: https://aistudio.google.com → Get API key)\n` +
            `  …or run in the default replay mode, which needs no key: npm run eval`
        );
      }
    }
    try {
      this.fixtures = JSON.parse(await readFile(this.fixturePath, "utf8"));
    } catch {
      if (this.mode === "replay") {
        throw new Error(
          `No fixtures for "${this.promptId}" at fixtures/${this.promptId}.json.\n` +
            `  Record them once:  export GEMINI_API_KEY=…  &&  npm run record\n` +
            `  After that the suite replays offline forever.`
        );
      }
    }
    return this;
  }

  async save({ prune = false } = {}) {
    if (this.mode !== "record" || !this.dirty) return;
    await mkdir(path.join(ROOT, "fixtures"), { recursive: true });
    // Drop entries this run didn't touch, so an edited prompt doesn't leave its old
    // replies behind. Only safe after a full run — a --only run touches a subset.
    const entries = Object.entries(this.fixtures).filter(([k]) => !prune || this.used.has(k));
    // Sorted keys keep fixture diffs readable in review.
    const sorted = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(this.fixturePath, JSON.stringify(sorted, null, 2) + "\n");
  }

  /**
   * One model turn.
   *
   * The cache is CONTENT-ADDRESSED: the slot id includes a digest of the exact system
   * and user text sent. Keying on scenario id alone was a trap — editing
   * prompts/agent-v2.txt and re-recording would return the replies from the OLD prompt
   * and report them as a fresh result. A changed prompt now simply misses the cache.
   *
   * @returns {Promise<{text: string, latencyMs: number, replayed: boolean}>}
   */
  async complete(slot, { system, user, temperature = 0.4 }) {
    const digest = createHash("sha256")
      // Hashed as a JSON tuple: the quoting delimits the fields, so no separator can
      // collide with content, and any reader can reproduce the key exactly.
      .update(JSON.stringify([system ?? "", user, temperature]))
      .digest("hex")
      .slice(0, 10);
    const key = `${slot}#${digest}`;
    this.used.add(key);
    const cached = this.fixtures[key];

    if (this.mode === "replay") {
      if (!cached) {
        throw new Error(
          `Missing fixture for ${slot}.\n` +
            `  The prompt, the scenario text, or the temperature changed since the last recording,\n` +
            `  so the recorded reply no longer corresponds to what would be sent.\n` +
            `  Re-record:  export GEMINI_API_KEY=…  &&  npm run record`
        );
      }
      return { ...cached, replayed: true };
    }

    if (this.mode === "record" && cached) return { ...cached, replayed: true };

    const result = await this.#callWithRetry({ system, user, temperature });
    if (this.mode === "record") {
      this.fixtures[key] = result;
      this.dirty = true;
    }
    return { ...result, replayed: false };
  }

  async #callWithRetry(args) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (this.calls > 0) await sleep(DELAY_MS);
        this.calls++;
        return await this.#call(args);
      } catch (err) {
        lastErr = err;
        const retryable = /\b(429|500|502|503|504)\b/.test(err.message) || err.name === "TypeError";
        if (!retryable || attempt === MAX_ATTEMPTS) break;
        const backoff = 2000 * 2 ** (attempt - 1);
        process.stdout.write(` (rate-limited, retrying in ${backoff / 1000}s)`);
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  async #call({ system, user, temperature }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const body = {
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const started = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      const hint =
        res.status === 404
          ? `\n  Model "${this.model}" not found for this key. Try: MODEL=gemini-flash-latest npm run record`
          : "";
      throw new Error(`Gemini ${res.status}: ${detail}${hint}`);
    }

    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "").trim();
    if (!text) throw new Error(`Empty response (finishReason: ${data?.candidates?.[0]?.finishReason ?? "unknown"})`);
    // Token counts come from the API's own accounting, so cost is measured rather than
    // estimated from character counts. Absent on fixtures recorded before this existed.
    const u = data?.usageMetadata ?? {};
    const usage = {
      promptTokens: u.promptTokenCount ?? null,
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || null,
      totalTokens: u.totalTokenCount ?? null,
    };
    return { text, latencyMs, usage };
  }
}

export function resolveMode(argv) {
  const flag = argv.find((a) => a.startsWith("--mode="))?.split("=")[1];
  const mode = flag || process.env.SENTINEL_MODE || "replay";
  if (!["replay", "record", "live"].includes(mode)) {
    throw new Error(`Unknown mode "${mode}". Use replay | record | live.`);
  }
  return mode;
}

export { ROOT };
