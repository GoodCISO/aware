// test/judge-served-model.test.js
//
// The pair record must name the model that ACTUALLY SERVED the score —
// not the model that was ASKED FOR (kanban t_49d955b7).
//
// WHY THIS FILE EXISTS
// --------------------
// t_dc053dc2 resolved the effective judge model ONCE and asserted a strong
// invariant: "the record can no longer name a model that did not serve".
// The invariant's PREMISE was false for one of AWARE's judge paths.
//
// The premise was stated in the fix's own new doc comment:
//
//   "every AWARE client honours `opts.model` over its own default — so the
//    override really does decide which model serves the score."
//
// AWARE's Ollama judge client does NOT read `opts.model` at all. It posts
// its own configured model and ignores the override, so the record named a
// model that did not serve.
//
// THE CONSEQUENCE (the dangerous half)
// -----------------------------------
// The misnamed judge is not merely a wrong label. AWARE's family rule
// demotes a SAME-FAMILY judge to `diagnostic` with
// `prm_score_independent=false`, so a same-family judge can never gate a
// launch (04-ai-product-evaluation.md:240-243). A record that names the
// OVERRIDE instead of the SERVED model escapes that demotion entirely:
//
//   candidate      : MiniMax-M3.1-Flash   (family: minimax)
//   judge SERVED   : MiniMax-M2           (family: minimax)  <-- same family
//   record NAMES   : qwen3-32b            (family: qwen)     <-- different
//
// The record then declares `prm_score_independent=true` and
// `prm_score_role='launch_gate'` for a judge that is in the candidate's own
// model family. That is exactly the contradiction audit t_8f049433 found
// and t_dc053dc2 exists to close.
//
// THE CONTRACT
// ------------
// A judge client reports WHICH MODEL IT SERVED, and the record prefers that
// report over the resolved intent:
//
//   * POST-CALL  — `result.served_model` on the generate result.
//   * PRE-CALL   — `client.resolveServedModel(genOpts)`, which the PRM
//                  cache key needs (the key is computed before any score
//                  exists).
//
// Both halves are opt-in. A client that reports neither is not wrong; it is
// silent, and the resolved intent stands.
//
// NON-VACUITY
// -----------
// This file imports ONLY the API that exists before the fix (`heavy_think`,
// `scoreWithPRM`), and uses the literal `served_model` key rather than an
// exported constant. It therefore LOADS against the pre-fix tree and fails
// on the BEHAVIOURAL assertions below — not on a missing export. The
// helper-level unit tests live in `judge-served-model-helpers.test.js`,
// which exercises the new API directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { heavy_think } from "../src/index.js";
import { scoreWithPRM } from "../src/prm.js";

const CANDIDATE = "MiniMax-M3.1-Flash";

/**
 * A judge client that IGNORES `opts.model` — the shape AWARE's Ollama judge
 * client had. It serves its OWN model whatever the caller asks for.
 *
 * It reports the model it served under `served_model`, so the record can
 * name the truth rather than the request.
 */
function buildIgnoringJudgeClient(name, { model, score = 8 } = {}) {
  const calls = [];
  return {
    name,
    model,
    calls,
    // The PRE-CALL half: this client knows it will ignore the override.
    resolveServedModel(genOpts = {}) {
      return model;
    },
    async generate(prompt, opts = {}) {
      calls.push({ opts: { ...opts } });
      if (opts.phase === "prm_score") {
        const refined = JSON.stringify(prompt).includes("REFINED");
        return {
          reasoning: JSON.stringify({
            score: refined ? 10 : score,
            strengths: [],
            weaknesses: [],
          }),
          cost_usd: 0,
          // The POST-CALL half: what actually served.
          served_model: model,
        };
      }
      if (opts.phase === "refine") {
        return { reasoning: "REFINED: better answer", cost_usd: 0 };
      }
      return { reasoning: `${name} attempt`, cost_usd: 0 };
    },
  };
}

/** A client that honours `opts.model` (the provider-client shape). */
function buildHonouringClient(name, { model, score = 8 } = {}) {
  const calls = [];
  return {
    name,
    model,
    calls,
    resolveServedModel(genOpts = {}) {
      return genOpts.model || model;
    },
    async generate(prompt, opts = {}) {
      calls.push({ opts: { ...opts } });
      const served = opts.model || model;
      if (opts.phase === "prm_score") {
        const refined = JSON.stringify(prompt).includes("REFINED");
        return {
          reasoning: JSON.stringify({
            score: refined ? 10 : score,
            strengths: [],
            weaknesses: [],
          }),
          cost_usd: 0,
          served_model: served,
        };
      }
      if (opts.phase === "refine") {
        return { reasoning: "REFINED: better answer", cost_usd: 0 };
      }
      return { reasoning: `${name} attempt`, cost_usd: 0 };
    },
  };
}

/** The model the client actually used for the PRM score. */
function servedModel(client) {
  const call = client.calls.find((c) => c.opts?.phase === "prm_score");
  return call?.opts?.model || client.model;
}

