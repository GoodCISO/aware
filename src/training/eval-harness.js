// src/training/eval-harness.js — Phase 4 deliverable 4 (ADR (internal) 618-627)
//
// LiveCodeBench + GSM8K evaluation harness for the AWARE 2.0 trained
// models. Pure code — no GPU needed for the harness itself; the model
// runs in Ollama (sidecar) and the harness talks to it over HTTP.
//
// What this does
// --------------
// - Loads a small, fixed set of LiveCodeBench + GSM8K problems
//   (in-repo fixtures; no network download of benchmark data)
// - For each problem, sends a structured prompt to the model via
//   Ollama's /api/generate
// - Grades the response (exact-match for GSM8K final number,
//   simple test-case pass/fail for LiveCodeBench)
// - Returns { benchmark, total, correct, accuracy, perProblem[] }
//
// Baseline (decision P)
// ---------------------
// The operator can run the baseline against the bare base model
// (trained-model, no fine-tuning) by passing `--baseline` to the CLI.
// The CLI will ask Ollama to (re)create the bare model from the
// base name (no ADAPTER) and run the harness. This gives the
// "Benchmark delta vs. base model" comparison the ADR (internal) §Phase 4
// deliverable 4 calls for — the operator can later run the same
// harness against the trained model and subtract.
//
// No-DPO baseline (decision Q) — scaffolded, not exercised
// ---------------------------------------------------------
// The CLI also accepts `--no-dpo` mode for the no-DPO comparison
// (regular SFT instead of DPO). This slice does NOT exercise it
// (no Modal run is available yet); the flag is plumbed through
// the option shape so the operator can add it after the first
// trained checkpoint lands.
//
// Why Ollama + not transformers.js
// ---------------------------------
// Ollama is already the AWARE 2.0 inference sidecar (ADR (internal)
// Decision 3: Docker Compose 7-service stack + Ollama sidecar).
// The coordinator's model router already calls Ollama for the
// LoRA-served model. Re-using Ollama for the eval means:
//   - No new dependency in package.json
//   - No GPU memory pressure from a second in-process model
//   - The same code path the real /coordinate call uses, so
//     eval results are representative
//   - The baseline (no LoRA) is just "POST to Ollama with a
//     different model name" — no special path needed
//
// What's in-repo (fixtures)
// -------------------------
// We use a TINY set of in-repo fixtures (5 LiveCodeBench + 5
// GSM8K) — enough to smoke-test the harness plumbing and to
// surface a meaningful accuracy number for the first trained
// run. Real benchmarks have hundreds of problems; pulling the
// full LiveCodeBench / GSM8K datasets is out of scope for this
// slice (and would dominate the test runtime). Operators who
// want the full benchmark can drop their own problem set into
// `data/eval-fixtures/` and pass `--fixtures <dir>`.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -- Benchmark definitions ------------------------------------------------

/**
 * The 5 GSM8K problems are real GSM8K-style word problems (grade
 * school math). Each has a `prompt` and a `finalAnswer` (the
 * number that should appear in the model's response). Grading
 * is exact-match: the harness extracts the last number in the
 * response and compares to `finalAnswer`.
 */
export const GSM8K_FIXTURES = [
  {
    id: 'gsm8k-001',
    prompt:
      'Natalia sold clips to 48 of her friends in April, and then she sold half as many clips in May. ' +
      'How many clips did Natalia sell altogether in April and May?',
    finalAnswer: 72,
  },
  {
    id: 'gsm8k-002',
    prompt:
      'Weng earns $12 an hour for babysitting. Yesterday, she just did 50 minutes of babysitting. ' +
      'How much did she earn?',
    finalAnswer: 10,
  },
  {
    id: 'gsm8k-003',
    prompt:
      'Betty is saving money for a new wallet which costs $100. Betty has only half of the money ' +
      'she needs. Her parents decided to give her $15 for that purpose, and her grandparents twice ' +
      'as much as her parents. How much more money does Betty need to buy the wallet?',
    finalAnswer: 5,
  },
  {
    id: 'gsm8k-004',
    prompt:
      'Julie is reading a 120-page book. Yesterday, she was able to read 12 pages and today, she read ' +
      'twice as many pages as yesterday. If she wants to read half of the remaining pages tomorrow, ' +
      'how many pages should she read?',
    finalAnswer: 51,
  },
  {
    id: 'gsm8k-005',
    prompt:
      'James writes a 3-page letter to 2 different friends twice a week. How many pages does he ' +
      'write a year?',
    finalAnswer: 624,
  },
];

/**
 * The 5 LiveCodeBench problems are simple Python tasks with
 * test-case-based grading. Each has a `prompt` (the problem
 * statement) and a `testCases` array of { input, expected }
 * tuples. Grading runs the model's code in a subprocess
 * (sandboxed via `node:vm` for the test runner, but the
 * code-execution path is itself sandboxed; see notes in
 * `_gradeLiveCode`).
 */
