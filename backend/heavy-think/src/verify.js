// src/verify.js — Verification layer for refined output
// Different task domains need different verification. The verification step is what
// makes HeavySkill *safe* to use as a primitive — it catches the case where the
// refined trace looks good but is actually wrong (code that doesn't run, citations
// that don't exist, etc.).
//
// METHOD REGISTRY
// ---------------
// The implemented methods live in the VERIFICATION_METHODS table below and the
// exported VERIFICATION_METHOD_NAMES is derived from it. A method can therefore
// never be advertised without an implementation behind it.
//
// This matters because the method list used to be an implicit switch statement:
// `llm-judge` was named as the default verification method by AWARE's
// config/rlm.yaml while no implementation existed anywhere, so the call fell
// through to the unknown-method error. See AWARE card t_0ff3a7b9.
//
// Consumers that read a method list from configuration (AWARE's
// src/config/rlm.cjs) should validate against this export instead of
// hard-coding a list of method names.

import { exec as childExec } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(childExec);

// ─── llm-judge tunables ────────────────────────────────────────────────────
// The judge is a separate LLM call whose verdict is a pass/fail gate, not a
// score. Confidence acts as the calibration knob: a "pass" verdict below the
// threshold is treated as a fail.
const DEFAULT_JUDGE_THRESHOLD = 0.5;
const DEFAULT_JUDGE_MAX_TOKENS = 1024;
const DEFAULT_JUDGE_MAX_TRACE_CHARS = 20000;

// The rubric lives in the system role so the candidate solution (untrusted
// text) cannot rewrite the criteria it is judged against. Same architectural
// separation the PRM judge uses — see src/prm.js.
const DEFAULT_JUDGE_SYSTEM_PROMPT = `You are a verification judge. You are given a task and a candidate solution produced by an autonomous agent. Decide whether the candidate solution is correct.

Be adversarial, not charitable. A candidate may read as confident and still be wrong, incomplete, or self-contradictory. Judge only what the text demonstrates.

Reply with strict JSON and nothing else:
{ "verdict": "pass" | "fail", "confidence": <number between 0 and 1>, "reason": "<one sentence>" }

- "pass" only when the candidate fully satisfies the task and you cannot identify a factual or logical error.
- "fail" when the candidate is wrong, incomplete, self-contradictory, or does not address the task.
- "confidence" is your calibrated probability that your verdict is correct.`;

const JUDGE_TASK_SEPARATOR = '\n\n---\n\n';

export async function verify({ trace, verification, context, client, judgeClient, problem }) {
  const start = Date.now();
  const method = verification?.method;

  try {
    const impl = VERIFICATION_METHODS[method];
    if (!impl) {
      throw new Error(
        `verify: unknown method '${method}' (implemented methods: ${VERIFICATION_METHOD_NAMES.join(', ')})`
      );
    }
    const result = await impl(trace, verification, context, { client, judgeClient, problem });
    return { ...result, duration_ms: Date.now() - start };
  } catch (err) {
    return {
      passed: false,
      method,
      details: { error: err.message },
      duration_ms: Date.now() - start,
    };
  }
}

// ─── Method implementations ────────────────────────────────────────────────
// The table IS the registry: VERIFICATION_METHOD_NAMES is derived from its
// keys, so an entry can never drift out of sync with the switch it replaced.
const VERIFICATION_METHODS = {
  'exec': verifyExec,
  'test_suite': verifyTestSuite,
  'citation_check': verifyCitations,
  'kg_consistency': verifyKG,
  'none': verifyNone,
  'llm-judge': verifyLLMJudge,
};

export const VERIFICATION_METHOD_NAMES = Object.keys(VERIFICATION_METHODS);

/** True when `name` is a method this module can service. */
export function isVerificationMethod(name) {
  return Object.prototype.hasOwnProperty.call(VERIFICATION_METHODS, name);
}

async function verifyNone() {
  return { passed: true, method: 'none' };
}

async function verifyExec(trace, verification, context) {
  // Run the generated code. This is the most dangerous verification — sandbox required.
  // For Phase 1 of AWARE 2.0, we use a timeout + workdir constraint. Real sandboxing
  // (bubblewrap / firejail / nsjail) comes in Phase 5 hardening.
  const cmd = verification.cmd || extractCodeBlock(trace);
  if (!cmd) {
    return { passed: false, method: 'exec', details: { error: 'no command or code block found' } };
  }
  const cwd = verification.cwd || context?.cwd || process.cwd();
  const timeout = verification.timeout_ms || 10_000;

  // CRITICAL safety: reject obviously dangerous patterns unless explicitly opted in
  if (!verification.allow_unsafe) {
    const dangerous = /(\brm\s+-rf\b|\bdd\s+if=|\bmkfs\b|\bshutdown\b|\breboot\b)/i;
    if (dangerous.test(cmd)) {
      return { passed: false, method: 'exec', details: { error: 'unsafe command rejected' } };
    }
  }

  const { stdout, stderr } = await exec(cmd, { cwd, timeout });
  return {
    passed: true,
    method: 'exec',
    details: { stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) },
  };
}

