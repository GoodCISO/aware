// test/judge-override-guard.test.js
//
// The PER-CALL `prmConfig.model` override must not be able to make a judge
// GATE the DPO set when it names a model in the candidate's own family
// (kanban t_dc053dc2).
//
// WHY THIS FILE EXISTS
// --------------------
// `options.prm.model` is the documented per-call judge model override
// (`src/index.js`: "PRM judge config (model override, custom prompt)"). It
// travels into the generate options (`src/prm.js`: `genOpts.model =
// prmConfig.model`) and every AWARE client honours `opts.model` over its own
// default — so the override really does decide WHICH MODEL SERVED THE SCORE.
//
// The pair record's judge tags were computed from a DIFFERENT model:
//
//   src/index.js
//     const judgeModel = judgeClient
//       ? (prmConfig.model || judgeRoute.model || null)
//       : (judgeRoute.model || null);        // <-- the override is DROPPED
//
// In the no-`judgeClient` branch — which is AWARE's PRODUCTION default,
// because `judgeClient` is only built when `AWARE_JUDGE_MODEL` is set — the
// override changes the model that served the score while the record names the
// producer's model. Two consequences, both on the exact fields the trainer
// trusts (`src/trainer/judge-role.js` `mayJudgeGate()`):
//
//   1. `prm_score_judge_model` is a FALSE statement about which model
//      produced the score;
//   2. the independence verdict is computed against the WRONG model, so a
//      genuinely independent override (`qwen3-32b`) is NOT recognised as
//      independent — the override is silently useless for its stated purpose.
//
// t_2a91cc4b fixed the COMPARISON (family, not id) but not the BYPASS: the
// effective judge model was still resolved differently on each side of the
// call.
//
// THE RULE
// --------
//   "Same family -> the verdict is a DIAGNOSTIC, never a launch gate."
//   (04-ai-product-evaluation.md:240-243)
//
// THE DECISION (AC4 of t_dc053dc2)
// --------------------------------
// DEMOTE THE VERDICT, DO NOT REFUSE THE CALL. The override is honoured for
// SCORING — an operator may legitimately want a cheaper judge — and a
// same-family effective judge yields `role='diagnostic'`,
// `independent=false`, so it can never gate. Refusing the call would
// discard a score the operator asked for without making the verdict any
// safer, and 04's rule is about the verdict's AUTHORITY, not about whether
// the verdict may be computed.
//
// Every assertion below is NON-VACUOUS: each names the artefact the sweep
// WOULD remove (the override that silently changes the serving model), so
// the suite fails against the pre-fix implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { heavy_think } from "../src/index.js";
import { scoreWithPRM } from "../src/prm.js";

const CANDIDATE = "MiniMax-M3.1-Flash";

/**
 * A client that records the options of every call, so a test can assert
 * WHICH MODEL ACTUALLY SERVED THE SCORE — not merely what the record claims.
 */
function buildClient(name, { model, score = 8 } = {}) {
  const calls = [];
  return {
    name,
    model,
    calls,
    async generate(prompt, opts) {
      calls.push({ opts: { ...(opts || {}) } });
      if (opts?.phase === "prm_score") {
        return {
          reasoning: JSON.stringify({ score, strengths: [], weaknesses: [] }),
          cost_usd: 0,
        };
      }
      if (opts?.phase === "refine") {
        return { reasoning: "REFINED: better answer", cost_usd: 0 };
      }
      if (opts?.phase === "llm_judge") {
        return {
          reasoning: JSON.stringify({ verdict: "pass", confidence: 0.9, reason: "ok" }),
          cost_usd: 0,
        };
      }
      return { reasoning: `${name} attempt`, cost_usd: 0 };
    },
  };
}

/** The model that actually served the PRM score. */
function servedModel(client) {
  const call = client.calls.find((c) => c.opts?.phase === "prm_score");
  return call?.opts?.model || client.model;
}

