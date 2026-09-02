#!/usr/bin/env node
// Score the LLM judge against human labels. TPR and TNR — never a bare agreement rate.
//
//   npm run judge:eval
//
// The positive class is FAIL, because catching a bad reply is the judge's actual job:
//
//   TPR (sensitivity) — of the turns a human called FAIL, how many did the judge catch?
//   TNR (specificity) — of the turns a human called PASS, how many did the judge leave alone?
//
// Reporting a single "% agreement" hides the only failure that matters. If 10% of turns
// are failures, a judge that answers "pass" unconditionally agrees with the human 90% of
// the time and catches nothing. So this prints that degenerate baseline next to the real
// number: if they are close, the headline agreement figure was never evidence of anything.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./provider.js";

const read = async (f, hint) => {
  try { return JSON.parse(await readFile(path.join(ROOT, f), "utf8")); }
  catch { console.error(`\n  Missing ${f}. ${hint}\n`); process.exit(2); }
};

const set = await read("judge-set.json", "Build it first:  npm run judge:set");
const labelFile = await read("labels.json", "Label the set first:  open label.html  →  Download labels.json");

const byUid = new Map(set.turns.map((t) => [t.uid, t]));
const rows = [];
for (const [uid, entry] of Object.entries(labelFile.labels ?? {})) {
  const t = byUid.get(uid);
  if (!t) continue;
  const human = entry.label;
  if (human !== "pass" && human !== "fail") continue; // skips are excluded, by design
  rows.push({ uid, human, judge: t.judgeVerdict, tier: t.tier, critical: t.critical, scenarioId: t.scenarioId });
}

if (!rows.length) { console.error("\n  No usable labels (all skipped or none matched the set).\n"); process.exit(2); }

const humanFail = rows.filter((r) => r.human === "fail").length;
const humanPass = rows.length - humanFail;
if (!humanFail || !humanPass) {
  console.error(
    `\n  REFUSING TO SCORE: labels contain only one polarity (${humanFail} fail / ${humanPass} pass).\n` +
    `  A single-polarity set cannot tell a working judge apart from one that always answers the same way.\n` +
    `  This is the flaw in OpenAI's own LLM-as-judge cookbook example, and it is not worth reproducing.\n`
  );
  process.exit(2);
}

const TP = rows.filter((r) => r.human === "fail" && r.judge === "fail").length;
const FN = rows.filter((r) => r.human === "fail" && r.judge === "pass").length;
const TN = rows.filter((r) => r.human === "pass" && r.judge === "pass").length;
const FP = rows.filter((r) => r.human === "pass" && r.judge === "fail").length;

const pc = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const TPR = pc(TP, TP + FN), TNR = pc(TN, TN + FP);
const precision = pc(TP, TP + FP);
const agreement = pc(TP + TN, rows.length);
const balanced = TPR != null && TNR != null ? Math.round(((TPR + TNR) / 2) * 10) / 10 : null;
// What a judge that always says "pass" would score on the same set.
const degenerateAgreement = pc(humanPass, rows.length);

const out = {
  scoredAt: new Date().toISOString(),
  labelledAt: labelFile.labelledAt ?? null,
  annotators: 1,
  n: rows.length,
  positiveClass: "fail",
  confusion: { TP, FP, TN, FN },
  humanMix: { fail: humanFail, pass: humanPass },
  metrics: { TPR, TNR, precision, balancedAccuracy: balanced },
  degenerateBaseline: { strategy: "always answer pass", agreement: degenerateAgreement },
  rawAgreement: agreement,
  // With one annotator, inter-annotator reliability is undefined. Saying so is more useful
  // than printing a kappa computed against the very judge under test.
  cohensKappa: null,
  kappaNote: "Not computed: kappa measures agreement between annotators, and this set has one.",
};

const pad = (s, n) => String(s).padStart(n);
console.log(`\nSentinel judge validation · n=${rows.length} labelled turns · positive class = "fail"\n`);
console.log(`                 judge:fail   judge:pass`);
console.log(`  human:fail     ${pad(TP, 10)}   ${pad(FN, 10)}`);
console.log(`  human:pass     ${pad(FP, 10)}   ${pad(TN, 10)}\n`);
console.log(`  TPR (catches real failures)     ${TPR}%   ${TP}/${TP + FN}`);
console.log(`  TNR (leaves good replies alone) ${TNR}%   ${TN}/${TN + FP}`);
console.log(`  Precision                       ${precision}%`);
console.log(`  Balanced accuracy               ${balanced}%\n`);
console.log(`  Raw agreement                   ${agreement}%`);
console.log(`  A judge that always says "pass" ${degenerateAgreement}%  <- why raw agreement is not the headline\n`);
console.log(`  Cohen's kappa: not computed (${out.annotators} annotator).\n`);

const worst = Object.entries(
  rows.filter((r) => r.human !== r.judge).reduce((m, r) => ((m[r.scenarioId] = (m[r.scenarioId] ?? 0) + 1), m), {})
).sort((a, b) => b[1] - a[1]).slice(0, 5);
if (worst.length) {
  console.log(`  Disagreements cluster in:`);
  for (const [id, n] of worst) console.log(`    ${id.padEnd(26)} ${n}`);
  console.log(`\n  Those rubrics are where to spend the next edit.\n`);
}

await (await import("node:fs/promises")).writeFile(
  path.join(ROOT, "runs", "judge-validation.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`  Wrote runs/judge-validation.json\n`);
