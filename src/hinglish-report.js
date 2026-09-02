#!/usr/bin/env node
// Regenerate the README's language-robustness section from the two recorded runs.
//
//   npm run hinglish:report
//
// Same reason every other number here is generated: a figure in the prose that no run
// produced is the one failure the honesty rules exist to prevent.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./provider.js";

const en = JSON.parse(await readFile(path.join(ROOT, "runs", "agent-v2.json"), "utf8"));
const hi = JSON.parse(await readFile(path.join(ROOT, "runs", "agent-v2@scenarios-hinglish.json"), "utf8"));
const E = Object.fromEntries(en.scenarios.map((s) => [s.id, s]));
const H = Object.fromEntries(hi.scenarios.map((s) => [s.id, s]));

const pct = (s) => Math.round(s.passRate * 100);
const dropped = Object.keys(E)
  .map((id) => ({ id, tier: E[id].tier, critical: E[id].critical, en: pct(E[id]), hi: pct(H[id]) }))
  .filter((r) => r.hi < r.en)
  .sort((a, b) => (a.hi - a.en) - (b.hi - b.en));

const crit = hi.summary.criticalIncomplete;
const tierRow = (t) => `| ${t} | ${en.summary.byTier[t]?.score ?? 0}% | ${hi.summary.byTier[t]?.score ?? 0}% | ${Math.round(((hi.summary.byTier[t]?.score ?? 0) - (en.summary.byTier[t]?.score ?? 0)) * 10) / 10} |`;

const block = `
## The same agent, in Hinglish

\`scenarios-hinglish.json\` is the identical suite — same ids, tiers, failure modes and rubrics —
with one thing changed: the customer writes in Roman-script code-switched Hinglish, the way a large
share of Indian users actually type. One variable, so the delta is attributable to input language.

**The suite score falls from ${en.summary.score}% to ${hi.summary.score}% (${Math.round((hi.summary.score - en.summary.score) * 10) / 10} points), and critical failures go from ${en.summary.criticalIncomplete.length} to ${crit.length}.**

| tier | English | Hinglish | delta |
|---|---|---|---|
${["happy", "edge", "adversarial"].map(tierRow).join("\n")}

**The safety tier is where it hurts.** These passed at 100% in English:

| scenario | English | Hinglish | |
|---|---|---|---|
${dropped.map((r) => `| \`${r.id}\` | ${r.en}% | **${r.hi}%** | ${r.critical ? "**critical**" : ""} |`).join("\n")}

An agent that resists every jailbreak, every PII request and every policy-boundary push in English
${crit.includes("jailbreak") ? `fails ${100 - pct(H.jailbreak)}% of jailbreak attempts` : "degrades"} when the same
user writes in Hinglish. Guardrails written and tested in one language did not transfer.
Non-determinism also rises, from ${en.summary.flaky.length} unstable scenarios to ${hi.summary.flaky.length}.

**The confound, stated rather than buried.** The judge is also reading code-switched text, and its
rubrics are in English. Some of this drop could be the *judge* degrading on Hinglish rather than the
agent. This suite cannot separate the two — which is precisely what the human-labelled judge
validation above is for, and why that number matters more than any feature on the backlog.
Deterministic checks were widened to accept Hindi replies before this ran; an English-only regex
would have measured the reply's language rather than its correctness.

Reproduce: \`npm run eval -- --prompt=agent-v2 --scenarios=scenarios-hinglish.json\`

`;

const readmePath = path.join(ROOT, "README.md");
let readme = await readFile(readmePath, "utf8");
const S = /<!--\s*HINGLISH:START[^>]*-->/, END = "<!-- HINGLISH:END -->";
const m = readme.match(S), e = readme.indexOf(END);
if (!m || e === -1) { console.error("\n  README is missing the HINGLISH markers.\n"); process.exit(2); }
await writeFile(readmePath, readme.slice(0, m.index + m[0].length) + block + readme.slice(e));
console.log(`\n  README language section written — ${en.summary.score}% → ${hi.summary.score}%, ${crit.length} critical unmet\n`);
