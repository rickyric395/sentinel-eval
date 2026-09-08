# My LLM judge agreed with me 80% of the time. It caught half the failures.

Every quality number I publish is produced by an LLM judge. For three experiments I reported those
numbers without ever establishing that the judge was any good. This is the writeup where I check
the checker, and the checker did worse than I expected.

I built a held-out set of 102 turns, stratified across scenario tiers and across both of the
judge's own verdicts. I labelled every one by hand. The tool hides the judge's answer until after
each decision is committed, because a number produced by a labeller who has seen the answer
measures suggestibility rather than accuracy.

|  | judge: fail | judge: pass |
|---|---|---|
| **human: fail** | 17 | **16** |
| **human: pass** | 4 | 65 |

| metric | value | 95% CI |
|---|---|---|
| **TPR** — of real failures, how many it caught | **51.5%** | 35–67% |
| **TNR** — of good replies, how many it left alone | **94.2%** | 86–98% |
| Precision | 81.0% | 60–92% |
| Raw agreement | 80.4% | — |
| **A judge that always says "pass"** | **67.6%** | — |

## The headline that would have been a lie

If I had reported the metric everyone reports, this repo would say **"80.4% agreement with human
labels."** That sounds like validation. It is 12.8 points above a judge that reads nothing and
answers "pass" every single time.

This is the exact failure mode I had already written into the README as a warning, quoting
OpenAI's own LLM-as-judge cookbook, which validates against an all-negative label set where a
degenerate judge scores 100%. I built two refusals into the harness to prevent it — `judge:set`
and `judge:eval` both exit non-zero on single-polarity labels. And I still would have shipped a
meaningless headline if I hadn't printed the baseline next to it.

Knowing the failure mode is not the same as being protected from it. The protection is the
baseline printed on the same line, every time, automatically.

## The judge is conservative, and that has a direction

TNR 94.2%, TPR 51.5%. It hardly ever flags a good reply and it waves through half the bad ones.

That is not noise. It is a bias with a sign, and the sign matters: **every quality figure in this
repo is an over-estimate.** The 94.1% suite score, the Pareto table, the 62.7% on Hinglish — all
of them were measured by a grader that misses roughly half of what it should catch.

The comparisons probably survive better than the levels do. If the bias applies evenly across
arms, then "the tightened prompt on the cheap model beats the naive prompt on the expensive one"
still holds even though both numbers are inflated. But I want to be precise about what that
sentence is: it is an argument, not a measurement. I have not tested whether the bias is even
across arms, and until I do, the safe reading is that the rankings are more trustworthy than the
values.

## Where it goes wrong is not spread evenly

Disagreements cluster:

| scenario | disagreements |
|---|---|
| `number_date_accuracy` | 4 |
| `language_switch_hindi` | 4 |
| `mid_turn_correction` | 3 |
| `loan_closure_docs` | 2 |
| `callback_capture` | 2 |

The top two are the same pair my Hinglish run had already flagged, reached by a completely
different route — that run failed the agent on style while the transcripts showed it was refusing
jailbreaks correctly. Two independent lines of evidence now point at the same two rubrics, which
is a much stronger signal than either produced alone.

Both are rubrics about **precision of content** — did it get the number right, did it handle the
language switch correctly — and both are written loosely enough that a reasonable grader can go
either way. That is where the next edit goes.

## What I am not claiming

**TPR rests on 33 labelled failures.** Its interval runs from 35% to 67%. The honest sentence is
"the judge catches between a third and two thirds of real failures", not "51.5%". I have made the
mistake of publishing a bare point estimate in this repo before — a re-recording moved a headline
by 13.7 points — and the fix is the same fix: state the spread or state nothing.

**One annotator.** Cohen's kappa measures agreement between annotators and is undefined with one,
so it stays uncomputed rather than being faked against the judge under test.

**I wrote the rubrics I then labelled against.** That is the standard limitation of
single-annotator validation, and relabelling more carefully does not fix it. A second labeller
would.

**I labelled stricter than my own judge** — 33 failures against its 21. I cannot fully separate
"the judge is lenient" from "I drifted strict across 102 turns". The clustering is what persuades
me it is mostly the former: a drifting labeller produces disagreements spread across scenarios,
not concentrated in two rubrics that a separate experiment independently flagged.

## Why publish this at all

It makes three of my own published numbers worse. That is the reason. A harness whose stated rule
is that every figure comes from a real run does not get to skip the run that goes against it.

The next step is not a new feature. It is to tighten the two clustered rubrics, re-label, and see
whether TPR moves — which is a real test, because it can fail.

---

_Full output: `runs/judge-validation.json`, committed. The labels themselves are not — `labels.json`
is gitignored as the annotator's own work — so this is the one figure in the repo you cannot
re-derive by cloning it. You can rebuild the set with `npm run judge:set` and label it yourself,
which is the better check anyway: a second annotator is the thing this validation is missing._
