// test/judge-served-model-helpers.test.js
//
// The served-model contract's helpers, exercised directly (kanban
// t_49d955b7).
//
// The BEHAVIOURAL contract — "the record names the model that actually
// served" — is proved in `judge-served-model.test.js`, which loads against
// the pre-fix tree and fails on behaviour. This file covers the new API
// surface directly: the shape of the report, and the fallbacks that keep a
// silent client from breaking the call path.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readServedModel,
  resolveServedJudgeModel,
  resolveClientServedModel,
  SERVED_MODEL_KEY,
} from "../src/judge-client.js";

test("served-model: readServedModel ignores a missing or blank report", () => {
  assert.equal(readServedModel(null), null);
  assert.equal(readServedModel(undefined), null);
  assert.equal(readServedModel({}), null);
  assert.equal(readServedModel({ served_model: "" }), null);
  assert.equal(readServedModel({ served_model: "   " }), null);
  assert.equal(readServedModel({ served_model: 42 }), null);
  assert.equal(readServedModel({ served_model: "MiniMax-M2" }), "MiniMax-M2");
});

test("served-model: the served-model key is the documented one", () => {
  assert.equal(SERVED_MODEL_KEY, "served_model");
});

test("served-model: resolveServedJudgeModel prefers the first score that reports one", () => {
  assert.equal(
    resolveServedJudgeModel({
      scores: [{ served_model: "A" }, { served_model: "B" }],
      fallback: "F",
    }),
    "A"
  );
  assert.equal(
    resolveServedJudgeModel({ scores: [{}, { served_model: "B" }], fallback: "F" }),
    "B"
  );
  assert.equal(resolveServedJudgeModel({ scores: [{}], fallback: "F" }), "F");
  assert.equal(resolveServedJudgeModel({ scores: [], fallback: null }), null);
});

test("served-model: resolveClientServedModel falls back when the client is silent", () => {
  assert.equal(resolveClientServedModel({ client: null, fallback: "F" }), "F");
  assert.equal(resolveClientServedModel({ client: {}, fallback: "F" }), "F");
  // A client that throws must not break the call path.
  assert.equal(
    resolveClientServedModel({
      client: {
        resolveServedModel() {
          throw new Error("nope");
        },
      },
      fallback: "F",
    }),
    "F"
  );
  // A client that answers with a blank string falls back too.
  assert.equal(
    resolveClientServedModel({ client: { resolveServedModel: () => "  " }, fallback: "F" }),
    "F"
  );
  assert.equal(
    resolveClientServedModel({
      client: { resolveServedModel: () => "MiniMax-M2" },
      fallback: "F",
    }),
    "MiniMax-M2"
  );
});