/** Run heavy_think and return the written pair record plus the clients. */
async function run({ override, role, judgeModel } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ht-override-"));
  const pairPath = join(dir, "pairs.jsonl");
  const producer = buildClient("producer", { model: CANDIDATE });
  const judge = judgeModel ? buildClient("judge", { model: judgeModel }) : null;
  try {
    await heavy_think({
      problem: "Q?",
      K: 1,
      task_type: "standard",
      client: producer,
      judgeClient: judge,
      prm: {
        ...(override ? { model: override } : {}),
        ...(role ? { role } : {}),
      },
      preferencePairPath: pairPath,
    });
    const raw = (await readFile(pairPath, "utf8")).trim();
    return { record: JSON.parse(raw.split("\n")[0]), producer, judge };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// === AC1: a same-family sibling override may never gate =================

test("override-guard: a same-family SIBLING override yields diagnostic / independent=false", async () => {
  const { record } = await run({ override: "MiniMax-M3", role: "launch_gate" });
  assert.equal(record.prm_score_independent, false);
  assert.equal(record.prm_score_role, "diagnostic");
});

test("override-guard: the IDENTICAL model override yields diagnostic / independent=false (control)", async () => {
  const { record } = await run({ override: CANDIDATE, role: "launch_gate" });
  assert.equal(record.prm_score_independent, false);
  assert.equal(record.prm_score_role, "diagnostic");
});

// === AC3: a genuinely different family still gates =======================

test("override-guard: a DIFFERENT family override still yields launch_gate / independent=true", async () => {
  const { record } = await run({ override: "qwen3-32b", role: "launch_gate" });
  assert.equal(record.prm_score_independent, true);
  assert.equal(record.prm_score_role, "launch_gate");
});

test("override-guard: a different-family override still works WITH a judge client", async () => {
  const { record } = await run({ override: "qwen3-32b", role: "launch_gate", judgeModel: "qwen3-32b" });
  assert.equal(record.prm_score_independent, true);
  assert.equal(record.prm_score_role, "launch_gate");
});

// === the record must name the model that ACTUALLY served the score =======

test("override-guard: the record names the model that served the score, not the producer's", async () => {
  // THE defect: before the fix the record named the producer's model while
  // the override served a different one.
  const { record, producer } = await run({ override: "qwen3-32b" });
  assert.equal(servedModel(producer), "qwen3-32b", "the override must reach the generate call");
  assert.equal(
    record.prm_score_judge_model,
    "qwen3-32b",
    "the pair record must name the model that actually served the score",
  );
});

test("override-guard: a sibling override is named on the record as the model that served", async () => {
  const { record, producer } = await run({ override: "MiniMax-M3" });
  assert.equal(servedModel(producer), "MiniMax-M3");
  assert.equal(record.prm_score_judge_model, "MiniMax-M3");
});

// === the override must not RAISE authority above the family rule =========

test("override-guard: an override cannot raise a diagnostic to a gate", async () => {
  // No role requested: the verdict is a diagnostic. An override that names
  // another family must not be able to turn that into a gate either — the
  // role still has to be DECLARED.
  const { record } = await run({ override: "qwen3-32b" });
  assert.equal(record.prm_score_role, "diagnostic");
});

test("override-guard: the AWARE-trained LoRA artefact may never gate, whatever the override", async () => {
  const { record } = await run({ override: "aware-qwen35-9b", role: "launch_gate" });
  assert.equal(record.prm_score_independent, false);
  assert.equal(record.prm_score_role, "diagnostic");
});

// === the score's own judge_model must agree with the record =============

test("override-guard: scoreWithPRM reports the override as the judge model", async () => {
  const producer = buildClient("producer", { model: CANDIDATE });
  const out = await scoreWithPRM({
    problem: "Q?",
    reasoning: "reasoning",
    task_type: "standard",
    client: producer,
    prmConfig: { model: "qwen3-32b" },
  });
  assert.equal(out.judge_model, "qwen3-32b");
  assert.equal(servedModel(producer), "qwen3-32b");
});