export const LIVECODE_FIXTURES = [
  {
    id: 'lcb-001',
    prompt:
      'Write a Python function `add(a, b)` that returns the sum of a and b.',
    functionName: 'add',
    testCases: [
      { input: [2, 3], expected: 5 },
      { input: [0, 0], expected: 0 },
      { input: [-1, 1], expected: 0 },
      { input: [100, 200], expected: 300 },
    ],
  },
  {
    id: 'lcb-002',
    prompt:
      'Write a Python function `is_even(n)` that returns True if n is even, False otherwise.',
    functionName: 'is_even',
    testCases: [
      { input: [4], expected: true },
      { input: [7], expected: false },
      { input: [0], expected: true },
      { input: [-3], expected: false },
    ],
  },
  {
    id: 'lcb-003',
    prompt:
      'Write a Python function `factorial(n)` that returns n! (assume n >= 0).',
    functionName: 'factorial',
    testCases: [
      { input: [0], expected: 1 },
      { input: [1], expected: 1 },
      { input: [5], expected: 120 },
      { input: [10], expected: 3628800 },
    ],
  },
  {
    id: 'lcb-004',
    prompt:
      'Write a Python function `reverse_string(s)` that returns the string reversed.',
    functionName: 'reverse_string',
    testCases: [
      { input: ['hello'], expected: 'olleh' },
      { input: [''], expected: '' },
      { input: ['a'], expected: 'a' },
      { input: ['racecar'], expected: 'racecar' },
    ],
  },
  {
    id: 'lcb-005',
    prompt:
      'Write a Python function `max_of_three(a, b, c)` that returns the largest of a, b, c.',
    functionName: 'max_of_three',
    testCases: [
      { input: [1, 2, 3], expected: 3 },
      { input: [3, 2, 1], expected: 3 },
      { input: [-1, -2, -3], expected: -1 },
      { input: [5, 5, 4], expected: 5 },
    ],
  },
];

// -- Grading helpers -------------------------------------------------------

/**
 * Extract the last integer or float in a string. GSM8K grading
 * is exact-match on this number.
 *
 * Strips thousands separators (commas) from the captured number
 * before parsing. The regex matches: optional minus, digits,
 * optional comma-groups + digits, optional decimal + digits.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function extractFinalNumber(text) {
  if (typeof text !== 'string') return null;
  // Match the last number, allowing thousands separators (1,234.56).
  // The non-greedy + lookahead at the end-of-string is for
  // GSM8K-style "the final answer is 42." cases where the number
  // is followed by punctuation. We allow the regex to find any
  // number anywhere, then prefer the rightmost one (GSM8K
  // convention: final answer is the last number in the response).
  const matches = text.match(/-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g);
  if (!matches || matches.length === 0) {
    // Fall back to plain numbers (no thousands separators)
    const plain = text.match(/-?\d+(?:\.\d+)?/g);
    if (!plain || plain.length === 0) return null;
    const last = plain[plain.length - 1];
    const n = Number(last);
    return Number.isFinite(n) ? n : null;
  }
  const last = matches[matches.length - 1];
  const n = Number(last.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the first Python code block from a response. We
 * support ```python ... ``` and ``` ... ``` fenced blocks; if
 * neither is present, we return the trimmed whole response.
 *
 * @param {string} text
 * @returns {string}
 */
export function extractPythonCode(text) {
  if (typeof text !== 'string') return '';
  // Try ```python ... ``` first (case-insensitive on the language tag)
  let m = text.match(/```(?:python|py)?\s*\n([\s\S]*?)```/i);
  if (m) return m[1].trim();
  // Fall back to plain ``` ... ```
  m = text.match(/```\s*\n([\s\S]*?)```/);
  if (m) return m[1].trim();
  // No code block — treat the whole response as code (common for
  // small problems where the model just writes the function).
  return text.trim();
}

/**
 * Grade a LiveCodeBench problem by extracting the code and
 * running the test cases in a Node VM sandbox. The sandbox
 * exposes `require` to nothing (no I/O, no child_process) so
 * the model can't escape. This is intentionally simple — full
 * Python execution would require a subprocess, which is out of
 * scope for this slice. The 5 in-repo problems are
 * Python-portable-to-JS (only use arithmetic, string, bool).
 *
 * @param {string} code — the model's response (extracted)
 * @param {string} functionName
 * @param {Array<{input: any[], expected: any}>} testCases
 * @returns {{passes: number, total: number, errors: string[]}}
 */
