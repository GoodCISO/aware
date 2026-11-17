// test/judge-client.test.js
//
// The judge must be INDEPENDENT of the candidate it grades, and a judge
// that is configured but unavailable must FAIL CLOSED — never fall back to
// the candidate's model (kanban t_89720a07, audit t_8f049433).
//
// Before this, one client served producer and judge, so the judge graded
// its own house style; the documented `options.prm.model` override did not
// exist, and the only alternative backend was the AWARE-trained LoRA
// artefact — the very model the preference pairs train.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { heavy_think } from "../src/index.js";
import { scoreWithPRM } from "../src/prm.js";
import { verify } from "../src/verify.js";
import { resolveJudgeClient, callJudge, JUDGE_UNAVAILABLE_CODE } from "../src/judge-client.js";

// A client that records which client was called and how.
function buildClient(name, { model, score = 8, fail = false } = {}) {
  const calls = [];
  return {
    name,
    model,
    calls,
    async generate(prompt, opts) {
      calls.push({ prompt, opts });
      if (fail) throw new Error(`${name} is down`);
      if (opts && opts.phase === "prm_score") {
        return {
          reasoning: JSON.stringify({ score, strengths: [], weaknesses: [] }),
          cost_usd: 0,
        };
      }
      if (opts && opts.phase === "refine") {
        return { reasoning: "REFINED: better answer", cost_usd: 0 };
      }
      if (opts && opts.phase === "llm_judge") {
        return {
          reasoning: JSON.stringify({ verdict: "pass", confidence: 0.9, reason: "ok" }),
          cost_usd: 0,
        };
      }
      return { reasoning: `${name} attempt`, cost_usd: 0 };
    },
  };
}

// === resolveJudgeClient ===

test("judge-client: with no judge client the producer's client is the judge, and that is recorded", () => {
  const producer = buildClient("producer", { model: "MiniMax-M3.1-Flash" });
  const r = resolveJudgeClient({ client: producer });
  assert.equal(r.configured, false);
  assert.equal(r.client, producer);
  assert.equal(r.source, "producer_fallback");
  assert.equal(r.model, "MiniMax-M3.1-Flash");
});

test("judge-client: a configured judge client wins over the producer's client", () => {
  const producer = buildClient("producer", { model: "MiniMax-M3.1-Flash" });
  const judge = buildClient("judge", { model: "gpt-5-judge" });
  const r = resolveJudgeClient({ client: producer, judgeClient: judge });
  assert.equal(r.configured, true);
  assert.equal(r.client, judge);
  assert.equal(r.source, "judge");
  assert.equal(r.model, "gpt-5-judge");
});

// === callJudge: the fail-closed chokepoint ===

test("judge-client: an unavailable CONFIGURED judge fails closed with a tagged error", async () => {
  await assert.rejects(
    () => callJudge(async () => { throw new Error("judge 503"); }, { configured: true, model: "gpt-5-judge" }),
    (err) => {
      assert.equal(err.code, JUDGE_UNAVAILABLE_CODE);
      assert.match(err.message, /judge client unavailable \(gpt-5-judge\)/);
      return true;
    },
  );
});

test("judge-client: an unconfigured judge rethrows the original error unchanged", async () => {
  await assert.rejects(
    () => callJudge(async () => { throw new Error("producer 503"); }, { configured: false }),
    (err) => {
      assert.equal(err.code, undefined);
      assert.equal(err.message, "producer 503");
      return true;
    },
  );
});

// === scoreWithPRM: which client serves the judge ===

test("prm: the judge call goes to the judge client, not the producer's client", async () => {
  const producer = buildClient("producer", { model: "MiniMax-M3.1-Flash", score: 2 });
  const judge = buildClient("judge", { model: "gpt-5-judge", score: 9 });
  const out = await scoreWithPRM({
    problem: "Q?",
    reasoning: "reasoning",
    task_type: "standard",
    client: producer,
    judgeClient: judge,
  });
  assert.equal(out.score, 0.9, "the score must come from the JUDGE client");
  assert.equal(judge.calls.length, 1);
  assert.equal(producer.calls.length, 0, "the producer's client must not be called as judge");
  assert.equal(out.judge_source, "judge");
  assert.equal(out.judge_model, "gpt-5-judge");
});

test("prm: with no judge client the producer's client is the judge, and the record says so", async () => {
  const producer = buildClient("producer", { model: "MiniMax-M3.1-Flash", score: 7 });
  const out = await scoreWithPRM({
    problem: "Q?",
    reasoning: "reasoning",
    task_type: "standard",
    client: producer,
  });
  assert.equal(out.score, 0.7);
  assert.equal(out.judge_source, "producer_fallback");
  assert.equal(out.judge_model, "MiniMax-M3.1-Flash");
});

test("prm: prmConfig.model is honoured — the documented judge model override works", async () => {
  const producer = buildClient("producer", { model: "MiniMax-M3.1-Flash" });
  const out = await scoreWithPRM({
    problem: "Q?",
    reasoning: "reasoning",
    task_type: "standard",
    client: producer,
    prmConfig: { model: "gpt-5-judge" },
  });
  assert.equal(producer.calls.length, 1);
  assert.equal(
    producer.calls[0].opts.model,
    "gpt-5-judge",
    "the documented `options.prm` model override must reach the generate call",
  );
  assert.equal(out.judge_model, "gpt-5-judge");
});

