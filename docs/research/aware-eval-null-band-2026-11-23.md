# AWARE eval harness — null band and disclosure discipline

**Date:** 2026-11-23
**Card:** `t_44535590`
**Source:** arXiv:2611.14068 *"What a CAGE 4 Score Measures: An Audit of a Learned Cyber-Defense Benchmark, Its Reference Defenders, and the Tables Built on Them"* (Rice, Park, Kwasinski; RIT; v1 2026-11-10) — §9, "Recommendations and a disclosure checklist".
**Artefact:** <https://github.com/jrice-ai/cage> (tag `arxiv-v1`, MIT) · Data: <https://doi.org/10.5281/zenodo.23681828> (CC-BY-4.0)

---

## 1. The defect, as measured on this host

The AWARE 2.0 eval harness (`src/training/eval-harness.js`) sent its Ollama request as:

```json
{ "model": "<tag>", "prompt": "<prompt>", "stream": false }
```

No `seed`. No `options`. No `temperature`. The published result object was:

```json
{ "accuracy": …, "gsm8k": …, "livecodebench": …, "modelName": …, "label": …, "startedAt": …, "finishedAt": … }
```

No seed, no dispersion, no model digest, no code revision. Every published number was a **single unlabelled draw** from an unseeded policy.

### 1.1 The gate was inside the noise

`scripts/eval-delta.sh` gated on `trained.mean >= baseline.mean + 0.03` — a **3 percentage-point** threshold, from ADR (internal) Phase 4 D5.

The measured null band (below) is **20 percentage points wide**. The gate was **6.7× narrower than the noise it was meant to detect**.

The paper's §9 instruction is the standard this card adopts:

> *"Run two or more null draws, the same policy on the same seeds, before reading any arm, report every control as a draw with its null center rather than as a point, and judge each comparison by its own paired interval, using the null draws to check the noise that interval assumes."*

---

## 2. Measured null band

**Method.** N = 5 draws of the **same model** (`qwen3.5:9b`, digest `6488c96fa5faab64bb65`, 6 594 474 711 bytes) on the **same fixtures** (in-repo `GSM8K_FIXTURES` + `LIVECODE_FIXTURES`, 5 + 5 problems), against the live Ollama sidecar on `127.0.0.1:11434` (Ollama **0.40.11**), per-problem timeout 60 000 ms.

Two regimes, because the request body itself is the variable under test:

| regime | request body | n | accuracies | center (mean) | sd | range | 95% t CI |
|---|---|---|---|---|---|---|---|
| **unseeded** (pre-change) | `{model, prompt, stream:false}` | 5 | 50.0, 60.0, 50.0, 50.0, 40.0 pp | **50.0 pp** | **7.1 pp** | **20.0 pp** | [32.5 pp, 67.5 pp] |
| **seeded** (post-change) | `{model, prompt, stream:false, seed:20261123, options:{temperature:0}}` | 5 | *see §2.2* | *see §2.2* | *see §2.2* | *see §2.2* | *see §2.2* |

### 2.1 The unseeded band decomposes into two independent sources

| draw | mean | gsm8k | lcb | `gsm8k-005` | `lcb-002` |
|---|---|---|---|---|---|
| 1 | 50.0 pp | 60.0 pp | 40.0 pp | **timeout** | pass |
| 2 | 60.0 pp | 80.0 pp | 40.0 pp | pass | pass |
| 3 | 50.0 pp | 60.0 pp | 40.0 pp | **timeout** | pass |
| 4 | 50.0 pp | 60.0 pp | 40.0 pp | **timeout** | pass |
| 5 | 40.0 pp | 60.0 pp | 20.0 pp | **timeout** | **fail** |

Two separable causes, and they need different fixes:

1. **Sampling variance.** `lcb-002` (`is_even`) passes in draws 1–4 and fails in draw 5. Same model, same fixtures, same prompt — the model simply wrote different code. This is the defect the paper names: *the evaluation seeds the environment but not the policy, so "one command run twice on the same seeds returns different scores."*
2. **Infrastructure variance.** `gsm8k-005` (the "James writes a 3-page letter" problem) **timed out at 60 s in 4 of 5 draws**. A timeout is scored 0, so a slow-but-correct answer is indistinguishable from a wrong answer. This variance is NOT the paper's subject, and no seeding removes it.

The second cause is why the disclosure block counts timeouts explicitly under axis 5 (Counting): a reader can now see how many of the fixture's points were decided by a timeout rather than by the criterion.

### 2.2 The seeded band: the sampling variance is GONE