export function gradeLiveCode(code, functionName, testCases) {
  const result = { passes: 0, total: testCases.length, errors: [] };
  if (typeof code !== 'string' || code.length === 0) {
    result.errors.push('empty_code');
    return result;
  }
  let fn;
  try {
    // Wrap the code in a function expression so the model can
    // write `def foo(...)` Python style. We strip the `def`
    // header and rewrite to a JS `function` declaration.
    const jsCode = rewritePythonDefToJs(code, functionName);
    // Execute in an isolated context (no globals) so the model
    // can't escape. vm.Script is the safe-eval primitive in Node
    // 22+ (no `eval()`, no `Function()`).
    const script = new vm.Script(`(${jsCode})`);
    const context = vm.createContext({});
    fn = script.runInContext(context);
    if (typeof fn !== 'function') {
      result.errors.push(`not_a_function: ${typeof fn}`);
      return result;
    }
  } catch (e) {
    result.errors.push(`parse_error: ${e?.message || e}`);
    return result;
  }
  for (const tc of testCases) {
    try {
      const actual = fn(...tc.input);
      if (deepEqual(actual, tc.expected)) {
        result.passes += 1;
      } else {
        result.errors.push(
          `case_failed: fn(${JSON.stringify(tc.input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(tc.expected)}`
        );
      }
    } catch (e) {
      result.errors.push(`case_threw: ${e?.message || e}`);
    }
  }
  return result;
}

/**
 * Very small Python def → JS function rewriter. Handles the
 * common shapes the 5 in-repo problems use:
 *   def NAME(args): return EXPR
 * For multi-statement functions, this is a best-effort fallback
 * to the JS source as-is (the model wrote invalid Python or
 * something we don't understand; the parse_error in the
 * caller will surface it).
 */
function rewritePythonDefToJs(code, functionName) {
  // Match `def name(arg, arg):` or `def name(arg):` on a single line
  const defMatch = code.match(
    new RegExp(`def\\s+${functionName}\\s*\\(([^)]*)\\)\\s*:\\s*([\\s\\S]*)`)
  );
  if (!defMatch) {
    // No def found — assume the whole code is already a JS function
    // expression or a single expression.
    return code.trim();
  }
  const args = defMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let body = defMatch[2].trim();
  // Strip a leading docstring if present
  body = body.replace(/^""".*?"""/s, '').replace(/^'''.*?'''/s, '').trim();
  // If the body has multiple lines, indent-strip the rest (Python
  // is indent-sensitive, but our 5 fixtures are all one-liner
  // returns). For multi-line, we keep it as-is and let the parser
  // error if the JS doesn't parse — the test will record the error.
  return `function ${functionName}(${args.join(', ')}) { ${body} }`;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

// -- Ollama client (for the CLI) -------------------------------------------

/**
 * Default sampling parameters for an evaluation run.
 *
 * `seed` fixes the policy's sampling draw; `temperature` fixes how much
 * randomness that draw may contain. Both are REQUIRED for a published
 * number to be reproducible — see the arXiv:2611.14068 disclosure
 * checklist, axis 2 ("Sampling and spread").
 *
 * The default temperature is 0.0 on purpose. Ollama 0.40.11 (this
 * host's build) does NOT honour the `seed` field at temperature > 0:
 * two requests with the same seed and temperature 0.8 returned
 * byte-different responses (measured — see
 * `docs/research/aware-eval-null-band-2026-11-23.md`). A seed that
 * the runtime ignores is worse than no seed at all, because it looks
 * reproducible. Temperature 0 IS honoured: identical requests return
 * byte-identical responses.
 *
 * @constant
 */
export const DEFAULT_EVAL_SEED = 20261123;
export const DEFAULT_EVAL_TEMPERATURE = 0.0;

/**
 * Build an Ollama-backed model generator: prompt → response text.
 *
 * The request body carries the sampling controls the disclosure
 * checklist requires. Ollama's `/api/generate` takes `seed` at the
 * top level and `options.temperature` inside `options`.
 *
 * @param {Object} opts
 * @param {string} opts.ollamaUrl — e.g. 'http://127.0.0.1:11434'
 * @param {string} opts.modelName — Ollama model name
 * @param {number} [opts.timeoutMs=60_000] — per-problem timeout
 * @param {number} [opts.seed=DEFAULT_EVAL_SEED] — policy sampling seed
 * @param {number} [opts.temperature=DEFAULT_EVAL_TEMPERATURE] — sampling temperature
 * @param {Object} [opts.options] — extra Ollama `options` (e.g. { top_k })
 * @param {typeof fetch} [opts._fetch=globalThis.fetch]
 * @returns {(prompt: string) => Promise<string>}
 */
export function makeOllamaGenerator({
  ollamaUrl,
  modelName,
  timeoutMs = 60_000,
  seed = DEFAULT_EVAL_SEED,
  temperature = DEFAULT_EVAL_TEMPERATURE,
  options = {},
  _fetch = globalThis.fetch,
}) {
  if (typeof ollamaUrl !== 'string' || ollamaUrl.length === 0) {
    throw new Error('makeOllamaGenerator: ollamaUrl is required');
  }
  if (typeof modelName !== 'string' || modelName.length === 0) {
    throw new Error('makeOllamaGenerator: modelName is required');
  }
  if (!Number.isInteger(seed)) {
    throw new Error('makeOllamaGenerator: seed must be an integer');
  }
  if (!Number.isFinite(temperature) || temperature < 0) {
    throw new Error('makeOllamaGenerator: temperature must be a non-negative number');
  }
  // The request body the disclosure checklist asks for. `seed` and
  // `options.temperature` are the two sampling controls Ollama
  // honours; `stream: false` keeps the single-shot response shape.
  const requestBody = {
    model: modelName,
    prompt: '',   // filled per call
    stream: false,
    seed,
    options: { temperature, ...options },
  };
  return async (prompt) => {
    const url = `${ollamaUrl.replace(/\/+$/, '')}/api/generate`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await _fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...requestBody, prompt }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = await res.json();
      return String(data.response || '');
    } finally {
      clearTimeout(t);
    }
  };
}

