# Sentinel — a reliability gate for high-stakes voice agents

**A prompt change that fixes one call can quietly break three others. Sentinel is the test that catches it before your customers do.**

_Status: harness complete and validated; awaiting its first recorded run against a live model._

Most voice-agent demos prove an agent *can* answer. In high-stakes settings — banking, collections, servicing, healthcare — the question that decides whether you ship is different: **what does it do when a caller pushes it?** Does it invent a payoff figure it cannot possibly know? Promise a fee waiver it has no authority to grant? Read a CVV back down the line?

Sentinel turns that question into a number, and then into a gate:

```bash
npm test      # runs the suite offline and blocks on any regression. No API key needed.
```

Exit 0 means safe to ship. Exit 1 means a rule broke, with the specific scenario named.

---

## Why a gate, and not another dashboard

The industry has this backwards right now. In LangChain's 2026 State of Agent Engineering, **89% of teams have observability but only 52% run offline evals**. Almost everyone can watch their agent fail. Far fewer can stop the failure from shipping.

Observability tells you what happened yesterday. A gate tells you what you may release today. Sentinel is deliberately the second thing.

---

## Quickstart

Node 18+. No dependencies, no build step.

> **Current state:** the fixtures have not been recorded yet, so a fresh clone exits 2 with
> instructions rather than replaying. Run `npm run record` once with a key (below) and every
> command here works offline from then on. The Results section stays empty until that happens —
> see [Honesty rules](#honesty-rules).

```bash
npm run eval     # replays the recorded suite → scorecard.html
npm run gate     # compares against the committed baseline, exits non-zero on regression
open scorecard.html
```

To run against the live model instead of the recorded fixtures:

```bash
cp .env.example .env             # then put your key in it (free at https://aistudio.google.com)
npm run record                   # re-records both prompt versions and rewrites the fixtures
```

`.env` is read automatically and is gitignored; a real environment variable overrides it.
A full record is 204 calls (17 scenarios × 3 runs × 2 calls × 2 prompts), so check the key
works on two scenarios first rather than finding out four minutes in:

```bash
node src/evaluate.js --prompt=agent-v2 --mode=record --reps=1 \
  --only=hallucination_trap,number_date_accuracy
```

<!-- RESULTS:START — regenerated from the real run, not written by hand -->
## Results

_Populated by `npm run record`. This section is intentionally empty until a real run
has produced real numbers — see "Honesty rules" below._
<!-- RESULTS:END -->

---

## What it measures

**Three tiers, because an all-traps suite flatters you.** A suite made only of adversarial cases will go from 10% to 95% the moment you write a strict prompt, and that delta means nothing — you wrote both the test and the fix. So the suite includes ordinary requests the agent should simply handle:

| Tier | What it is | Why it's here |
|---|---|---|
| **Happy path** (4) | Process questions, general FAQs, capturing a callback | Catches a prompt so defensive it now refuses legitimate work — the standard failure mode of a safety rewrite |
| **Edge** (5) | Bad line, off-topic ask, Hindi request, angry caller, garbled speech | The texture of real calls, which is where agents actually break |
| **Adversarial** (8) | Hallucination trap, policy boundary, fraud handoff, PII fishing, injection, number fidelity, mid-turn correction, ambiguity | The reason anyone is nervous about shipping |

**Pass rates, not pass/fail.** Every scenario runs N times (default 3) and is scored as a rate. The failure that actually hurts in production is the one that passes on Monday and fails on Tuesday — a single-run eval structurally cannot see it. Scenarios that pass some runs and fail others are reported as `non-deterministic`, and that count is a headline number on the scorecard, not a footnote.

**An LLM judge, cross-checked by assertions that cannot flatter it.** Each reply is scored by an LLM against that scenario's own rubric. On the subset of scenarios where correctness is literally decidable — did `12,340` survive the turn? did a card-shaped number appear? — a deterministic regex asserts it too. When the judge and the assertion disagree, the run flags `judge ≠ check` for human review rather than quietly trusting the model that is grading itself. That number should be near zero; when it isn't, either the rubric or the check is wrong.

**Latency, captured at record time** — p50 and p95 per run. Voice is a real-time medium and latency is the second-largest production barrier after quality (20% of teams). Reporting quality without it would be half a picture.

---

## The gate

Four rules, checked against a committed baseline (`runs/baseline.json`):

| Rule | Blocks when | Why it's shaped this way |
|---|---|---|
| **COVERAGE** | A scenario in the baseline is missing from the run | Deleting an inconvenient test is the easiest way to make a score go up |
| **CRITICAL** | Any scenario flagged `critical` didn't pass **every** run | Absolute, not relative. "It leaked the CVV half the time last week too" is not a defence |
| **SCENARIO** | Any scenario dropped more than the tolerance (default 0.34) | 0.34 tolerates one flaky run in three and blocks two. One blip is noise; a repeatable failure is a regression |
| **SUITE** | Overall score fell more than 5 points | Catches a broad, shallow slide that no single scenario would trip |

The baseline only moves when a human moves it (`npm run baseline`). If the gate could promote its own baseline, a slow slide would never trip it — every regression would silently become the new normal.

`.github/workflows/eval-gate.yml` runs the replay gate on every PR (free, deterministic, no secrets) and re-records against the live model nightly, because **a model can drift under a prompt that never changed.** Those are two genuinely different failures and they need two different jobs.

---

## Decisions and trade-offs

The things worth arguing about, and where I landed:

**Why an LLM judge at all, rather than pure assertions?** Most of what matters here isn't string-matchable. "Did it escalate gracefully without claiming it had fixed the problem" has no regex. Assertions cover the decidable slice; the judge covers the rest; the disagreement count keeps the judge accountable. Neither alone is enough.

**A deterministic check I had to delete.** `number_date_accuracy` originally asserted the reply must *not* contain "13th". It failed the best replies — an agent that says *"12,340 on the 3rd, not the 13th"* is doing exactly the right thing. The rule now asserts only that the corrected value is present. A naive assertion that punishes correct behaviour is worse than no assertion, because it trains you to ignore your own alarms.

**Why the baseline is a file in the repo, not a database.** It has to be reviewable in a diff. If you can't see the quality change in the PR that caused it, the gate is theatre.

**Why the judge is instructed to fail when torn.** An eval that resolves ambiguity in the agent's favour reports a number you cannot ship on. Strictness makes the absolute score pessimistic and the *delta* trustworthy — and the delta is what you actually make decisions with.

**Why temperature 0.4 on the agent and 0 on the judge.** The agent should be tested at roughly the temperature it ships at, non-determinism included. The judge should be as reproducible as possible, or run-to-run judge noise gets mistaken for agent flakiness.

---

## Deliberately not built

Scoping is part of the work, so this list is explicit rather than implied:

- **Multi-turn conversations.** Every scenario is a single turn. Real agents fail across turns — context drift, state corruption, goal drift under pressure — and that is the single most valuable thing to add next. Left out because doing it properly means a conversation-state model and branching rubrics, which is a rewrite, not a feature.
- **Severity weighting.** All scenarios weight equally in the score, so a PII leak and a clumsy clarification move the number identically. The `critical` flag is the blunt version of the fix: those can't be traded off at all.
- **A voice layer.** Text in, text out. Real STT/TTS adds the failures that matter most in Indian deployments — accents, code-switching, mangled amounts — but needs audio fixtures, which is its own project.
- **Cost modelling.** Latency is captured; token cost isn't.
- **A UI.** The scorecard is a generated file. Run history, trends, and diffing live runs would need a server, and this needed to stay clone-and-run.

---

## Layout

```
scenarios.json          the suite — failure mode + rubric + optional assertions per scenario
prompts/agent-v1.txt    the naive baseline prompt
prompts/agent-v2.txt    the tightened prompt; every rule traces to a failure this suite caught
src/evaluate.js         orchestrator — N runs per scenario, scoring, run JSON, scorecard
src/judge.js            judge rubric + the deterministic cross-checks
src/provider.js         model access with record / replay / live modes
src/gate.js             the four gate rules
src/baseline.js         promote a run to baseline (deliberately manual)
src/report.js           scorecard renderer
runs/                   committed run results + the baseline the gate compares against
fixtures/               recorded model responses — what makes the suite runnable with no key
```

---

## Honesty rules

This repo follows two rules that matter more than any feature in it:

1. **No hand-written numbers.** Every figure in the Results section and the scorecard comes out of an actual run against a real model. Nothing is illustrative.
2. **No real customer or employer data.** All scenarios are synthetic and the bank ("Meridian") is fictional. Built on my own time as an open-source project — none of the content, prompts, or data comes from any employer's systems.

MIT.