| regime | n | accuracies | center (mean) | sd | range | 95% t CI |
|---|---|---|---|---|---|---|
| **unseeded** (pre-change) | 5 | 50.0, 60.0, 50.0, 50.0, 40.0 pp | 50.0 pp | 7.1 pp | **20.0 pp** | [32.5 pp, 67.5 pp] |
| **seeded** (post-change, seed=20261123, T=0) | 5 | 50.0, 50.0, 50.0, 50.0, 50.0 pp | 50.0 pp | **0.0 pp** | **0.0 pp** | [50.0 pp, 50.0 pp] |

**Every per-problem score is identical across all 5 seeded draws.** The sampling variance the paper describes — "one command run twice on the same seeds returns different scores" — is eliminated by the seed plus temperature 0.

The band does not go to zero in general, and this measurement says why: **`gsm8k-005` timed out in 5 of 5 seeded draws** as well as 4 of 5 unseeded draws. That is a **60-second per-problem timeout**, not a sampling effect, and no amount of seeding removes it. A timeout is scored 0, so a slow-but-correct answer is scored identically to a wrong one.

This is the reason the disclosure block counts timeouts under axis 5 (Counting): a reader of a published number can now see how many of its points were decided by the clock rather than by the criterion.

**Both facts matter for the threshold.** The seeded band's range is 0.0 pp *on this fixture set*, but that zero is a property of the seed + the greedy decode, not a guarantee for a different model, a different fixture set, or a stochastic temperature. `eval-delta.sh` therefore derives its threshold from **whichever band it is given** — it measures the band at comparison time and does not hard-code today's zero.

---

## 3. The finding about `seed` itself: this Ollama build IGNORES it above temperature 0

This is a measured result, not a literature claim, and it changes what "seed the policy" can mean on this host.

**Method.** Identical prompt, identical model, `seed` held constant, `temperature` varied; response bodies compared by md5.

| temperature | seed | response md5 | identical? |
|---|---|---|---|
| 0.0 | 42 | `00bf8ce8383b` | ✅ |
| 0.0 | 42 | `00bf8ce8383b` | ✅ |
| 0.0 | 43 | `00bf8ce8383b` | ✅ (temp 0 overrides the seed) |
| 0.8 | 42 | `2d8347970124` | ❌ |
| 0.8 | 42 | `46f91dd4f8de` | ❌ **same seed, different output** |
| 0.8 | 43 | `f1e1ba0ed917` | ❌ |

**Ollama 0.40.11 does not honour the `seed` field at temperature > 0.** At temperature 0 the response is byte-identical across requests, and the seed becomes irrelevant (greedy decoding has nothing to sample).

**Consequence for the design.** A harness that sent `seed` with a stochastic temperature would *look* reproducible — it would publish a seed that the runtime ignores, which is **worse** than publishing no seed, because a reader would believe the number was reproducible when it was not. This is exactly the paper's Tier-B failure mode reproduced in a second form.

Therefore the harness:

- sends **both** `seed` and `options.temperature`;
- defaults `temperature` to **0.0**, the only mode this runtime honours;
- publishes the **sampling mode** (`greedy (temperature=0)` vs `stochastic`) alongside the seed, so a reader can see which guarantee they are getting;
- refuses a non-integer seed and a negative temperature at construction time.

---

## 3a. Criterion 1 verification: two consecutive runs agree

**Command** (identical both times, only the label differs):

```bash
node scripts/run-eval-baseline.mjs --label=criterion1-a --model=qwen3.5:9b \
  --seed=20261123 --temperature=0
node scripts/run-eval-baseline.mjs --label=criterion1-b --model=qwen3.5:9b \
  --seed=20261123 --temperature=0
```

**Result of the field-by-field diff** (excluding the wall-clock fields `startedAt`, `finishedAt`, `elapsedMs`, and the operator-set `label`):

| field | run A | run B | equal |
|---|---|---|---|
| `accuracy` | 0.5 | 0.5 | ✅ |
| `gsm8k.correct` | 3 | 3 | ✅ |
| `livecodebench.correct` | 2 | 2 | ✅ |
| `disclosure.artefact.modelDigest` | `6488c96f…eda893ea7` | `6488c96f…eda893ea7` | ✅ |
| `disclosure.artefact.harnessRevision` | `9f9904c270b3…` | `9f9904c270b3…` | ✅ |
| `disclosure.sampling.seed` / `.temperature` | `20261123` / `0` | `20261123` / `0` | ✅ |
| every `perProblem[].score` | — | — | ✅ (all 10 identical) |
| every `perProblem[].detail` | — | — | ✅ (all 10 identical) |

**Zero differing fields.** The only differences between the two result objects are the timestamps and the per-problem elapsed milliseconds — i.e. the wall clock, not the result.

---

