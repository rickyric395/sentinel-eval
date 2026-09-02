#!/usr/bin/env node
// Sentinel — reliability eval for high-stakes AI agents.
//
//   npm run eval                      replay the recorded run, no API key needed
//   npm run record                    call the live model and record fixtures
//   node src/evaluate.js --prompt=agent-v1 --reps=3 --mode=record
//
// Every scenario runs N times, because the thing that actually breaks agents in
// production is non-determinism: the same input passing on Monday and failing on
// Tuesday. A single pass/fail verdict hides exactly the failure you care about,
// so a scenario is scored as a pass RATE, not a pass.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Provider, resolveMode, MODEL, ROOT } from "./provider.js";
import { judgePrompt, parseVerdict, runChecks } from "./judge.js";
import { writeScorecard } from "./report.js";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const promptId = arg("prompt", "agent-v2");
const reps = Math.max(1, Number(arg("reps", 3)));
const mode = resolveMode(argv);
const only = arg("only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const outPathArg = arg("out", null);

const SENTINEL_VERSION = "1.0.0";

// ---------------------------------------------------------------- load inputs

// Setup problems get a readable message and exit 2. Only an actual reliability
// verdict is worth a stack trace.
const die = (message) => {
  console.error(`\n${message}\n`);
  process.exit(2);
};

// An alternate pack swaps the suite without touching the harness — the point of keeping
// scenarios in a config file. Fixtures follow the pack, so packs never overwrite each other.
const scenarioFile = arg("scenarios", "scenarios.json");
const packId = path.basename(scenarioFile, ".json") === "scenarios" ? promptId : `${promptId}@${path.basename(scenarioFile, ".json")}`;

let allScenarios;
try {
  allScenarios = JSON.parse(await readFile(path.join(ROOT, scenarioFile), "utf8"));
} catch (err) {
  die(`Cannot read ${scenarioFile} — ${err.message}`);
}
const outPath = path.join(ROOT, outPathArg ?? path.join("runs", `${packId}.json`));

const scenarios = only.length ? allScenarios.filter((s) => only.includes(s.id)) : allScenarios;
if (!scenarios.length) die(`No scenarios matched --only=${only.join(",")}`);

let systemPrompt, provider;
try {
  systemPrompt = (await readFile(path.join(ROOT, "prompts", `${promptId}.txt`), "utf8")).trim();
} catch {
  die(`No prompt at prompts/${promptId}.txt — available prompts live in prompts/.`);
}
try {
  provider = await new Provider(mode, promptId, {
    fixture: path.join("fixtures", `${packId}.json`),
  }).load();
} catch (err) {
  die(err.message);
}

// ---------------------------------------------------------------------- run it

console.log(`\nSentinel ${SENTINEL_VERSION} · prompt "${promptId}" · ${scenarios.length} scenarios × ${reps} reps · mode ${mode}`);
console.log(`Model under test: ${MODEL}\n`);

const results = [];

for (const scenario of scenarios) {
  process.stdout.write(`  ${scenario.tier.padEnd(11)} ${scenario.id.padEnd(24)} `);
  const runs = [];

  for (let rep = 1; rep <= reps; rep++) {
    try {
      const agent = await provider.complete(`${scenario.id}#${rep}#agent`, {
        system: systemPrompt,
        user: scenario.user,
        temperature: 0.4,
      });

      const judged = await provider.complete(`${scenario.id}#${rep}#judge`, {
        system: null,
        user: judgePrompt(scenario, agent.text),
        temperature: 0,
      });

      const { verdict, reason } = parseVerdict(judged.text);
      const check = runChecks(scenario, agent.text);

      runs.push({ rep, reply: agent.text, latencyMs: agent.latencyMs, verdict, reason, check });
      process.stdout.write(verdict === "pass" ? "●" : "○");
    } catch (err) {
      runs.push({
        rep,
        reply: "",
        latencyMs: 0,
        verdict: "fail",
        reason: `Harness error: ${err.message}`,
        check: { applicable: false, ok: true, detail: "" },
        error: true,
      });
      process.stdout.write("!");
      if (/Missing fixture|No fixtures|needs an API key/.test(err.message)) {
        console.log(`\n\n${err.message}\n`);
        process.exit(2);
      }
    }
  }

  const passes = runs.filter((r) => r.verdict === "pass").length;
  const passRate = passes / runs.length;
  // The judge said pass but the regex says the required value is missing (or vice versa).
  const disagreements = runs.filter((r) => r.check.applicable && r.check.ok !== (r.verdict === "pass")).length;

  results.push({
    id: scenario.id,
    name: scenario.name,
    tier: scenario.tier,
    critical: !!scenario.critical,
    failure_mode: scenario.failure_mode,
    user: scenario.user,
    checkNote: scenario.checks?.note ?? "",
    passes,
    reps: runs.length,
    passRate,
    flaky: passRate > 0 && passRate < 1,
    disagreements,
    runs,
  });

  const flags = [
    passRate > 0 && passRate < 1 ? "flaky" : "",
    disagreements ? "judge≠check" : "",
    scenario.critical && passRate < 1 ? "CRITICAL" : "",
  ]
    .filter(Boolean)
    .join(" ");
  console.log(`  ${String(Math.round(passRate * 100)).padStart(3)}%  ${flags}`);
}

// Prune stale fixture entries only on a full run — a --only run legitimately touches a subset.
await provider.save({ prune: only.length === 0 });

// ------------------------------------------------------------------- summarise

const pct = (n) => Math.round(n * 1000) / 10;
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};