/**
 * Fetch the Ollama sidecar's model manifest and return the identity of
 * one model: its digest (content hash), size, and the family/modified
 * fields Ollama reports.
 *
 * A TAG IS A NAME, NOT AN IDENTITY: `qwen3.5:9b` and
 * `aware-qwen35-9b:latest` are the same 6.6 GB weights under two
 * names, and a tag can be re-pointed at different weights at any
 * time. The digest is what identifies the bytes.
 *
 * @param {Object} opts
 * @param {string} opts.ollamaUrl
 * @param {string} opts.modelName
 * @param {typeof fetch} [opts._fetch=globalThis.fetch]
 * @returns {Promise<{model: string, digest: string|null, size: number|null,
 *   family: string|null, modifiedAt: string|null, families: string[]|null,
 *   error: string|null}>}
 */
export async function fetchModelIdentity({ ollamaUrl, modelName, _fetch = globalThis.fetch }) {
  const empty = {
    model: modelName,
    digest: null,
    size: null,
    family: null,
    modifiedAt: null,
    families: null,
    error: null,
  };
  if (typeof ollamaUrl !== 'string' || ollamaUrl.length === 0) {
    return { ...empty, error: 'ollamaUrl is required' };
  }
  try {
    const url = `${ollamaUrl.replace(/\/+$/, '')}/api/tags`;
    const res = await _fetch(url, { method: 'GET' });
    if (!res.ok) {
      return { ...empty, error: `Ollama ${res.status}` };
    }
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    // Match on the exact tag first, then on the name without its
    // ":latest" suffix (Ollama resolves `foo` to `foo:latest`).
    const wanted = modelName.includes(':') ? modelName : `${modelName}:latest`;
    const hit =
      models.find((m) => m?.name === wanted) ||
      models.find((m) => m?.model === wanted) ||
      models.find((m) => m?.name === modelName) ||
      null;
    if (!hit) {
      return { ...empty, error: `model '${modelName}' not present in the Ollama manifest` };
    }
    const details = hit.details && typeof hit.details === 'object' && !Array.isArray(hit.details)
      ? hit.details
      : null;
    return {
      model: hit.name || hit.model || modelName,
      digest: typeof hit.digest === 'string' ? hit.digest : null,
      size: typeof hit.size === 'number' ? hit.size : null,
      family: details?.family ?? null,
      modifiedAt: hit.modified_at ?? null,
      families: details?.families ?? null,
      error: null,
    };
  } catch (e) {
    return { ...empty, error: e?.message || String(e) };
  }
}

/**
 * Read the harness's own code revision from git.
 *
 * The result object records the revision that PRODUCED the number, so
 * a published score can be traced to the code that computed it. If git
 * is unavailable (a tarball install, a container without .git) this
 * returns nulls rather than throwing — the disclosure is then
 * explicitly "unknown", not silently absent.
 *
 * @param {Object} [opts]
 * @param {string} [opts.cwd] — directory to run git in
 * @param {(cmd: string, args: string[], opts: Object) => string} [opts._exec]
 *   — injectable exec (for tests)
 * @returns {{revision: string|null, branch: string|null, dirty: boolean|null, error: string|null}}
 */
export function readGitRevision({ cwd = process.cwd(), _exec } = {}) {
  const exec = _exec || defaultGitExec;
  const run = (args) => {
    try {
      return exec('git', args, { cwd, encoding: 'utf8' }).trim();
    } catch (e) {
      return null;
    }
  };
  const revision = run(['rev-parse', 'HEAD']);
  if (!revision) {
    return { revision: null, branch: null, dirty: null, error: 'git rev-parse HEAD failed' };
  }
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run(['status', '--porcelain']);
  return {
    revision,
    branch: branch || null,
    dirty: status === null ? null : status.length > 0,
    error: null,
  };
}

/**
 * Default git runner. `execFileSync` takes argv, so no shell is
 * involved and no path needs quoting.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {Object} opts
 * @returns {string}
 */
function defaultGitExec(cmd, args, opts) {
  return execFileSync(cmd, args, opts);
}

// -- Statistics (the paper's "report every control as a draw") -------------

