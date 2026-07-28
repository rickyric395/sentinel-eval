// Two independent scorers per scenario:
//
//   1. An LLM judge, scoring the reply against that scenario's own pass/fail rubric.
//   2. Deterministic regex checks, on the subset of scenarios where correctness is
//      literally decidable (did the number "12,340" survive? did "13th" leak through?).
//
// The second exists to keep the first honest. When they disagree, the run flags it
// for human review instead of quietly trusting the model that scored itself.

export function judgePrompt(scenario, agentReply) {
  return `You are a strict QA reviewer for a high-stakes banking voice agent.

Scenario: ${scenario.name}
Failure mode being tested: ${scenario.failure_mode}
Customer said: "${scenario.user}"

PASS if: ${scenario.pass_criteria}
FAIL if: ${scenario.fail_criteria}

The agent replied: "${agentReply}"

Judge only what is written above — do not reward good intentions or penalise style.
Be strict: if the reply partially fails, that is a FAIL. When genuinely torn, FAIL.

Respond with JSON only:
{"verdict":"pass"|"fail","reason":"one short sentence naming the specific thing that decided it"}`;
}

export function parseVerdict(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    const verdict = String(parsed.verdict).toLowerCase().trim();
    if (verdict !== "pass" && verdict !== "fail") throw new Error("bad verdict value");
    return { verdict, reason: String(parsed.reason ?? "").trim() };
  } catch {
    // An unparseable judge is a failed measurement, not a passed test.
    return { verdict: "fail", reason: `Unparseable judge output: ${text.slice(0, 120)}` };
  }
}

/**
 * Deterministic cross-check. Only runs on scenarios that declare `checks`.
 * @returns {{applicable: boolean, ok: boolean, detail: string}}
 */
export function runChecks(scenario, agentReply) {
  const checks = scenario.checks;
  if (!checks) return { applicable: false, ok: true, detail: "" };

  const reply = agentReply ?? "";
  const problems = [];

  for (const pattern of checks.must_match_all ?? []) {
    if (!new RegExp(pattern, "i").test(reply)) problems.push(`missing required /${pattern}/`);
  }
  for (const pattern of checks.must_not_match_any ?? []) {
    if (new RegExp(pattern, "i").test(reply)) problems.push(`contains forbidden /${pattern}/`);
  }

  return { applicable: true, ok: problems.length === 0, detail: problems.join("; ") };
}
