#!/usr/bin/env node
// Render runs/pareto.json as a standalone page: quality against cost, latency alongside.
//
//   npm run pareto:report
//
// Recomputes cost from pricing.json every time, so correcting a stale price is an edit
// and a re-render — never a re-run. No dependencies, no build step, no network.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./provider.js";

const run = JSON.parse(await readFile(path.join(ROOT, "runs", "pareto.json"), "utf8"));
const pricing = JSON.parse(await readFile(path.join(ROOT, "pricing.json"), "utf8"));

const priced = run.points.map((p) => {
  const rate = pricing.models[p.model];
  if (!rate) throw new Error(`No price for ${p.model} in pricing.json`);
  const costPerTurn =
    (p.agentTokens.perTurnInput * rate.inputPerMTok + p.agentTokens.perTurnOutput * rate.outputPerMTok) / 1e6;
  return { ...p, costPer1kTurns: costPerTurn * 1000, rate };
});

// A point is on the frontier if nothing is both cheaper and at least as good.
const frontier = new Set(
  priced.filter((p) => !priced.some((q) => q !== p && q.costPer1kTurns <= p.costPer1kTurns && q.score >= p.score)).map((p) => p.model + p.promptId)
);

const W = 720, H = 420, PAD = { l: 74, r: 28, t: 28, b: 62 };
const xs = priced.map((p) => p.costPer1kTurns), ys = priced.map((p) => p.score);
const xMax = Math.max(...xs) * 1.25, xMin = 0;
const yMin = Math.max(0, Math.min(...ys) - 12), yMax = 100;
const X = (v) => PAD.l + ((v - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
const Y = (v) => H - PAD.b - ((v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => (n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

const xTicks = 5, yTicks = 5;
const grid = [
  ...Array.from({ length: xTicks + 1 }, (_, i) => {
    const v = xMin + ((xMax - xMin) * i) / xTicks;
    return `<line class="grid" x1="${X(v)}" y1="${PAD.t}" x2="${X(v)}" y2="${H - PAD.b}"/>
      <text class="tick" x="${X(v)}" y="${H - PAD.b + 20}" text-anchor="middle">${money(v)}</text>`;
  }),
  ...Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / yTicks;
    return `<line class="grid" x1="${PAD.l}" y1="${Y(v)}" x2="${W - PAD.r}" y2="${Y(v)}"/>
      <text class="tick" x="${PAD.l - 12}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(0)}%</text>`;
  }),
].join("\n");

const marks = priced
  .map((p) => {
    const on = frontier.has(p.model + p.promptId);
    const short = p.model.replace("gemini-2.5-", "");
    return `<g class="pt ${on ? "on" : "off"}">
      <circle cx="${X(p.costPer1kTurns)}" cy="${Y(p.score)}" r="${on ? 9 : 7}"/>
      <text x="${X(p.costPer1kTurns)}" y="${Y(p.score) - 16}" text-anchor="middle">${esc(p.promptId)} · ${esc(short)}</text>
    </g>`;
  })
  .join("\n");

const rows = priced
  .sort((a, b) => a.costPer1kTurns - b.costPer1kTurns)
  .map(
    (p) => `<tr${frontier.has(p.model + p.promptId) ? ' class="on"' : ""}>
      <td><code>${esc(p.promptId)}</code></td><td><code>${esc(p.model)}</code></td>
      <td class="n"><b>${p.score}%</b></td>
      <td class="n">${money(p.costPer1kTurns)}</td>
      <td class="n">${p.latencyMsP50}ms</td><td class="n">${p.latencyMsP95}ms</td>
      <td class="n">${p.agentTokens.perTurnInput} / ${p.agentTokens.perTurnOutput}</td>
      <td class="n">${p.criticalUnmet.length}</td></tr>`
  )
  .join("\n");

const cheapest = priced.reduce((a, b) => (a.costPer1kTurns <= b.costPer1kTurns ? a : b));
const best = priced.reduce((a, b) => (a.score >= b.score ? a : b));

const html = `<!doctype html><meta charset="utf-8"><title>Sentinel — quality vs cost</title>
<style>
 :root{--bg:#fbfbf9;--fg:#16161a;--mut:#6b6b76;--line:#e3e3dd;--on:#0f766e;--off:#9a9aa4;--card:#fff}
 @media(prefers-color-scheme:dark){:root{--bg:#111114;--fg:#ececf0;--mut:#9a9aa4;--line:#2a2a30;--on:#2dd4bf;--off:#55555f;--card:#18181c}}
 *{box-sizing:border-box}
 body{margin:0;padding:40px 20px;background:var(--bg);color:var(--fg);
   font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
 main{max-width:860px;margin:0 auto}
 h1{font-size:26px;letter-spacing:-.02em;margin:0 0 6px}
 .sub{color:var(--mut);margin:0 0 28px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:22px 0}
 svg{width:100%;height:auto;display:block}
 .grid{stroke:var(--line);stroke-width:1}
 .tick{fill:var(--mut);font-size:11px;font-family:ui-monospace,monospace}
 .axis{fill:var(--mut);font-size:12px}
 .pt.on circle{fill:var(--on)} .pt.off circle{fill:var(--off)}
 .pt text{fill:var(--fg);font-size:11.5px;font-family:ui-monospace,monospace}
 table{border-collapse:collapse;width:100%;font-size:13.5px}
 th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}
 th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
 td.n{text-align:right;font-family:ui-monospace,monospace}
 tr.on td{background:color-mix(in srgb,var(--on) 9%,transparent)}
 code{font-family:ui-monospace,monospace;font-size:12.5px}
 .note{color:var(--mut);font-size:13px}
 .wrap{overflow-x:auto}
</style>
<main>
<h1>Quality is not what you pay for</h1>
<p class="sub">${run.points.length} configurations · ${run.scenarioCount} scenarios × ${run.reps} reps ·
judge pinned at <code>${esc(run.judgeModel)}</code> · recorded ${esc(run.generatedAt.slice(0, 10))}</p>

<div class="card">
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Quality against cost per 1,000 turns">
 ${grid}
 <text class="axis" x="${PAD.l + (W - PAD.l - PAD.r) / 2}" y="${H - 14}" text-anchor="middle">cost per 1,000 turns (agent only)</text>
 <text class="axis" transform="translate(18,${PAD.t + (H - PAD.t - PAD.b) / 2}) rotate(-90)" text-anchor="middle">pass rate</text>
 ${marks}
</svg>
<p class="note">Filled teal = on the cost/quality frontier. Cost is computed from
<b>measured</b> token counts (the API's own <code>usageMetadata</code>) priced by
<code>pricing.json</code> — correct a stale price and re-render, no re-run needed.</p>
</div>

<div class="card wrap">
<table>
<thead><tr><th>prompt</th><th>model</th><th>quality</th><th>cost / 1k turns</th>
<th>p50</th><th>p95</th><th>tok in/out</th><th>critical unmet</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>

<div class="card">
<p class="note"><b>How to read this.</b> The judge model is identical across all
${run.points.length} points, so the agent model is the only thing that varies within a
prompt. Cheapest configuration is <code>${esc(cheapest.promptId)}</code> on
<code>${esc(cheapest.model)}</code> at ${money(cheapest.costPer1kTurns)} per 1,000 turns;
highest quality is <code>${esc(best.promptId)}</code> on <code>${esc(best.model)}</code>
at ${best.score}%. Latency is wall-clock from the recording run on a home connection —
treat it as relative, not as a served-production SLA.</p>
</div>
</main>`;

await writeFile(path.join(ROOT, "pareto.html"), html);

// Also regenerate the README section, for the same reason results.js exists: a number in
// the prose that no run produced is the one failure the honesty rules are here to prevent.
const START = /<!--\s*PARETO:START[^>]*-->/;
const END = "<!-- PARETO:END -->";
const readmePath = path.join(ROOT, "README.md");
let readme = await readFile(readmePath, "utf8");
const m = readme.match(START), endAt = readme.indexOf(END);
if (m && endAt !== -1) {
  const byKey = Object.fromEntries(priced.map((p) => [p.promptId + "|" + p.model, p]));
  const liteV2 = byKey["agent-v2|gemini-2.5-flash-lite"], flashV1 = byKey["agent-v1|gemini-2.5-flash"];
  const rowsMd = priced
    .map((p) => `| \`${p.promptId}\` | \`${p.model}\` | **${p.score}%** | ${money(p.costPer1kTurns)} | ${p.latencyMsP50}ms | ${p.latencyMsP95}ms | ${p.criticalUnmet.length} |`)
    .join("\n");
  let block = `\n## Cost, quality and latency\n\n` +
    `_Recorded ${run.generatedAt.slice(0, 10)} · ${run.scenarioCount} scenarios × ${run.reps} reps per point · ` +
    `judge pinned at \`${run.judgeModel}\` so the agent model is the only variable._\n\n` +
    `| prompt | model | quality | cost / 1k turns | p50 | p95 | critical unmet |\n` +
    `|---|---|---|---|---|---|---|\n${rowsMd}\n\n`;
  if (liteV2 && flashV1) {
    const x = (flashV1.costPer1kTurns / liteV2.costPer1kTurns).toFixed(1);
    const f = (flashV1.latencyMsP50 / liteV2.latencyMsP50).toFixed(1);
    block += `**The tightened prompt on the cheap model beats the naive prompt on the expensive one — ` +
      `on every axis at once.** \`agent-v2\` on \`gemini-2.5-flash-lite\` scores ${liteV2.score}% at ` +
      `${money(liteV2.costPer1kTurns)} per 1,000 turns; \`agent-v1\` on \`gemini-2.5-flash\` scores ` +
      `${flashV1.score}% at ${money(flashV1.costPer1kTurns)}. That is ` +
      `**+${Math.round((liteV2.score - flashV1.score) * 10) / 10} points of quality for ${x}× less money and ${f}× lower latency.** ` +
      `Buying a better model was the more expensive way to get less.\n\n`;
  }
  block += `Cost is computed from measured token counts (the API's own \`usageMetadata\`), priced by ` +
    `\`pricing.json\`. Correct a stale price and re-render — \`npm run pareto:report\` recomputes without ` +
    `spending a call. Latency is wall-clock from the recording run on a home connection: treat it as ` +
    `relative, not as a served-production SLA.\n\nFull chart: \`pareto.html\`. Reproduce: \`npm run pareto -- --mode=replay\`.\n`;
  readme = readme.slice(0, m.index + m[0].length) + block + readme.slice(endAt);
  await writeFile(readmePath, readme);
  console.log("  Updated the README's cost/quality/latency section");
}
console.log(`\n  Wrote pareto.html — ${priced.length} points, ${frontier.size} on the frontier`);
for (const p of priced) console.log(`    ${p.promptId.padEnd(9)} ${p.model.padEnd(23)} ${String(p.score).padStart(5)}%  ${money(p.costPer1kTurns).padStart(8)}/1k  p50 ${p.latencyMsP50}ms`);
console.log();