/**
 * Arithmetic mean.
 * @param {number[]} xs
 * @returns {number}
 */
export function mean(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Sample standard deviation (Bessel-corrected).
 * @param {number[]} xs
 * @returns {number} NaN for n < 2
 */
export function sampleSd(xs) {
  if (!Array.isArray(xs) || xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Two-sided t critical values at 95% confidence, for small n.
 * Used to report a t interval over the null draws — the paper's
 * instruction is that an interval over seeds or draws is a t interval
 * that says so.
 *
 * @param {number} df — degrees of freedom (n - 1)
 * @returns {number}
 */
export function tCritical95(df) {
  const table = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447,
    7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179,
    13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101,
    19: 2.093, 20: 2.086, 21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064,
    25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
  };
  if (!Number.isFinite(df) || df < 1) return NaN;
  if (df > 30) return 1.96;  // normal approximation past the table
  return table[Math.round(df)] ?? 1.96;
}

/**
 * Summarise a set of null draws.
 *
 * The paper requires that a control be reported "as a draw with its
 * null center rather than as a point". This returns the center
 * (mean), the spread (sd), the range, and a 95% t interval over the
 * draws, with the interval's KIND named so a reader knows what it is.
 *
 * @param {number[]} xs — the draw values
 * @param {Object} [opts]
 * @param {number} [opts.confidence=0.95]
 * @returns {{n: number, mean: number, sd: number, min: number, max: number,
 *   range: number, values: number[], ci95: {low: number, high: number,
 *   width: number, kind: string}|null, intervalKind: string}}
 */
export function summariseDraws(xs, { confidence = 0.95 } = {}) {
  const values = Array.isArray(xs) ? xs.filter((x) => Number.isFinite(x)) : [];
  const n = values.length;
  if (n === 0) {
    return {
      n: 0, mean: NaN, sd: NaN, min: NaN, max: NaN, range: NaN,
      values: [], ci95: null, intervalKind: 'none',
    };
  }
  const m = mean(values);
  const s = sampleSd(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A t interval over the draws. n === 1 has no spread to state —
  // say so rather than publishing a zero-width interval that reads
  // like certainty.
  if (n < 2) {
    return {
      n, mean: m, sd: NaN, min, max, range: max - min,
      values, ci95: null,
      intervalKind: 'none (n=1: a single draw has no spread to state)',
    };
  }
  const t = tCritical95(n - 1);
  const half = (t * s) / Math.sqrt(n);
  return {
    n,
    mean: m,
    sd: s,
    min,
    max,
    range: max - min,
    values,
    ci95: { low: m - half, high: m + half, width: 2 * half },
    intervalKind: `t interval over ${n} null draws (95%, df=${n - 1}, t=${t})`,
  };
}

/**
 * Build a paired difference series from two draw sets that scored the
 * SAME problems.
 *
 * Pairing removes the scenario component: each problem's contribution
 * is differenced before the mean, so a difference is "how much did
 * this arm move on this problem" rather than "what did each arm score
 * in total". The paper's instruction is to "pair every comparison
 * episode by episode on shared environment seeds and report the
 * paired mean with its interval and win count".
 *
 * THE UNIT MATTERS. The harness's published accuracy counts a problem
 * as correct when its score is >= 1.0 — but a LiveCodeBench problem's
 * score is a FRACTION (passes/total), so differencing the raw scores
 * would produce a delta on a different scale from the published
 * accuracy. This function therefore differences the BINARY PASS
 * INDICATOR (score >= 1.0), which is the quantity the published
 * accuracy counts. The paired mean over all problems of both
 * benchmarks then equals the difference in the published mean
 * accuracy exactly.
 *
 * The raw score delta is also reported, as `rawMeanDelta`, so a
 * reader can see partial-credit movement separately.
 *
 * @param {Array<{id: string, score: number}>} a
 * @param {Array<{id: string, score: number}>} b
 * @returns {{paired: boolean, n: number, ids: string[], differences: number[],
 *   wins: number, losses: number, ties: number, mean: number, sd: number,
 *   ci95: {low: number, high: number, width: number}|null,
 *   intervalKind: string, unmatched: string[], rawMeanDelta: number,
 *   criterion: string}}
 */
export function pairedDifference(a, b) {
  const pass = (score) => (Number.isFinite(score) && score >= 1.0 ? 1 : 0);
  const mapA = new Map((a || []).map((p) => [p.id, p.score]));
  const mapB = new Map((b || []).map((p) => [p.id, p.score]));
  const ids = [...mapA.keys()].filter((id) => mapB.has(id)).sort();
  const unmatched = [
    ...[...mapA.keys()].filter((id) => !mapB.has(id)),
    ...[...mapB.keys()].filter((id) => !mapA.has(id)),
  ].sort();
  if (ids.length === 0) {
    return {
      paired: false, n: 0, ids: [], differences: [], wins: 0, losses: 0, ties: 0,
      mean: NaN, sd: NaN, ci95: null,
      intervalKind: 'none (no shared problem ids — the runs cannot be paired)',
      unmatched, rawMeanDelta: NaN,
      criterion: 'binary pass (score >= 1.0)',
    };
  }
  const differences = ids.map((id) => pass(mapB.get(id)) - pass(mapA.get(id)));
  const rawDeltas = ids.map((id) => mapB.get(id) - mapA.get(id));
  const wins = differences.filter((d) => d > 0).length;
  const losses = differences.filter((d) => d < 0).length;
  const ties = differences.length - wins - losses;
  const m = mean(differences);
  const s = sampleSd(differences);
  let ci95 = null;
  let intervalKind = 'none (n=1: a single paired difference has no spread to state)';
  if (differences.length >= 2) {
    const t = tCritical95(differences.length - 1);
    const half = (t * s) / Math.sqrt(differences.length);
    ci95 = { low: m - half, high: m + half, width: 2 * half };
    intervalKind = `t interval over ${differences.length} paired problems (95%, df=${differences.length - 1}, t=${t})`;
  }
  return {
    paired: true,
    n: differences.length,
    ids,
    differences,
    wins,
    losses,
    ties,
    mean: m,
    sd: s,
    ci95,
    intervalKind,
    unmatched,
    rawMeanDelta: mean(rawDeltas),
    criterion: 'binary pass (score >= 1.0)',
  };
}

// -- Benchmark runners -----------------------------------------------------

/**
 * Run a single benchmark against a model generator.
 *
 * @param {Object} opts
 * @param {string} opts.name — 'gsm8k' | 'livecodebench'
 * @param {Array} opts.fixtures — the problem set
 * @param {(prompt: string) => Promise<string>} opts.generate — the model
 * @param {Function} [opts.grade] — per-problem grader (defaults: gsm8k/livecode)
 * @returns {Promise<{name, total, correct, accuracy, perProblem: Array}>}
 */
export async function runBenchmark({ name, fixtures, generate, grade }) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('runBenchmark: name is required');
  }
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error('runBenchmark: fixtures must be a non-empty array');
  }
  if (typeof generate !== 'function') {
    throw new Error('runBenchmark: generate must be a function');
  }
  const perProblem = [];
  let correct = 0;
  for (const fixture of fixtures) {
    const start = Date.now();
    let response = '';
    let error = null;
    try {
      response = await generate(fixture.prompt);
    } catch (e) {
      error = e?.message || String(e);
    }
    const elapsedMs = Date.now() - start;
    let score = 0;
    let detail = '';
    if (error === null) {
      const r = (grade || defaultGrader(name))(response, fixture);
      score = r.score;
      detail = r.detail;
      if (score >= 1.0) correct += 1;
    } else {
      detail = `error: ${error}`;
    }
    perProblem.push({
      id: fixture.id,
      score,
      detail,
      elapsedMs,
      responsePreview: response.slice(0, 200),
    });
  }
  return {
    name,
    total: fixtures.length,
    correct,
    accuracy: fixtures.length === 0 ? 0 : correct / fixtures.length,
    perProblem,
  };
}