async function verifyTestSuite(trace, verification, context) {
  const cmd = verification.cmd || 'npm test';
  const cwd = verification.cwd || context?.cwd || process.cwd();
  const timeout = verification.timeout_ms || 300_000;
  try {
    const { stdout, stderr } = await exec(cmd, { cwd, timeout });
    return {
      passed: true,
      method: 'test_suite',
      details: { stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) },
    };
  } catch (err) {
    return {
      passed: false,
      method: 'test_suite',
      details: {
        error: err.message,
        stdout: (err.stdout || '').slice(-2000),
        stderr: (err.stderr || '').slice(-2000),
      },
    };
  }
}

async function verifyCitations(trace, verification, context) {
  // Extract URLs / DOIs from trace and HEAD-check them. Stub for v0.1.
  const urls = (trace.match(/https?:\/\/[^\s)]+/g) || []).slice(0, 20);
  // For v0.1, just report what we found. Real checking comes when we wire to network.
  return {
    passed: true,
    method: 'citation_check',
    details: { urls_found: urls.length, urls: urls.slice(0, 5) },
  };
}

async function verifyKG(trace, verification, context) {
  // Cross-check claims against MemoryStone KG. Stub for v0.1.
  return {
    passed: true,
    method: 'kg_consistency',
    details: { note: 'KG verification stub — full implementation in Phase 2' },
  };
}

// ─── llm-judge ──────────────────────────────────────────────────────────────
// A verification gate that asks an LLM whether the refined trace actually
// solves the task, instead of executing code (`exec`) or running a test suite.
//
// Design notes:
//   * FAIL-CLOSED. A missing client, a transport error, an unparseable verdict
//     and a low-confidence "pass" all produce passed:false. A verification
//     layer that fails open is worse than no verification layer.
//   * SYSTEM/USER ISOLATION. The rubric sits in the system role; the trace is
//     untrusted text in the user role, so the candidate cannot rewrite the
//     criteria it is judged against (same separation as src/prm.js).
//   * DETERMINISTIC BY DEFAULT. temperature 0 so the same trace yields the
//     same verdict across runs.
//   * PERMISSIVENESS IS THE KNOWN RISK. The sibling measurement
//     (AWARE t_9655b361) showed the shipped PRM judge is permissive rather
//     than noisy: stable across repeats but missing most bad traces. The
//     confidence threshold is the knob for that; the default threshold is
//     deliberately neutral and should be tuned against a labelled set.
async function verifyLLMJudge(trace, verification, context, { client, judgeClient, problem }) {
  const method = 'llm-judge';

  // WHICH client serves the judge (kanban t_89720a07). An independent
  // judgeClient takes the call; the producer's client is only the
  // fallback when NO judge client was configured at all. A configured
  // judge client that is unavailable fails closed below — the call is
  // never re-routed to the candidate's model.
  const judge = judgeClient || client;
  const judgeConfigured = Boolean(judgeClient);

  if (!judge || typeof judge.generate !== 'function') {
    return {
      passed: false,
      method,
      details: {
        error: 'llm-judge requires an LLM client (pass { client } or { judgeClient } to verify()/heavy_think)',
      },
    };
  }

  const threshold = clampThreshold(verification.threshold ?? DEFAULT_JUDGE_THRESHOLD);
  const maxTraceChars = verification.max_trace_chars ?? DEFAULT_JUDGE_MAX_TRACE_CHARS;
  const task = firstString(verification.problem, context?.problem, problem);
  const system = verification.system_prompt || DEFAULT_JUDGE_SYSTEM_PROMPT;
  const prompt = {
    system,
    user: buildJudgeUserMessage({ task, trace, maxTraceChars }),
  };
  const opts = {
    phase: 'llm_judge',
    temperature: verification.temperature ?? 0,
    max_tokens: verification.max_tokens || DEFAULT_JUDGE_MAX_TOKENS,
  };

  let judged;
  try {
    judged = await generateJudge(judge, prompt, opts);
  } catch (err) {
    return {
      passed: false,
      method,
      details: {
        error: `llm-judge: judge call failed: ${err.message}`,
        // Which client was supposed to serve the verdict, and whether it
        // was an independent one (kanban t_89720a07). A configured judge
        // that failed is the fail-closed case: the verdict is lost, not
        // taken from the candidate's model.
        judge_client_source: judgeConfigured ? 'judge' : 'producer_fallback',
        judge_model: judge.model || null,
      },
    };
  }

  const verdict = parseJudgeVerdict(judged.text);
  if (!verdict) {
    return {
      passed: false,
      method,
      details: {
        error: 'llm-judge: judge returned an unparseable verdict (failing closed)',
        raw: String(judged.text || '').slice(0, 500),
        prompt_shape: judged.promptShape,
      },
    };
  }

  const passed = verdict.verdict === 'pass' && verdict.confidence >= threshold;
  return {
    passed,
    method,
    details: {
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      threshold,
      reason: verdict.reason,
      prompt_shape: judged.promptShape,
      model: judge.model || null,
      // Whether the verdict came from an INDEPENDENT judge client or from
      // the producer's own client (kanban t_89720a07).
      judge_client_source: judgeConfigured ? 'judge' : 'producer_fallback',
      cost_usd: judged.cost_usd || 0,
    },
  };
}