## 4. Before / after
| | **before** | **after** |
|---|---|---|
| Request body | `{model, prompt, stream:false}` | `{model, prompt, stream:false, seed, options:{temperature}}` |
| Seed | none | fixed, published (`20261123`) |
| Temperature | none (runtime default) | fixed, published (`0`) |
| Sampling mode | unstated | published (`greedy` / `stochastic`) |
| Model identity | tag only (`qwen3.5:9b`) | **digest** `6488c96fa5faab64bb65` + size + modified-at |
| Code revision | none | harness git revision + branch + dirty flag |
| Dispersion | none | n, per-draw scores, sd, range, 95% t CI, and **what the spread is over** |
| Null band | none | measured, committed (§2, §5) |
| Gate threshold | hard-coded `0.03` | **derived** from the measured band, floored by the historical 3 pp |
| Gate verdict | point comparison | **paired** draw-by-draw, problem-by-problem, with a 95% t interval that must exclude zero |
| Single-draw comparison | silently compared | reported **INDETERMINATE** (exit 1) — a point is not a comparison |
| Disclosure axes | 0 of 5 | **5 of 5** (including the "none" ones) |
| Timeouts | invisible | counted and published under axis 5 |

**The threshold story, in one line:** *today* the gate is **3 pp** against a measured **20 pp** swing; *after* the change the gate is **derived from the measured band** (20 pp for the unseeded control, 0 pp for a seeded deterministic control, and the historical 3 pp as a floor) **and** additionally requires a paired interval that excludes zero — which, at the current fixture size, the harness reports as not resolvable (see §6).

---

## 5. Reproducing the band

```bash
# unseeded (the pre-change request body) — 5 draws, ~13 minutes
node nullband.mjs --mode=unseeded --runs=5 --model=qwen3.5:9b \
  --out=nullband-unseeded.json

# seeded (the post-change request body)
node nullband.mjs --mode=seeded --runs=5 --seed=20261123 --temperature=0 \
  --model=qwen3.5:9b --out=nullband-seeded.json
```

`nullband.mjs` lives at `scripts/nullband.mjs` in the repo. It drives the **real** harness against the **real** sidecar — every number in this document came from an actual run.

Raw draw-by-draw data: `docs/research/aware-eval-null-band-2026-11-23.json`.

---

## 6. The fixture-count limitation — stated explicitly

The current fixture set is **5 GSM8K + 5 LiveCodeBench = 10 problems**. The paper's own numbers put a one-seed mean over 100 episodes at a standard error of ~6.3 pp. At n = 10 the standard error is larger still, and the measured band proves it empirically.

**Consequence.** With a 10-problem fixture, a **20 pp** effect is roughly **one problem**. The harness cannot resolve an effect of the size the ADR (internal) D5 target asks for, at any threshold, because the resolution floor of the fixture is coarser than the target.

`eval-delta.sh` reports this rather than hiding it: when the verdict is FAIL and the paired sd is non-zero, it prints the **fixture count required** to resolve the threshold effect at 95% confidence:

```
Fixture count required to resolve a 20.0pp effect at 95% confidence with this
observed paired sd (…): ~N paired problems (the current fixture set has M).
```

**What this means in practice.** Until the fixture set grows, this harness can say *"the trained model is better"* only when the improvement is large relative to 10 problems (roughly ≥ 3 problems' worth of movement on both benchmarks). It can no longer say it from a 3 pp point difference — and that is the correct outcome, because at this fixture size a 3 pp difference carries no information.

---

## 7. The five disclosures, mapped onto this harness

| Paper axis (§9) | Where it lives in the result object |
|---|---|
| 1. **Artefact** — checkpoint hash and size, code revision | `disclosure.artefact.{modelDigest, modelSize, modelModifiedAt, harnessRevision, harnessBranch, harnessDirty}` |
| 2. **Sampling and spread** — sampling mode, seeds, episode count, what the spread is over | `disclosure.sampling.{seed, temperature, samplingMode, n, drawId, draws, spreadOver, dispersion.{sd, ci95, intervalKind, min, max, range}}` |
| 3. **Criterion and scenario** — what was scored, by what rule, on which scenario, and against what truth | `disclosure.criterion.{gsm8k, livecodebench}.{rule, truth, fixtureCount, fixtureSet}` |
| 4. **Adversary** — which red agent, as a scope limit | `disclosure.adversary.{present: false, redAgent: "none", scopeLimit}` — stated as "none", **not omitted** |
| 5. **Counting** — asserted or executed, and from what record | `disclosure.counting.{unit: "asserted output", detail, timeouts}` |

The paper's rule for axis 4 is the reason the axis is present with a `none` value: *"A table that omits one cannot, whatever its sd."* An omitted axis is indistinguishable from an axis nobody thought about.

---

## 8. Scope

This card lands the discipline on **one** surface — the AWARE 2.0 eval harness — and publishes its null band so the other **978** evaluation surfaces in the estate have a template and a threshold derivation to copy. It does **not** touch those other surfaces.