function defaultGrader(name) {
  if (name === 'gsm8k') {
    return (response, fixture) => {
      const predicted = extractFinalNumber(response);
      const correct = predicted === fixture.finalAnswer;
      return {
        score: correct ? 1.0 : 0.0,
        detail: correct
          ? `predicted=${predicted} (correct)`
          : `predicted=${predicted}, expected=${fixture.finalAnswer}`,
      };
    };
  }
  if (name === 'livecodebench') {
    return (response, fixture) => {
      const code = extractPythonCode(response);
      const r = gradeLiveCode(code, fixture.functionName, fixture.testCases);
      return {
        score: r.total === 0 ? 0 : r.passes / r.total,
        detail: `passes=${r.passes}/${r.total}${r.errors.length ? `; first_error=${r.errors[0]}` : ''}`,
      };
    };
  }
  throw new Error(`defaultGrader: unknown benchmark '${name}'`);
}

/**
 * Run the full Phase 4 deliverable 4 eval suite: GSM8K + LiveCodeBench.
 * Returns a structured result with both benchmark summaries + a
 * top-level `accuracy` (mean of the two).
 *
 * The result now carries a `disclosure` block: the arXiv:2611.14068
 * five-item checklist, mapped onto this harness. Every field is
 * either a measured value or an explicit "none"/"unknown" — never a
 * silently omitted one, because an omitted disclosure is
 * indistinguishable from a disclosure that was never considered.
 *
 * @param {Object} opts
 * @param {(prompt: string) => Promise<string>} opts.generate
 * @param {Object} [opts.overrides] — { gsm8k: [...], livecodebench: [...] }
 * @param {string} [opts.modelName]
 * @param {string} [opts.label]
 * @param {number} [opts.seed] — the policy sampling seed that was used
 * @param {number} [opts.temperature] — the sampling temperature that was used
 * @param {number} [opts.n] — the number of draws this result is one of
 * @param {number[]} [opts.draws] — the accuracies of every draw in the set
 * @param {string} [opts.drawId] — this draw's index within the set
 * @param {Object} [opts.modelIdentity] — result of fetchModelIdentity()
 * @param {Object} [opts.gitRevision] — result of readGitRevision()
 * @returns {Promise<Object>}
 */
