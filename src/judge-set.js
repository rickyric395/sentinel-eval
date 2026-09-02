#!/usr/bin/env node
// Build the held-out set a human labels to validate the judge.
//
//   npm run judge:set
//
// WHY THIS EXISTS. Every number this repo publishes is produced by an LLM judge, and
// nothing so far establishes that the judge is any good. The standard move — report
// "% agreement with a human" — is misleading precisely when it matters: if 10% of turns
// are failures, a judge that says "pass" to everything scores 90% agreement while
// catching nothing. So this set is built to be scored as TPR and TNR instead.
//
// THE SAMPLING RULE THAT MATTERS: both label polarities must be present. OpenAI's own
// LLM-as-judge cookbook validates against an all-negative set, where a degenerate judge
// that always answers one way scores 100%. A set drawn only from failures has the same
// flaw. So this stratifies across judge-pass and judge-fail turns and across tiers.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./provider.js";

const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const target = Number(arg("n", 120));
const sources = arg("runs", "agent-v1,agent-v2").split(",");

// Deterministic shuffle — a labelling set that changes between runs cannot be held out.
const hash = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 2 ** 32; };

const turns = [];
for (const id of sources) {
  const run = JSON.parse(await readFile(path.join(ROOT, "runs", `${id}.json`), "utf8"));
  for (const sc of run.scenarios) {
    for (const r of sc.runs ?? []) {
      if (!r.reply) continue;
      turns.push({
        uid: `${id}::${sc.id}::${r.rep}`,
        promptId: id, scenarioId: sc.id, rep: r.rep, tier: sc.tier, critical: !!sc.critical,
        scenarioName: sc.name, failureMode: sc.failure_mode,
        customer: sc.user, reply: r.reply,
        // Kept so the scorer can compare, and shown to the labeller ONLY after they decide.
        judgeVerdict: r.verdict, judgeReason: r.reason,
        deterministicCheck: r.check?.applicable ? (r.check.ok ? "ok" : "violated") : "n/a",
      });
    }
  }
}

// Stratify by (judge verdict x tier) so neither polarity can vanish from the sample.
const buckets = new Map();
for (const t of turns) {
  const k = `${t.judgeVerdict}|${t.tier}`;
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push(t);
}
for (const [, arr] of buckets) arr.sort((a, b) => hash(a.uid) - hash(b.uid));

const picked = [];
let i = 0;
while (picked.length < Math.min(target, turns.length)) {
  let added = false;
  for (const [, arr] of buckets) {
    if (arr[i]) { picked.push(arr[i]); added = true; }
    if (picked.length >= target) break;
  }
  if (!added) break;
  i++;
}
picked.sort((a, b) => hash(a.uid + "order") - hash(b.uid + "order"));

const byVerdict = picked.reduce((m, t) => ((m[t.judgeVerdict] = (m[t.judgeVerdict] ?? 0) + 1), m), {});
const out = {
  builtAt: new Date().toISOString(),
  sources, size: picked.length, poolSize: turns.length,
  judgeVerdictMix: byVerdict,
  labelSchema: { pass: "the agent's reply is acceptable", fail: "the agent's reply is not acceptable", skip: "genuinely undecidable — excluded from scoring" },
  turns: picked,
};
await writeFile(path.join(ROOT, "judge-set.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`\n  Wrote judge-set.json — ${picked.length} turns drawn from a pool of ${turns.length}`);
console.log(`  Judge verdict mix in the set: ${JSON.stringify(byVerdict)}`);
if (Object.keys(byVerdict).length < 2) {
  console.error(`\n  REFUSING TO PROCEED: only one polarity present. A single-polarity set cannot distinguish a working judge from a degenerate one.\n`);
  process.exit(2);
}

// Emit the labelling tool with the set embedded, so it opens straight from file:// with
// no server and no dependencies.
//
// THE METHODOLOGICAL POINT: the judge's own verdict stays hidden until after the labeller
// commits. Showing it first anchors the human to the machine, and the number that comes
// out then measures suggestibility rather than accuracy.
const tpl = await readFile(path.join(ROOT, "src", "label-template.html"), "utf8");
const embedded = {
  builtAt: out.builtAt,
  sources,
  turns: picked.map((t) => ({
    uid: t.uid, scenarioName: t.scenarioName, failureMode: t.failureMode, tier: t.tier,
    critical: t.critical, customer: t.customer, reply: t.reply,
    judgeVerdict: t.judgeVerdict, judgeReason: t.judgeReason, deterministicCheck: t.deterministicCheck,
  })),
};
await writeFile(path.join(ROOT, "label.html"), tpl.replace("__SENTINEL_SET__", JSON.stringify(embedded)));

console.log(`  Wrote label.html (set embedded \u2014 opens from file://, no server needed)`);
console.log(`  Label it:  open label.html  \u2192  Download labels.json  \u2192  npm run judge:eval\n`);
