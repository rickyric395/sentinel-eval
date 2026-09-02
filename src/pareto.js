#!/usr/bin/env node
// Sweep the suite across (prompt x model) and record quality, cost and latency together.
//
//   npm run pareto            record the sweep (needs a key), then write runs/pareto.json
//   npm run pareto -- --mode=replay    recompute from committed fixtures, no key, no cost
//
// Why this exists, separately from evaluate.js:
//
// The regression gate answers "did this change make the agent worse?". This answers a
// different question that a gate cannot: "what am I paying for the quality I have, and
// would I get more of it by buying a better model or by writing a better prompt?" Those
// are the two levers, they cost wildly different amounts, and nothing in the suite
// compares them.
//
// THE DESIGN DECISION THAT MAKES THIS VALID: the judge model is PINNED while the agent
// model varies. If the judge moved with the agent, every point on the curve would differ
// in two variables at once and the comparison would measure nothing.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Provider, resolveMode, ROOT } from "./provider.js";
import { judgePrompt, parseVerdict, runChecks } from "./judge.js";

const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;

// Pinned. Do not make this configurable without also making the curve meaningless.
const JUDGE_MODEL = "gemini-2.5-flash";

const AGENT_MODELS = arg("models", "gemini-2.5-flash-lite,gemini-2.5-flash").split(",");
const PROMPTS = arg("prompts", "agent-v1,agent-v2").split(",");
const reps = Math.max(1, Number(arg("reps", 3)));
const mode = resolveMode(argv);

const percentile = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

const scenarios = JSON.parse(await readFile(path.join(ROOT, "scenarios.json"), "utf8"));
const list = Array.isArray(scenarios) ? scenarios : scenarios.scenarios;

await mkdir(path.join(ROOT, "fixtures", "pareto"), { recursive: true });

console.log(`\nSentinel Pareto sweep · ${PROMPTS.length} prompts × ${AGENT_MODELS.length} models × ${reps} reps · mode ${mode}`);
console.log(`Judge PINNED at ${JUDGE_MODEL} — the agent model is the only variable.\n`);

const points = [];

for (const promptId of PROMPTS) {
  const systemPrompt = await readFile(path.join(ROOT, "prompts", `${promptId}.txt`), "utf8");

  for (const model of AGENT_MODELS) {
    const tag = `${promptId}@${model}`;
    process.stdout.write(`  ${tag.padEnd(38)} `);

    const agent = await new Provider(mode, promptId, {
      model,
      fixture: path.join("fixtures", "pareto", `${tag}.agent.json`),
    }).load();
    const judge = await new Provider(mode, promptId, {
      model: JUDGE_MODEL,
      fixture: path.join("fixtures", "pareto", `${tag}.judge.json`),
    }).load();

    const perScenario = [];
    let inTok = 0, outTok = 0, judgeInTok = 0, judgeOutTok = 0, missingUsage = 0;
    const latencies = [];

    for (const sc of list) {
      let passes = 0;
      for (let rep = 1; rep <= reps; rep++) {
        const a = await agent.complete(`${sc.id}#${rep}#agent`, {
          system: systemPrompt, user: sc.user, temperature: 0.4,
        });
        const j = await judge.complete(`${sc.id}#${rep}#judge`, {
          system: null, user: judgePrompt(sc, a.text), temperature: 0,
        });
        const { verdict } = parseVerdict(j.text);
        const check = runChecks(sc, a.text);
        if (verdict === "pass") passes++;
        if (a.latencyMs > 0) latencies.push(a.latencyMs);
        if (a.usage?.promptTokens == null) missingUsage++;
        inTok += a.usage?.promptTokens ?? 0;
        outTok += a.usage?.outputTokens ?? 0;
        judgeInTok += j.usage?.promptTokens ?? 0;
        judgeOutTok += j.usage?.outputTokens ?? 0;
        void check;
      }
      perScenario.push({ id: sc.id, tier: sc.tier, critical: !!sc.critical, passRate: passes / reps });
      process.stdout.write(passes === reps ? "●" : passes === 0 ? "○" : "◐");
    }

    await agent.save();
    await judge.save();

    const score = Math.round((perScenario.reduce((s, x) => s + x.passRate, 0) / perScenario.length) * 1000) / 10;
    const turns = list.length * reps;
    points.push({
      promptId, model, judgeModel: JUDGE_MODEL, reps, turns, score,
      criticalUnmet: perScenario.filter((s) => s.critical && s.passRate < 1).map((s) => s.id),
      agentTokens: { input: inTok, output: outTok, perTurnInput: Math.round(inTok / turns), perTurnOutput: Math.round(outTok / turns) },
      judgeTokens: { input: judgeInTok, output: judgeOutTok },
      // Absent only on turns replayed from fixtures recorded before token capture existed.
      turnsMissingTokenData: missingUsage,
      latencyMsP50: percentile(latencies, 0.5),
      latencyMsP95: percentile(latencies, 0.95),
      scenarios: perScenario,
    });
    console.log(`  ${score}%`);
  }
}

const out = {
  sentinelVersion: "1.1.0",
  generatedAt: new Date().toISOString(),
  mode,
  judgeModel: JUDGE_MODEL,
  reps,
  scenarioCount: list.length,
  points,
};
await mkdir(path.join(ROOT, "runs"), { recursive: true });
await writeFile(path.join(ROOT, "runs", "pareto.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`\n  Wrote runs/pareto.json (${points.length} points)`);
console.log(`  Render it:  npm run pareto:report\n`);
