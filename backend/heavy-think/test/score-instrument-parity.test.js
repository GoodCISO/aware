// test/score-instrument-parity.test.js
//
// Regression test for kanban t_99423c45.
//
// The defect: `chosen.prm_score` was a LENGTH HEURISTIC (or the provider's
// self-reported confidence) while `rejected.prm_score` was a real PRM-judge
// score. The trainer's `min_score_gap` gate subtracted the two, the
// heuristic ceiling (0.75) sat below the judge's usual range (0.8-1.0),
// and the gate's directionality check dropped BETTER-refined pairs as
// "PRM-inverted".
//
// These tests assert the two halves of the contract:
//   1. The refined trace is scored by the SAME instrument that scored the
//      initial attempts (the PRM judge), not by a heuristic.
//   2. The heuristic can never reach a field the DPO gate treats as a
//      judge score.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { heavy_think } from "../src/index.js";
import { refine } from "../src/refine.js";

// A client whose PRM judge scores the REFINED trace higher than the
// initial attempts — i.e. the refined answer really is better. This is the
// case the old code dropped as "inverted" because the chosen side carried
// the 0.75 heuristic ceiling while the rejected side carried the judge 0.9.
function buildClient({ refinedJudgeScore = 10, initialJudgeScore = 8 } = {}) {
  return {
    model: "mock-1",
    async generate(prompt, opts) {
      if (opts?.phase === "prm_score") {
        // Distinguish the refined trace from the initial attempts: the
        // refined one contains the refinement marker.
        // The PRM prompt may be a string or a { system, user } object
        // (MR-HIGH-002 message shape) — normalise before matching.
        const isRefined = JSON.stringify(prompt).includes("REFINED");
        const score = isRefined ? refinedJudgeScore : initialJudgeScore;
        return {
          reasoning: JSON.stringify({ score, strengths: ["ok"], weaknesses: [] }),
          cost_usd: 0,
        };
      }
      if (opts?.phase === "refine") {
        // NOTE: no `confidence` field — the provider does not report one,
        // which is exactly what makes the old heuristic fallback fire.
        return { reasoning: "REFINED: better answer", cost_usd: 0 };
      }
      return { reasoning: "raw attempt", cost_usd: 0 };
    },
  };
}

test("score-instrument: the refined trace is scored by the PRM judge, not a heuristic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ht-instrument-"));
  const pairPath = join(dir, "pairs.jsonl");
  try {
    const client = buildClient({ refinedJudgeScore: 10, initialJudgeScore: 8 });
    await heavy_think({
      problem: "Q?",
      K: 1,
      task_type: "standard",
      client,
      preferencePairPath: pairPath,
    });

    const rec = JSON.parse((await readFile(pairPath, "utf8")).trim().split("\n")[0]);

    // Both sides must be judge-sourced.
    assert.equal(rec.chosen.prm_score_source, "prm_judge");
    assert.equal(rec.rejected.prm_score_source, "prm_judge");

    // The chosen side must carry the JUDGE's score for the refined trace
    // (10/10 -> 1.0), NOT the heuristic bucket (0.75).
    assert.equal(rec.chosen.prm_score, 1.0);
    assert.notEqual(rec.chosen.prm_score, 0.75);

    // The rejected side keeps its judge score.
    assert.equal(rec.rejected.prm_score, 0.8);

    // The gap is now POSITIVE — a better-refined pair survives the gate.
    assert.ok(
      rec.chosen.prm_score - rec.rejected.prm_score > 0,
      `expected a positive gap, got ${rec.chosen.prm_score - rec.rejected.prm_score}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("score-instrument: the heuristic never reaches a prm_score field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ht-instrument-"));
  const pairPath = join(dir, "pairs.jsonl");
  try {
    // The provider reports NO confidence, so the legacy length heuristic
    // would fire if it were still reachable from prm_score.
    const client = buildClient({ refinedJudgeScore: 6, initialJudgeScore: 8 });
    await heavy_think({
      problem: "Q?",
      K: 1,
      task_type: "standard",
      client,
      preferencePairPath: pairPath,
    });

    const rec = JSON.parse((await readFile(pairPath, "utf8")).trim().split("\n")[0]);

    // chosen.prm_score is the JUDGE's 0.6, not a heuristic bucket.
    assert.equal(rec.chosen.prm_score, 0.6);
    for (const bucket of [0.4, 0.5, 0.6, 0.75]) {
      // 0.6 is a legitimate judge score too, so assert on the SOURCE tag
      // rather than the value alone.
      assert.equal(rec.chosen.prm_score_source, "prm_judge");
      assert.notEqual(bucket, undefined);
    }

    // The heuristic IS still available — under a name that cannot be
    // mistaken for a judge score.
    assert.equal(typeof rec.chosen.refinement_confidence, "number");
    assert.equal(rec.chosen.refinement_confidence, 0.75);  // legacy heuristic bucket
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("score-instrument: refine() no longer exposes a refined_score field", async () => {
  const client = {
    model: "mock-1",
    async generate() {
      return { reasoning: "REFINED: text", cost_usd: 0 };
    },
  };
  const out = await refine({
    problem: "Q?",
    best_attempt: "original",
    task_type: "standard",
    client,
  });
  assert.equal(out.refined_score, undefined);
  assert.equal(typeof out.refinement_confidence, "number");
  assert.equal(typeof out.confidence, "number");
});

test("score-instrument: a failed judge call yields a null score, not a fake one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ht-instrument-"));
  const pairPath = join(dir, "pairs.jsonl");
  try {
    const client = {
      model: "mock-1",
      async generate(prompt, opts) {
        if (opts?.phase === "prm_score") {
          // Fail only for the refined trace.
          if (JSON.stringify(prompt).includes("REFINED")) {
            throw new Error("judge unavailable");
          }
          return {
            reasoning: JSON.stringify({ score: 8, strengths: [], weaknesses: [] }),
            cost_usd: 0,
          };
        }
        if (opts?.phase === "refine") {
          return { reasoning: "REFINED: better answer", cost_usd: 0 };
        }
        return { reasoning: "raw attempt", cost_usd: 0 };
      },
    };
    await heavy_think({
      problem: "Q?",
      K: 1,
      task_type: "standard",
      client,
      preferencePairPath: pairPath,
    });

    const rec = JSON.parse((await readFile(pairPath, "utf8")).trim().split("\n")[0]);
    // A missing score is honest; a fake score corrupts the training set.
    assert.equal(rec.chosen.prm_score, null);
    assert.equal(rec.chosen.prm_score_source, "unavailable");
    // The rejected side is still scored — the pair is not silently half-written.
    assert.equal(rec.rejected.prm_score, 0.8);
    assert.equal(rec.rejected.prm_score_source, "prm_judge");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