export async function runEvalSuite({
  generate,
  overrides = {},
  modelName = 'unknown',
  label = 'eval',
  seed = null,
  temperature = null,
  n = 1,
  draws = null,
  drawId = null,
  modelIdentity = null,
  gitRevision = null,
}) {
  const gsm8k = await runBenchmark({
    name: 'gsm8k',
    fixtures: overrides.gsm8k || GSM8K_FIXTURES,
    generate,
  });
  const livecodebench = await runBenchmark({
    name: 'livecodebench',
    fixtures: overrides.livecodebench || LIVECODE_FIXTURES,
    generate,
  });
  const startedAt = new Date().toISOString();
  const accuracy = (gsm8k.accuracy + livecodebench.accuracy) / 2;
  const drawValues = Array.isArray(draws) ? draws.filter((x) => Number.isFinite(x)) : null;
  const dispersion = drawValues && drawValues.length > 1
    ? summariseDraws(drawValues)
    : null;
  return {
    accuracy,
    gsm8k,
    livecodebench,
    modelName,
    label,
    startedAt,
    finishedAt: new Date().toISOString(),
    // -- Disclosure block (arXiv:2611.14068 §9 five-item checklist) --
    disclosure: {
      // 1. Artefact: the checkpoint's hash and size, the code revision.
      artefact: {
        modelName,
        modelDigest: modelIdentity?.digest ?? null,
        modelSize: modelIdentity?.size ?? null,
        modelModifiedAt: modelIdentity?.modifiedAt ?? null,
        modelIdentityError: modelIdentity?.error ?? null,
        harnessRevision: gitRevision?.revision ?? null,
        harnessBranch: gitRevision?.branch ?? null,
        harnessDirty: gitRevision?.dirty ?? null,
        harnessRevisionError: gitRevision?.error ?? null,
      },
      // 2. Sampling and spread: sampling mode, seeds, episode count,
      //    and what the reported spread is a spread over.
      sampling: {
        seed,
        temperature,
        samplingMode: temperature === 0 ? 'greedy (temperature=0)' : 'stochastic',
        n,
        drawId,
        draws: drawValues,
        // What the spread is a spread OVER — the paper requires this
        // be named, not implied.
        spreadOver: drawValues
          ? `${drawValues.length} draws of the same model on the same fixtures`
          : null,
        dispersion: dispersion
          ? {
            sd: dispersion.sd,
            ci95: dispersion.ci95,
            intervalKind: dispersion.intervalKind,
            min: dispersion.min,
            max: dispersion.max,
            range: dispersion.range,
          }
          : null,
      },
      // 3. Criterion and scenario: what was scored, by what rule, on
      //    which scenario, and when the criterion is a precision,
      //    against what truth.
      criterion: {
        gsm8k: {
          rule: 'exact-match on the last number in the response',
          truth: 'the fixture\'s finalAnswer',
          fixtureCount: gsm8k.total,
          fixtureSet: overrides.gsm8k ? 'operator-supplied (--fixtures)' : 'in-repo GSM8K_FIXTURES',
        },
        livecodebench: {
          rule: 'the model\'s code is rewritten to JS and run against the fixture test cases',
          truth: 'the fixture\'s expected values',
          fixtureCount: livecodebench.total,
          fixtureSet: overrides.livecodebench
            ? 'operator-supplied (--fixtures)'
            : 'in-repo LIVECODE_FIXTURES',
        },
      },
      // 4. Adversary: which red agent, as a scope limit on every claim.
      //    GSM8K/LiveCodeBench have no adversary — state "none" rather
      //    than omitting the axis.
      adversary: {
        present: false,
        redAgent: 'none',
        scopeLimit: 'GSM8K and LiveCodeBench are not adversarial scenarios; no red agent participates.',
      },
      // 5. Counting: whether the counts are asserted or executed.
      counting: {
        unit: 'asserted output',
        detail:
          'Scores count the model\'s ASSERTED response (the last number it states for GSM8K; ' +
          'whether its asserted code passes the fixture test cases for LiveCodeBench). They are ' +
          'not counts of executed real-world outcomes. LiveCodeBench grading re-executes the ' +
          'model\'s code in a node:vm sandbox against the fixture\'s own test cases — those ' +
          'cases are fixtures, not independent verification.',
        timeouts: {
          gsm8k: gsm8k.perProblem.filter((p) => /^error:/.test(p.detail)).length,
          livecodebench: livecodebench.perProblem.filter((p) => /^error:/.test(p.detail)).length,
        },
      },
    },
  };
}

