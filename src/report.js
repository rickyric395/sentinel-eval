// Scorecard renderer — the artifact a human actually looks at.
//
// Laid out as a wallboard, not a document: the summary and the before/after delta
// read at a glance, and the transcripts sit behind disclosure for whoever wants to
// argue with a verdict. Self-contained HTML, no external assets.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./provider.js";

const esc = (value = "") =>
  String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const TIER_LABEL = {
  happy: "Happy path",
  edge: "Edge case",
  adversarial: "Adversarial",
};

const TIER_BLURB = {
  happy: "Ordinary requests the agent should simply handle. Here to keep the suite honest — a set made only of traps produces a flattering delta.",
  edge: "Real-call messiness: bad lines, off-topic asks, another language, an angry customer.",
  adversarial: "Deliberate attempts to make it fabricate, over-promise, leak, or break role.",
};

function scoreTone(score) {
  if (score >= 90) return "pass";
  if (score >= 70) return "warn";
  return "fail";
}

function dots(runs) {
  return runs
    .map(
      (r) =>
        `<span class="dot ${r.verdict === "pass" ? "pass" : "fail"}" title="Run ${r.rep}: ${esc(r.verdict)}"></span>`
    )
    .join("");
}

function scenarioCard(scenario) {
  const rate = Math.round(scenario.passRate * 100);
  const tone = scenario.passRate === 1 ? "pass" : scenario.passRate === 0 ? "fail" : "warn";

  const flags = [
    scenario.critical && scenario.passRate < 1
      ? `<span class="flag fail">critical · must pass every run</span>`
      : "",
    scenario.flaky ? `<span class="flag warn">non-deterministic</span>` : "",
    scenario.disagreements
      ? `<span class="flag warn">judge ≠ check on ${scenario.disagreements} run${scenario.disagreements > 1 ? "s" : ""}</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  const transcript = scenario.runs
    .map(
      (r) => `
        <div class="run">
          <div class="run-head">
            <span class="mono muted">run ${r.rep}</span>
            <span class="badge ${r.verdict}">${r.verdict}</span>
            ${r.latencyMs ? `<span class="mono muted">${r.latencyMs} ms</span>` : ""}
          </div>
          <p class="reply">${esc(r.reply) || '<span class="muted">(no reply)</span>'}</p>
          <p class="reason"><span class="mono muted">judge</span> ${esc(r.reason)}</p>
          ${
            r.check?.applicable
              ? `<p class="reason"><span class="mono muted">check</span> ${
                  r.check.ok ? "satisfied" : esc(r.check.detail)
                }</p>`
              : ""
          }
        </div>`
    )
    .join("");

  return `
      <article class="scn t-${tone}">
        <div class="scn-top">
          <div class="scn-id">
            <h3>${esc(scenario.name)}</h3>
            <p class="mono muted">${esc(scenario.id)} · tests: ${esc(scenario.failure_mode)}</p>
          </div>
          <div class="scn-score">
            <span class="dots">${dots(scenario.runs)}</span>
            <span class="rate mono ${tone}">${rate}%</span>
          </div>
        </div>
        ${flags ? `<div class="flags">${flags}</div>` : ""}
        <p class="said"><span class="mono muted">customer</span> ${esc(scenario.user)}</p>
        <details>
          <summary>${scenario.runs.length} run${scenario.runs.length > 1 ? "s" : ""} · transcripts and verdicts</summary>
          ${transcript}
          ${scenario.checkNote ? `<p class="note mono">Deterministic check: ${esc(scenario.checkNote)}</p>` : ""}
        </details>
      </article>`;
}

function tierSection(run, tier) {
  const rows = run.scenarios.filter((s) => s.tier === tier);
  if (!rows.length) return "";
  const t = run.summary.byTier[tier];
  return `
    <section class="tier">
      <div class="tier-head">
        <h2>${TIER_LABEL[tier]}</h2>
        <span class="mono ${scoreTone(t.score)}">${t.score}%</span>
        <span class="mono muted">${t.scenarios} scenarios</span>
      </div>
      <p class="tier-blurb">${TIER_BLURB[tier]}</p>
      ${rows.map(scenarioCard).join("")}
    </section>`;
}

function compareBand(run, compareRun) {
  if (!compareRun) return "";
  const before = compareRun.summary.score;
  const after = run.summary.score;
  const delta = Math.round((after - before) * 10) / 10;

  const movers = run.scenarios
    .map((s) => {
      const prev = compareRun.scenarios.find((p) => p.id === s.id);
      if (!prev) return null;
      const d = Math.round((s.passRate - prev.passRate) * 100);
      return d === 0 ? null : { name: s.name, id: s.id, from: Math.round(prev.passRate * 100), to: Math.round(s.passRate * 100), d };
    })
    .filter(Boolean)
    .sort((a, b) => a.d - b.d);

  const rows = movers
    .map(
      (m) => `
        <tr>
          <td>${esc(m.name)}<br><span class="mono muted">${esc(m.id)}</span></td>
          <td class="mono num">${m.from}%</td>
          <td class="mono num">${m.to}%</td>
          <td class="mono num ${m.d > 0 ? "pass" : "fail"}">${m.d > 0 ? "+" : ""}${m.d}</td>
        </tr>`
    )
    .join("");

  return `
    <section class="band">
      <p class="eyebrow">What changed</p>
      <div class="band-scores">
        <div class="band-col">
          <span class="mono muted">${esc(compareRun.promptId)}</span>
          <span class="band-num mono">${before}%</span>
          <div class="meter"><i style="width:${before}%"></i></div>
        </div>
        <span class="arrow mono">→</span>
        <div class="band-col">
          <span class="mono muted">${esc(run.promptId)}</span>
          <span class="band-num mono ${scoreTone(after)}">${after}%</span>
          <div class="meter"><i class="t-${scoreTone(after)}" style="width:${after}%"></i></div>
        </div>
        <div class="band-delta">
          <span class="band-num mono ${delta >= 0 ? "pass" : "fail"}">${delta >= 0 ? "+" : ""}${delta}</span>
          <span class="mono muted">points</span>
        </div>
      </div>
      <p class="band-note">Same ${run.summary.scenarios} scenarios, same ${run.reps} runs each, same judge and rubrics. The only variable is the agent's system prompt — every rule in <span class="mono">${esc(run.promptId)}</span> was written against a failure this suite caught in <span class="mono">${esc(compareRun.promptId)}</span>.</p>
      ${
        rows
          ? `<div class="tablewrap"><table>
        <thead><tr><th>Scenario</th><th class="num">${esc(compareRun.promptId)}</th><th class="num">${esc(run.promptId)}</th><th class="num">Δ</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
          : `<p class="band-note muted">No scenario changed its pass rate.</p>`
      }
    </section>`;
}

export async function writeScorecard(run, compareRun = null) {
  const s = run.summary;
  const outPath = path.join(ROOT, "scorecard.html");
  const repo = process.env.SENTINEL_REPO_URL || "";
  const generated = new Date(run.generatedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const signals = [
    {
      value: s.flaky.length,
      label: "non-deterministic",
      hint: "Scenarios that passed on some runs and failed on others — the failure a single-run eval cannot see.",
      tone: s.flaky.length ? "warn" : "pass",
    },
    {
      value: s.criticalIncomplete.length,
      label: "critical unmet",
      hint: "Safety scenarios that did not pass every single run. The gate blocks on any of these.",
      tone: s.criticalIncomplete.length ? "fail" : "pass",
    },
    {
      value: s.judgeCheckDisagreements,
      label: "judge ≠ check",
      hint: "Turns where the LLM judge and the deterministic regex check disagreed. Flagged for human review rather than trusted.",
      tone: s.judgeCheckDisagreements ? "warn" : "pass",
    },
  ];

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel — ${esc(run.promptId)} reliability scorecard</title>
<style>
  :root{
    --ground:#0d1417; --panel:#131c20; --panel-2:#18232b; --line:#223037;
    --ink:#e6eef0; --muted:#8ba0a6; --signal:#4bc8c0;
    --pass:#57a97f; --fail:#d4634f; --warn:#d9a13c;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  }
  @media (prefers-color-scheme: light){
    :root{
      --ground:#f6f9f9; --panel:#ffffff; --panel-2:#f0f5f5; --line:#dae4e4;
      --ink:#111c20; --muted:#5f7278; --signal:#127c78;
      --pass:#2f7d55; --fail:#b8402c; --warn:#996008;
    }
  }
  :root[data-theme="dark"]{
    --ground:#0d1417; --panel:#131c20; --panel-2:#18232b; --line:#223037;
    --ink:#e6eef0; --muted:#8ba0a6; --signal:#4bc8c0;
    --pass:#57a97f; --fail:#d4634f; --warn:#d9a13c;
  }
  :root[data-theme="light"]{
    --ground:#f6f9f9; --panel:#ffffff; --panel-2:#f0f5f5; --line:#dae4e4;
    --ink:#111c20; --muted:#5f7278; --signal:#127c78;
    --pass:#2f7d55; --fail:#b8402c; --warn:#996008;
  }

  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);line-height:1.55;
       -webkit-font-smoothing:antialiased}
  .wrap{max-width:880px;margin:0 auto;padding:40px 20px 96px;display:flex;flex-direction:column;gap:34px}
  .mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
  .muted{color:var(--muted)}
  .pass{color:var(--pass)} .fail{color:var(--fail)} .warn{color:var(--warn)}
  .num{text-align:right}
  h1,h2,h3{text-wrap:balance;margin:0}
  a{color:var(--signal)}
  :focus-visible{outline:2px solid var(--signal);outline-offset:2px}

  .eyebrow{font-family:var(--mono);font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;
           color:var(--signal);margin:0 0 10px}

  /* masthead */
  header{display:flex;flex-direction:column;gap:6px;border-bottom:1px solid var(--line);padding-bottom:22px}
  header h1{font-size:27px;letter-spacing:-.015em}
  .meta{display:flex;flex-wrap:wrap;gap:6px 18px;font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:6px}

  /* score block */
  .score{display:grid;grid-template-columns:minmax(190px,1fr) 1.4fr;gap:24px;background:var(--panel);
         border:1px solid var(--line);border-radius:4px;padding:24px}
  .score-main{display:flex;flex-direction:column;justify-content:center;gap:2px}
  .big{font-family:var(--mono);font-size:56px;line-height:1;font-weight:600;letter-spacing:-.03em;
       font-variant-numeric:tabular-nums}
  .score-main .cap{font-size:12.5px;color:var(--muted);max-width:24ch}
  .tiers{display:flex;flex-direction:column;gap:14px;justify-content:center}
  .tierbar{display:grid;grid-template-columns:96px 1fr 46px;align-items:center;gap:12px;
           font-family:var(--mono);font-size:11.5px}
  .meter{height:5px;background:var(--panel-2);border:1px solid var(--line);border-radius:2px;overflow:hidden}
  .meter i{display:block;height:100%;background:var(--signal)}
  /* Tone on a CONTAINER is prefixed t- so it never collides with the .pass/.fail/.warn
     text utilities — an unprefixed class here would tint every child by inheritance. */
  .meter i.t-pass{background:var(--pass)} .meter i.t-warn{background:var(--warn)} .meter i.t-fail{background:var(--fail)}

  /* signal chips */
  .signals{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
  .sig{background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--line);
       border-radius:3px;padding:14px 16px}
  .sig.t-warn{border-left-color:var(--warn)} .sig.t-fail{border-left-color:var(--fail)}
  .sig.t-pass{border-left-color:var(--pass)}
  .sig-v{font-family:var(--mono);font-size:24px;font-weight:600;line-height:1.1}
  .sig-l{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  .sig-h{font-size:12.5px;color:var(--muted);margin:6px 0 0}

  /* before/after band */
  .band{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:24px}
  .band-scores{display:flex;align-items:flex-end;gap:20px;flex-wrap:wrap}
  .band-col{flex:1 1 150px;display:flex;flex-direction:column;gap:4px}
  .band-col .meter{margin-top:4px}
  .band-num{font-size:34px;font-weight:600;line-height:1;letter-spacing:-.02em}
  .arrow{color:var(--muted);font-size:18px;padding-bottom:14px}
  .band-delta{display:flex;flex-direction:column;align-items:flex-end;gap:2px;padding-left:8px;
              border-left:1px solid var(--line)}
  .band-note{font-size:13px;color:var(--muted);margin:18px 0 0;max-width:66ch}

  .tablewrap{overflow-x:auto;margin-top:18px}
  table{width:100%;border-collapse:collapse;font-size:13px;min-width:440px}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);
     border-bottom-color:var(--muted)}
  td.num,th.num{text-align:right;white-space:nowrap}

  /* tiers + scenarios */
  .tier{display:flex;flex-direction:column;gap:10px}
  .tier-head{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--line);padding-bottom:8px}
  .tier-head h2{font-size:15px;letter-spacing:.01em}
  .tier-head .mono{font-size:13px;font-weight:600}
  .tier-blurb{font-size:12.5px;color:var(--muted);margin:0 0 4px;max-width:70ch}

  .scn{background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--line);
       border-radius:3px;padding:16px 18px;display:flex;flex-direction:column;gap:9px;color:var(--ink)}
  .scn.t-pass{border-left-color:var(--pass)} .scn.t-fail{border-left-color:var(--fail)}
  .scn.t-warn{border-left-color:var(--warn)}
  .scn-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
  .scn-id h3{font-size:15px;font-weight:600;color:var(--ink)}
  .scn-id p{font-size:11.5px;margin:3px 0 0}
  .scn-score{display:flex;align-items:center;gap:12px}
  .dots{display:inline-flex;gap:4px}
  .dot{width:9px;height:9px;border-radius:50%;display:inline-block}
  .dot.pass{background:var(--pass)}
  .dot.fail{background:transparent;border:1.5px solid var(--fail)}
  .rate{font-size:17px;font-weight:600;min-width:44px;text-align:right}

  .flags{display:flex;flex-wrap:wrap;gap:6px}
  .flag{font-family:var(--mono);font-size:10px;letter-spacing:.05em;text-transform:uppercase;
        padding:3px 7px;border-radius:2px;border:1px solid currentColor}
  .flag.warn{color:var(--warn)} .flag.fail{color:var(--fail)}

  .said{font-size:13.5px;margin:0;display:grid;grid-template-columns:74px 1fr;gap:10px}
  .said .mono{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;padding-top:3px}

  details{border-top:1px solid var(--line);padding-top:9px}
  summary{cursor:pointer;font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;
          color:var(--muted)}
  summary:hover{color:var(--signal)}
  .run{border-left:1px solid var(--line);padding:10px 0 10px 14px;margin-top:10px;
       display:flex;flex-direction:column;gap:5px}
  .run-head{display:flex;align-items:center;gap:10px;font-size:11px}
  .badge{font-family:var(--mono);font-size:10px;letter-spacing:.07em;text-transform:uppercase;padding:2px 6px;
         border-radius:2px;border:1px solid currentColor}
  .badge.pass{color:var(--pass)} .badge.fail{color:var(--fail)}
  .reply{font-size:13.5px;margin:0;white-space:pre-wrap}
  .reason{font-size:12.5px;color:var(--muted);margin:0;display:grid;grid-template-columns:56px 1fr;gap:8px}
  .reason .mono{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;padding-top:2px}
  .note{font-size:11.5px;color:var(--muted);margin:12px 0 0;padding-left:14px}

  footer{border-top:1px solid var(--line);padding-top:18px;font-family:var(--mono);font-size:11.5px;
         color:var(--muted);display:flex;flex-direction:column;gap:5px}

  @media (max-width:640px){
    .score{grid-template-columns:1fr}
    .big{font-size:46px}
    .said{grid-template-columns:1fr;gap:2px}
  }
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<div class="wrap">

  <header>
    <p class="eyebrow">Sentinel · agent reliability eval</p>
    <h1>${esc(run.promptId)} — reliability scorecard</h1>
    <div class="meta">
      <span>model under test · ${esc(run.model)}</span>
      <span>${s.scenarios} scenarios × ${run.reps} runs = ${s.totalTurns} turns</span>
      <span>mode · ${esc(run.mode)}</span>
      <span>${esc(generated)}</span>
    </div>
  </header>

  <section class="score">
    <div class="score-main">
      <span class="big ${scoreTone(s.score)}">${s.score}%</span>
      <span class="cap">Mean pass rate across every scenario. Each scenario is run ${run.reps}× and scored as a rate, not a verdict.</span>
    </div>
    <div class="tiers">
      ${Object.entries(s.byTier)
        .map(
          ([tier, t]) => `
      <div class="tierbar">
        <span class="muted">${TIER_LABEL[tier]}</span>
        <span class="meter"><i class="t-${scoreTone(t.score)}" style="width:${t.score}%"></i></span>
        <span class="${scoreTone(t.score)}">${t.score}%</span>
      </div>`
        )
        .join("")}
      ${s.latencyMsP50 ? `<div class="tierbar"><span class="muted">latency</span><span class="muted" style="grid-column:2/4">p50 ${s.latencyMsP50} ms · p95 ${s.latencyMsP95} ms</span></div>` : ""}
    </div>
  </section>

  <section class="signals">
    ${signals
      .map(
        (sig) => `
    <div class="sig t-${sig.tone}">
      <div class="sig-v ${sig.tone}">${sig.value}</div>
      <div class="sig-l">${sig.label}</div>
      <p class="sig-h">${sig.hint}</p>
    </div>`
      )
      .join("")}
  </section>

  ${compareBand(run, compareRun)}

  ${["adversarial", "edge", "happy"].map((tier) => tierSection(run, tier)).join("")}

  <footer>
    <span>Sentinel ${esc(run.sentinelVersion)} · synthetic scenarios, fictional bank · no customer data</span>
    <span>Scored by an LLM judge against per-scenario rubrics, cross-checked by deterministic assertions where correctness is decidable.</span>
    ${repo ? `<span><a href="${esc(repo)}">${esc(repo)}</a></span>` : ""}
  </footer>

</div>
</body>
</html>
`;

  await writeFile(outPath, html);
  return outPath;
}
