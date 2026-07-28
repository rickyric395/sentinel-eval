#!/usr/bin/env node
// Promote a run to be the baseline the gate compares against.
//
//   npm run baseline                       promotes runs/agent-v2.json
//   node src/baseline.js --run=runs/x.json
//
// Promoting is deliberately a separate, explicit act. If the gate could update its own
// baseline, a slow slide in quality would never trip it — every regression would quietly
// become the new normal. Somebody has to look at the scorecard and say "yes, ship that".

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./provider.js";

const argv = process.argv.slice(2);
const runArg = argv.find((a) => a.startsWith("--run="))?.slice(6) ?? "runs/agent-v2.json";
const runPath = path.join(ROOT, runArg);
const baselinePath = path.join(ROOT, "runs", "baseline.json");

let run;
try {
  run = JSON.parse(await readFile(runPath, "utf8"));
} catch {
  console.error(`\nCannot read ${runArg}. Produce a run first:  npm run eval\n`);
  process.exit(2);
}

let previous = null;
try {
  previous = JSON.parse(await readFile(baselinePath, "utf8"));
} catch {
  /* first baseline */
}

await writeFile(baselinePath, JSON.stringify(run, null, 2) + "\n");

console.log(`\nBaseline set from ${runArg}`);
console.log(`  prompt    ${run.promptId}`);
console.log(`  score     ${run.summary.score}%  (${run.summary.scenarios} scenarios × ${run.reps} runs)`);
if (previous) {
  const delta = Math.round((run.summary.score - previous.summary.score) * 10) / 10;
  console.log(`  previous  ${previous.promptId} · ${previous.summary.score}%  (${delta >= 0 ? "+" : ""}${delta} pts)`);
}
console.log(`\n  Commit runs/baseline.json — the gate is only meaningful if the baseline is versioned.\n`);