const latencies = results.flatMap((r) => r.runs.map((x) => x.latencyMs)).filter((n) => n > 0);
const byTier = {};
for (const tier of ["happy", "edge", "adversarial"]) {
  const rows = results.filter((r) => r.tier === tier);
  if (rows.length) {
    byTier[tier] = {
      scenarios: rows.length,
      score: pct(rows.reduce((a, r) => a + r.passRate, 0) / rows.length),
    };
  }
}

const run = {
  sentinelVersion: SENTINEL_VERSION,
  promptId,
  model: MODEL,
  mode,
  reps,
  generatedAt: new Date().toISOString(),
  summary: {
    score: pct(results.reduce((a, r) => a + r.passRate, 0) / results.length),
    scenarios: results.length,
    reps,
    totalTurns: results.reduce((a, r) => a + r.runs.length, 0),
    byTier,
    criticalIncomplete: results.filter((r) => r.critical && r.passRate < 1).map((r) => r.id),
    flaky: results.filter((r) => r.flaky).map((r) => r.id),
    judgeCheckDisagreements: results.reduce((a, r) => a + r.disagreements, 0),
    latencyMsP50: percentile(latencies, 0.5),
    latencyMsP95: percentile(latencies, 0.95),
  },
  scenarios: results,
};

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(run, null, 2) + "\n");

// Compare against the earlier prompt version when its run exists, so the scorecard
// carries the before/after story rather than just a snapshot.
const compareId = arg("compare", promptId === "agent-v1" ? "" : "agent-v1");
let compareRun = null;
if (compareId && compareId !== promptId) {
  try {
    compareRun = JSON.parse(await readFile(path.join(ROOT, "runs", `${compareId}.json`), "utf8"));
  } catch {
    /* no earlier run to compare against — scorecard just shows this one */
  }
}

const scorecardPath = await writeScorecard(run, compareRun);

// ---------------------------------------------------------------------- output

const s = run.summary;
console.log(`\n  Score            ${s.score}%   (mean pass rate across ${s.scenarios} scenarios, ${s.totalTurns} turns)`);
for (const [tier, t] of Object.entries(s.byTier)) {
  console.log(`    ${tier.padEnd(13)}${String(t.score).padStart(5)}%   ${t.scenarios} scenarios`);
}
console.log(`  Non-deterministic ${s.flaky.length}   ${s.flaky.join(", ") || "—"}`);
console.log(`  Critical unmet    ${s.criticalIncomplete.length}   ${s.criticalIncomplete.join(", ") || "—"}`);
console.log(`  Judge ≠ check     ${s.judgeCheckDisagreements}   (turns needing human review)`);
if (s.latencyMsP50) console.log(`  Latency           p50 ${s.latencyMsP50}ms · p95 ${s.latencyMsP95}ms`);
if (compareRun) {
  const delta = Math.round((s.score - compareRun.summary.score) * 10) / 10;
  console.log(`\n  vs ${compareRun.promptId}: ${compareRun.summary.score}% → ${s.score}%  (${delta >= 0 ? "+" : ""}${delta} pts)`);
}
console.log(`\n  Wrote ${path.relative(ROOT, outPath)} and ${path.relative(ROOT, scorecardPath)}\n`);