// Send the {system,user} prompt to the client. Older client builds accept a
// single string prompt only; for those we flatten the two roles into one
// message rather than dropping the judge entirely.
async function generateJudge(client, prompt, opts) {
  // A client that declares it cannot take an object prompt gets the flattened
  // string form up front — no wasted round-trip, and no silent send of an
  // object into a `content` field that only accepts a string.
  if (client.supportsObjectPrompt === false) {
    const res = await client.generate(flattenJudgePrompt(prompt), opts);
    return { text: res?.reasoning || res?.text || '', cost_usd: res?.cost_usd || 0, promptShape: 'string' };
  }
  try {
    const res = await client.generate(prompt, opts);
    return { text: res?.reasoning || res?.text || '', cost_usd: res?.cost_usd || 0, promptShape: 'system_user' };
  } catch (err) {
    if (!isObjectPromptUnsupported(err)) throw err;
    const res = await client.generate(flattenJudgePrompt(prompt), opts);
    return { text: res?.reasoning || res?.text || '', cost_usd: res?.cost_usd || 0, promptShape: 'string' };
  }
}

function flattenJudgePrompt(prompt) {
  return `${prompt.system}${JUDGE_TASK_SEPARATOR}${prompt.user}`;
}

// The legacy clients reject an object prompt with one of these messages.
function isObjectPromptUnsupported(err) {
  const msg = String(err?.message || '');
  return /prompt must be a string|must have either \.system/i.test(msg);
}

function buildJudgeUserMessage({ task, trace, maxTraceChars }) {
  const taskBlock = task
    ? `The task the agent was given:\n--- BEGIN TASK ---\n${task}\n--- END TASK ---`
    : 'No task statement was supplied. Judge the candidate solution on its own internal correctness and completeness.';
  const body = truncate(trace ?? '', maxTraceChars);
  return `${taskBlock}\n\nThe candidate solution:\n--- BEGIN SOLUTION ---\n${body}\n--- END SOLUTION ---`;
}

// Parse the judge's reply. Prefers strict JSON; falls back to a text form so
// a judge that ignores the JSON instruction is still usable — but an
// unrecognisable reply is NOT a verdict, and the caller fails closed on it.
function parseJudgeVerdict(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const verdict = normalizeVerdict(parsed.verdict ?? parsed.result ?? parsed.decision);
      if (verdict) {
        return {
          verdict,
          confidence: normalizeConfidence(parsed.confidence),
          reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        };
      }
    } catch {
      // fall through to the text form
    }
  }

  const verdictMatch = raw.match(/verdict\s*[:=]\s*"?\s*(pass|fail)\b/i);
  if (verdictMatch) {
    const confidenceMatch = raw.match(/confidence\s*[:=]\s*([0-9]*\.?[0-9]+)/i);
    const reasonMatch = raw.match(/reason\s*[:=]\s*"?([^"\n]+)/i);
    return {
      verdict: normalizeVerdict(verdictMatch[1]),
      confidence: confidenceMatch ? normalizeConfidence(parseFloat(confidenceMatch[1])) : 0.5,
      reason: reasonMatch ? reasonMatch[1].trim() : '',
    };
  }

  return null;
}

function normalizeVerdict(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['pass', 'passed', 'ok', 'accept', 'accepted'].includes(v)) return 'pass';
  if (['fail', 'failed', 'reject', 'rejected', 'error'].includes(v)) return 'fail';
  return null;
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return n <= 100 ? n / 100 : 1;
  return n;
}

function clampThreshold(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_JUDGE_THRESHOLD;
  return Math.max(0, Math.min(1, n));
}

function firstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return null;
}

function truncate(text, maxChars) {
  const s = String(text ?? '');
  if (!Number.isFinite(maxChars) || maxChars <= 0 || s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n[truncated ${s.length - maxChars} characters]`;
}

function extractCodeBlock(trace) {
  const m = trace.match(/```(?:bash|sh|shell)?\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}
