# 86.3% on the cheap model beat 78.4% on the one costing 7.7× more

I run AI agents in production and I kept hitting the same argument: quality is short, do we
upgrade the model or rewrite the prompt? Everyone has an intuition. Nobody had a number.

So I measured it. Same 17 scenarios, same judge, two prompts, two models, three runs each.

| prompt | model | quality | cost / 1k turns | p50 | p95 | critical unmet |
|---|---|---|---|---|---|---|
| naive | flash-lite | 72.5% | $0.030 | 926ms | 4923ms | 2 |
| **tightened** | **flash-lite** | **86.3%** | **$0.087** | **778ms** | **934ms** | **0** |
| naive | flash | 78.4% | $0.677 | 2110ms | 4567ms | 2 |
| tightened | flash | 90.2% | $0.737 | 1922ms | 3253ms | 1 |

**The tightened prompt on the cheap model beats the naive prompt on the expensive model on every
axis at once**: +7.9 points of quality, 7.7× less money, 2.7× lower latency. The expensive
configuration isn't a tradeoff — it's dominated. There is no budget at which you'd pick it.

Upgrading the model bought **+5.9 points for 22× the token cost**. Rewriting the prompt bought
**+13.8 points** on the same cheap model. Both levers work. They are not close.

## The one design decision that makes this valid

**The judge model is pinned while the agent model varies.**

If the judge moves with the agent, every point differs in two variables and the chart measures
nothing — it looks exactly as convincing and it is worthless. This is the easiest way to produce
a confident, meaningless benchmark, and it's why `JUDGE_MODEL` is a constant in the source with a
comment telling you not to make it configurable.

Cost is computed from measured token counts — the API's own `usageMetadata` — not estimated from
characters. Prices live in an editable `pricing.json` with a date and a source, so if a price is
stale you correct it and re-render; you never re-run and never re-spend.

## The part that surprised me more than the headline

The tightened prompt has a **739-token system prompt** against the naive one's 57. It costs 13×
more to send. It still came out cheaper per unit of quality — because it makes the model **terser**:
output dropped from 264 tokens to 206 on flash, and to **34** on flash-lite. On the cheap model the
constrained prompt paid for itself in output tokens alone, and the p95 collapsed from 4.9s to 934ms.

A longer prompt made the system faster and cheaper. I would have bet the other way.

## And the number I had to walk back

The first time I ran the suite, the same prompt change scored **+29.4 points** (64.7% → 94.1%).
The sweep re-recorded the identical configuration and got **+11.8** (78.4% → 90.2%).

Same prompt. Same model. Same judge. Same rubrics.

**The direction reproduced — the tightened prompt won both times, on every tier, taking critical
failures from 2 to 0 or 1. The magnitude did not.** The cause is sample size, not a bug: 51 turns
at temperature 0.4, and one unstable scenario flipping between 0/3 and 3/3 moves the suite score
5.9 points by itself.

I left both numbers in the repo. The honest claim is *"better by somewhere between roughly 10 and
30 points"*, not a single figure — and confidence intervals over more reps are the next thing the
harness needs, ahead of any new feature.

If you take one thing from this: **an eval suite that reports a point estimate without a spread is
telling you less than it appears to.** Mine was, until I ran it twice.

## Run it yourself

```bash
git clone https://github.com/rickyric395/sentinel-eval
cd sentinel-eval && npm test          # replays offline, no API key, ~10s
npm run pareto -- --mode=replay       # the four points above, from committed fixtures
```

Every figure here is generated from a recorded run and committed as a fixture. The repo has no
mechanism for printing a number a run didn't produce — that was deliberate, and this is the post
where it mattered.

---

*Harsh Singh — I own AI agents end-to-end in production. [rickyric395.github.io](https://rickyric395.github.io)*
