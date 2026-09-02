#!/usr/bin/env node
// Write the README "Results" section from the recorded runs.
//
//   npm run results
//
// The numbers in the README are the repo's only public claim, so they are generated
// from runs/*.json rather than typed by hand. Typing them invites the one failure the
// honesty rules exist to prevent: a number in the prose that no run produced.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./provider.js";

const README = path.join(ROOT, "README.md");
// The START marker carries a trailing note, so match its prefix rather than the whole tag.
const START_RE = /<!--\s*RESULTS:START[^>]*-->/;
const END = "<!-- RESULTS:END -->";

const load = async (id) => {
  try {
    return JSON.parse(await readFile(path.join(ROOT, "runs", `${id}.json`), "utf8"));
  } catch {
    console.error(`\nMissing runs/${id}.json. Record first:  npm run record\n`);
    process.exit(2);
  }
};

const [v1, v2] = [await load("agent-v1"), await load("agent-v2")];
const pct = (n) => `${n}%`;
const row = (r) => {
  const s = r.summary;
  return `| \`${r.promptId}\` | **${pct(s.score)}** | ${s.criticalIncomplete.length} | ${s.flaky.length} | ${s.judgeCheckDisagreements} | ${s.latencyMsP50}ms | ${s.latencyMsP95}ms |`;
};

const delta = Math.round((v2.summary.score - v1.summary.score) * 10) / 10;
const tiers = [...new Set([...Object.keys(v1.summary.byTier), ...Object.keys(v2.summary.byTier)])];
const tierRow = (t) =>
  `| ${t} | ${v1.summary.byTier[t]?.scenarios ?? 0} | ${pct(v1.summary.byTier[t]?.score ?? 0)} | ${pct(v2.summary.byTier[t]?.score ?? 0)} |`;

// Scenarios v2 still does not fully pass — stated plainly rather than omitted.
const weak = v2.scenarios
  .filter((s) => s.passRate < 1)
  .sort((a, b) => a.passRate - b.passRate)
  .map((s) => `- \`${s.id}\` (${s.tier}${s.critical ? ", **critical**" : ""}) — ${Math.round(s.passRate * 100)}% pass · ${s.failure_mode}`);

const block = `
_Recorded ${v2.generatedAt.slice(0, 10)} · \`${v2.model}\` · ${v2.summary.scenarios} scenarios × ${v2.reps} reps · N=${v2.summary.totalTurns} turns per prompt._

The two prompts differ only in their system text (\`prompts/agent-v1.txt\` → \`prompts/agent-v2.txt\`).
Same scenarios, same judge, same rubrics — so the delta is attributable to the prompt and nothing else.

| prompt | score | critical unmet | non-deterministic | judge ≠ check | p50 | p95 |
|---|---|---|---|---|---|---|
${row(v1)}
${row(v2)}

**v1 → v2: ${delta >= 0 ? "+" : ""}${delta} pts.**

| tier | scenarios | v1 | v2 |
|---|---|---|---|
${tiers.map(tierRow).join("\n")}

${weak.length ? `**Where v2 still fails** — listed because a scorecard that only shows wins is marketing:\n\n${weak.join("\n")}` : "**v2 passes every scenario at every rep.** With N=" + v2.reps + " that is evidence of consistency, not proof of it — the adversarial tier is 8 scenarios, not a corpus."}

Reproduce without an API key: \`npm test\`.
`.trim();

let readme = await readFile(README, "utf8");
const startMatch = readme.match(START_RE);
const endAt = readme.indexOf(END);
if (!startMatch || endAt === -1) {
  console.error(`\nREADME.md is missing the RESULTS:START / ${END} markers.\n`);
  process.exit(2);
}
const startAt = startMatch.index + startMatch[0].length;
readme = `${readme.slice(0, startAt)}\n## Results\n\n${block}\n${readme.slice(endAt)}`;

await writeFile(README, readme);
console.log(`\nREADME Results written — ${v1.promptId} ${pct(v1.summary.score)} → ${v2.promptId} ${pct(v2.summary.score)} (${delta >= 0 ? "+" : ""}${delta} pts)\n`);