test("prm: a configured but unavailable judge does NOT fall back to the producer's client", async () => {
  const producer = buildClient("producer", { model: "MiniMax-M3.1-Flash", score: 5 });
  const judge = buildClient("judge", { model: "gpt-5-judge", fail: true });
  await assert.rejects(
    () => scoreWithPRM({
      problem: "Q?",
      reasoning: "reasoning",
      task_type: "standard",
      client: producer,
      judgeClient: judge,
    }),
    (err) => {
      assert.equal(err.code, JUDGE_UNAVAILABLE_CODE);
      return true;
    },
  );
  assert.equal(producer.calls.length, 0, "the producer's client must NOT be used as a fallback judge");
});

// === verify: the llm-judge must use the judge client ===

test("verify: the llm-judge verdict comes from the judge client", async () => {
  const producer = buildClient("producer", { model: "MiniMax-M3.1-Flash" });
  const judge = buildClient("judge", { model: "gpt-5-judge" });
  const out = await verify({
    trace: "the answer",
    verification: { method: "llm-judge" },
    client: producer,
    judgeClient: judge,
    problem: "the task",
  });
  assert.equal(out.passed, true);
  assert.equal(out.details.model, "gpt-5-judge");
  assert.equal(out.details.judge_client_source, "judge");
  assert.equal(judge.calls.length, 1);
  assert.equal(producer.calls.length, 0);
});

test("verify: an unavailable configured judge fails closed and never uses the producer's client", async () => {
  const producer = buildClient("producer", { model: "MiniMax-M3.1-Flash" });
  const judge = buildClient("judge", { model: "gpt-5-judge", fail: true });
  const out = await verify({
    trace: "the answer",
    verification: { method: "llm-judge" },
    client: producer,
    judgeClient: judge,
    problem: "the task",
  });
  assert.equal(out.passed, false, "a broken judge must fail closed");
  assert.match(out.details.error, /judge call failed/);
  assert.equal(out.details.judge_client_source, "judge");
  assert.equal(producer.calls.length, 0, "the producer's client must NOT be used as a fallback judge");
});

// === heavy_think: the end-to-end wiring ===

test("heavy_think: the producer produces, the judge scores, and the pair records which", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ht-judge-"));
  const pairPath = join(dir, "pairs.jsonl");
  try {
    const producer = buildClient("producer", { model: "MiniMax-M3.1-Flash", score: 2 });
    const judge = buildClient("judge", { model: "gpt-5-judge", score: 9 });
    await heavy_think({
      problem: "Q?",
      K: 2,
      task_type: "standard",
      client: producer,
      judgeClient: judge,
      preferencePairPath: pairPath,
    });

    const rec = JSON.parse((await readFile(pairPath, "utf8")).trim().split("\n")[0]);
    // The judge's score is the one on the record.
    assert.equal(rec.rejected.prm_score, 0.9);
    assert.equal(rec.prm_score_judge_model, "gpt-5-judge");
    assert.equal(rec.prm_score_judge_client_source, "judge");
    // The producer produced the attempts; it never judged.
    assert.ok(producer.calls.some((c) => c.opts.phase !== "prm_score"));
    assert.equal(producer.calls.filter((c) => c.opts.phase === "prm_score").length, 0);
    assert.ok(judge.calls.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("heavy_think: with no judge client the pair records the producer fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ht-judge-"));
  const pairPath = join(dir, "pairs.jsonl");
  try {
    const producer = buildClient("producer", { model: "MiniMax-M3.1-Flash", score: 8 });
    await heavy_think({
      problem: "Q?",
      K: 1,
      task_type: "standard",
      client: producer,
      preferencePairPath: pairPath,
    });
    const rec = JSON.parse((await readFile(pairPath, "utf8")).trim().split("\n")[0]);
    assert.equal(rec.prm_score_judge_client_source, "producer_fallback");
    assert.equal(rec.prm_score_judge_model, "MiniMax-M3.1-Flash");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("heavy_think: a configured but unavailable judge fails the pair closed, it does not fall back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ht-judge-"));
  const pairPath = join(dir, "pairs.jsonl");
  try {
    const producer = buildClient("producer", { model: "MiniMax-M3.1-Flash", score: 8 });
    const judge = buildClient("judge", { model: "gpt-5-judge", fail: true });
    await heavy_think({
      problem: "Q?",
      K: 1,
      task_type: "standard",
      client: producer,
      judgeClient: judge,
      preferencePairPath: pairPath,
    });
    const rec = JSON.parse((await readFile(pairPath, "utf8")).trim().split("\n")[0]);
    // The score is LOST, not faked and not taken from the producer.
    assert.equal(rec.rejected.prm_score, null);
    assert.equal(rec.rejected.prm_score_source, "unavailable");
    // The producer never acted as the judge.
    assert.equal(producer.calls.filter((c) => c.opts.phase === "prm_score").length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