/** Run heavy_think and return the written pair record plus the clients. */
async function run({ override, role, judge } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ht-served-"));
  const pairPath = join(dir, "pairs.jsonl");
  const producer = buildHonouringClient("producer", { model: CANDIDATE });
  try {
    await heavy_think({
      problem: "Q?",
      K: 1,
      task_type: "standard",
      client: producer,
      judgeClient: judge || null,
      prm: {
        ...(override ? { model: override } : {}),
        ...(role ? { role } : {}),
      },
      preferencePairPath: pairPath,
    });
    const raw = (await readFile(pairPath, "utf8")).trim();
    return { record: JSON.parse(raw.split("\n")[0]), producer };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// === AC1: the record names the model that ACTUALLY served ================

test("served-model: a judge that ignores opts.model is named on the record as the model that served", async () => {
  // THE defect: the judge serves MiniMax-M2 whatever the override says.
  const judge = buildIgnoringJudgeClient("judge", { model: "MiniMax-M2" });
  const { record } = await run({ override: "qwen3-32b", judge });

  assert.equal(
    record.prm_score_judge_model,
    "MiniMax-M2",
    "the pair record must name the model that actually served the score"
  );
  assert.notEqual(
    record.prm_score_judge_model,
    "qwen3-32b",
    "the record must NOT name the requested model when the judge ignored it"
  );
});

test("served-model: the score's own judge_model agrees with the record", async () => {
  const judge = buildIgnoringJudgeClient("judge", { model: "MiniMax-M2" });
  const out = await scoreWithPRM({
    problem: "Q?",
    reasoning: "reasoning",
    task_type: "standard",
    client: judge,
    prmConfig: { model: "qwen3-32b" },
  });
  assert.equal(out.judge_model, "MiniMax-M2", "the score must report the served model");
  assert.equal(out.served_model, "MiniMax-M2", "the raw served-model report must be kept");
});

// === AC2: a same-family judge that ignored the override must NOT gate ====
//
// This is the dangerous half of the defect: the family rule demotes a
// same-family judge to `diagnostic`, but only if the record NAMES the judge
// that served. A record that names the override escapes the demotion.

test("served-model: a same-family judge that ignored the override is demoted to diagnostic", async () => {
  // The judge SERVES MiniMax-M2 (family: minimax, same as the candidate
  // MiniMax-M3.1-Flash). The override names qwen3-32b (family: qwen).
  const judge = buildIgnoringJudgeClient("judge", { model: "MiniMax-M2" });
  const { record } = await run({ override: "qwen3-32b", role: "launch_gate", judge });

  assert.equal(
    record.prm_score_independent,
    false,
    "a same-family judge may never be declared independent"
  );
  assert.equal(
    record.prm_score_role,
    "diagnostic",
    "a same-family judge may never hold a gating role"
  );
});

test("served-model: a served judge in ANOTHER family still gates (the fix is not a blanket ban)", async () => {
  // The judge serves qwen3-32b — a different family from the candidate —
  // so the record may gate, exactly as before the fix.
  const judge = buildIgnoringJudgeClient("judge", { model: "qwen3-32b" });
  const { record } = await run({ override: "MiniMax-M2", role: "launch_gate", judge });

  assert.equal(record.prm_score_independent, true);
  assert.equal(record.prm_score_role, "launch_gate");
  assert.equal(record.prm_score_judge_model, "qwen3-32b");
});

// === AC3: the provider-judge path keeps its current behaviour ===========
//
// A client that HONOURS `opts.model` serves the override, so the record
// names the override — the behaviour t_dc053dc2 shipped.

test("served-model: a judge that honours opts.model still serves the override", async () => {
  const judge = buildHonouringClient("judge", { model: "MiniMax-M2" });
  const { record } = await run({ override: "qwen3-32b", role: "launch_gate", judge });

  assert.equal(servedModel(judge), "qwen3-32b", "the override must reach the generate call");
  assert.equal(record.prm_score_judge_model, "qwen3-32b");
  assert.equal(record.prm_score_independent, true);
  assert.equal(record.prm_score_role, "launch_gate");
});

test("served-model: with no override the served model is the client's own model", async () => {
  const judge = buildIgnoringJudgeClient("judge", { model: "qwen3-32b" });
  const { record } = await run({ role: "launch_gate", judge });

  assert.equal(record.prm_score_judge_model, "qwen3-32b");
  assert.equal(record.prm_score_independent, true);
});

// === the cache key must not be built from a model that will not serve ====
//
// The cache key is computed BEFORE the call, so it needs the PRE-CALL half
// of the contract. A key built from the override while the judge serves its
// own model would serve a score produced by one model under a key that
// names another.

test("served-model: the cache key uses the model the judge will actually serve", async () => {
  const keys = [];
  const judge = buildIgnoringJudgeClient("judge", { model: "MiniMax-M2" });
  const cache = {
    buildCacheKey: (inputs) => {
      keys.push(inputs.prm_model);
      return "k";
    },
    getCachedScore: async () => null,
    putCachedScore: async () => true,
  };

  const dir = await mkdtemp(join(tmpdir(), "ht-served-cache-"));
  const pairPath = join(dir, "pairs.jsonl");
  try {
    await heavy_think({
      problem: "Q?",
      K: 1,
      task_type: "standard",
      client: buildHonouringClient("producer", { model: CANDIDATE }),
      judgeClient: judge,
      prm: { model: "qwen3-32b" },
      preferencePairPath: pairPath,
      cache,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  assert.ok(keys.length > 0, "the cache key must have been built");
  for (const key of keys) {
    assert.equal(
      key,
      "MiniMax-M2",
      "the cache key must name the model the judge will serve, not the override"
    );
  }
});