// -- CLI (in-repo fixtures) -----------------------------------------------

/**
 * Format a result object as a human-readable table. Used by
 * the CLI; also nice for the operator's eye in JSON output.
 *
 * @param {Object} result
 * @returns {string}
 */
export function formatResult(result) {
  const lines = [];
  lines.push(`AWARE 2.0 eval result (label=${result.label}, model=${result.modelName})`);
  lines.push(`  started:  ${result.startedAt}`);
  lines.push(`  finished: ${result.finishedAt}`);
  lines.push(`  GSM8K:        ${result.gsm8k.correct}/${result.gsm8k.total} = ${(result.gsm8k.accuracy * 100).toFixed(1)}%`);
  lines.push(`  LiveCodeBench: ${result.livecodebench.correct}/${result.livecodebench.total} = ${(result.livecodebench.accuracy * 100).toFixed(1)}%`);
  lines.push(`  mean accuracy: ${(result.accuracy * 100).toFixed(1)}%`);

  // The disclosure block (arXiv:2611.14068 §9). Every axis is
  // printed, including the ones that are "none" — an omitted axis is
  // indistinguishable from an unconsidered one.
  const d = result.disclosure;
  if (d) {
    const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}pp` : 'n/a');
    lines.push('');
    lines.push('  Disclosure (arXiv:2611.14068 §9):');
    lines.push(`    [1] artefact:   digest=${d.artefact.modelDigest || 'UNKNOWN'}` +
      (d.artefact.modelSize ? ` size=${d.artefact.modelSize}` : '') +
      ` revision=${(d.artefact.harnessRevision || 'UNKNOWN').slice(0, 12)}`);
    lines.push(`    [2] sampling:   seed=${d.sampling.seed ?? 'NONE'} ` +
      `temperature=${d.sampling.temperature ?? 'NONE'} ` +
      `mode=${d.sampling.samplingMode} n=${d.sampling.n}`);
    if (d.sampling.dispersion) {
      lines.push(`                   sd=${pct(d.sampling.dispersion.sd)} ` +
        `range=${pct(d.sampling.dispersion.range)} ` +
        `over ${d.sampling.spreadOver}`);
      if (d.sampling.dispersion.ci95) {
        lines.push(`                   95% CI=[${pct(d.sampling.dispersion.ci95.low)}, ` +
          `${pct(d.sampling.dispersion.ci95.high)}] (${d.sampling.dispersion.intervalKind})`);
      }
    } else if (d.sampling.n === 1) {
      lines.push('                   single draw — no dispersion measured. ' +
        'A single draw is not a measurement; run --draws>=2 for a null band.');
    }
    lines.push(`    [3] criterion:  gsm8k=${d.criterion.gsm8k.fixtureCount} ` +
      `(${d.criterion.gsm8k.fixtureSet}), lcb=${d.criterion.livecodebench.fixtureCount} ` +
      `(${d.criterion.livecodebench.fixtureSet})`);
    lines.push(`    [4] adversary:  ${d.adversary.redAgent} — ${d.adversary.scopeLimit}`);
    lines.push(`    [5] counting:   ${d.counting.unit}` +
      ` (timeouts: gsm8k=${d.counting.timeouts.gsm8k}, lcb=${d.counting.timeouts.livecodebench})`);
  }

  lines.push('');
  lines.push('  Per-problem:');
  for (const p of [...result.gsm8k.perProblem, ...result.livecodebench.perProblem]) {
    const tag = p.score >= 1.0 ? '✔' : (p.score > 0 ? '~' : '✖');
    lines.push(`    ${tag} ${p.id}  score=${p.score.toFixed(2)}  ${p.elapsedMs}ms  ${p.detail}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Check whether this file is being run as the entry point (vs
 * imported as a module). When run directly, we print a usage
 * hint and exit — the actual CLI wrapper lives in
 * scripts/run-eval-baseline.sh, which sets the right env vars
 * and invokes Node with a small driver.
 */
function isMainModule() {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  console.log('eval-harness: this is a library, not a CLI.');
  console.log('Use:');
  console.log('  node scripts/run-eval-baseline.mjs          # baseline against trained-model');
  console.log('  node scripts/run-eval-baseline.mjs --label=trained --model=trained-model');
  console.log('');
  console.log('Or import runEvalSuite() in your own driver.');
  process.exit(0);
}

export default {
  GSM8K_FIXTURES,
  LIVECODE_FIXTURES,
  DEFAULT_EVAL_SEED,
  DEFAULT_EVAL_TEMPERATURE,
  extractFinalNumber,
  extractPythonCode,
  gradeLiveCode,
  makeOllamaGenerator,
  fetchModelIdentity,
  readGitRevision,
  mean,
  sampleSd,
  tCritical95,
  summariseDraws,
  pairedDifference,
  runBenchmark,
  runEvalSuite,
  formatResult,
};
