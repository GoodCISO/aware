#!/usr/bin/env node
// scripts/run-eval-baseline.mjs — Phase 4 deliverable 4 (the AWARE 2.0 Architecture ADR (internal) 618-627)
//
// CLI driver for the eval harness. Default mode is the P baseline
// (bare trained-model, no fine-tuning). Operators can override the
// model name (e.g. the trained `trained-model`) to compare
// against the trained checkpoint.
//
// Disclosure discipline (arXiv:2611.14068 §9)
// -----------------------------------------
// Every run publishes its seed, its temperature, the number of draws
// it is one of, the model's DIGEST (not just its tag), and the
// harness's own git revision. A single draw is reported AS a draw,
// not as a point: run `--draws>=2` to get a null band.
//
// Usage:
//   node scripts/run-eval-baseline.mjs                                  # baseline
//   node scripts/run-eval-baseline.mjs --label=trained \
//        --model=trained-model                                    # trained
//   node scripts/run-eval-baseline.mjs --fixtures=./my-fixtures --label=trained-v2
//   node scripts/run-eval-baseline.mjs --label=null-draw --draws=5      # null band
//   node scripts/run-eval-baseline.mjs --label=null-draw --draws=5 --seed=7 --temperature=0.8
//
// Env vars (all optional):
//   OLLAMA_URL              default: http://127.0.0.1:11434
//   AWARE_EVAL_TIMEOUT_MS   default: 60_000 (per problem)
//   AWARE_EVAL_OUTPUT_DIR   default: ./eval-results (created if missing)
//   AWARE_EVAL_SEED         default: 20261123 (the policy sampling seed)
//   AWARE_EVAL_TEMPERATURE  default: 0 (greedy; the only mode this
//                           Ollama build honours reproducibly)
//   AWARE_EVAL_DRAWS        default: 1 (number of null draws per run)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeOllamaGenerator,
  fetchModelIdentity,
  readGitRevision,
  runEvalSuite,
  formatResult,
  summariseDraws,
  GSM8K_FIXTURES,
  LIVECODE_FIXTURES,
  DEFAULT_EVAL_SEED,
  DEFAULT_EVAL_TEMPERATURE,
} from '../src/training/eval-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tiny argv parser (no dependency, handles --flag=value + --flag value)
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = true;
        }
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const timeoutMs = Number(process.env.AWARE_EVAL_TIMEOUT_MS || 60_000);
  const outputDir = process.env.AWARE_EVAL_OUTPUT_DIR || path.join(process.cwd(), 'eval-results');
  const modelName = String(args.model || process.env.AWARE_EVAL_MODEL || 'qwen2.5:7b');
  const label = String(args.label || process.env.AWARE_EVAL_LABEL || 'baseline');
  const fixturesDir = args.fixtures ? path.resolve(String(args.fixtures)) : null;

  // -- Disclosure inputs -------------------------------------------------
  // The seed and temperature that go into the request. Both default to
  // the harness's own defaults so that an operator who says nothing
  // still gets a reproducible run.
  const seed = Number(args.seed ?? process.env.AWARE_EVAL_SEED ?? DEFAULT_EVAL_SEED);
  const temperature = Number(
    args.temperature ?? process.env.AWARE_EVAL_TEMPERATURE ?? DEFAULT_EVAL_TEMPERATURE
  );
  if (!Number.isInteger(seed)) {
    console.error(`ERROR: --seed must be an integer, got ${args.seed}`);
    process.exit(2);
  }
  if (!Number.isFinite(temperature) || temperature < 0) {
    console.error(`ERROR: --temperature must be a non-negative number, got ${args.temperature}`);
    process.exit(2);
  }
  // The number of null draws. 1 = a single draw (no dispersion). >=2
  // = a null band, which is what the paper's checklist requires
  // before any arm is read.
  const draws = Number(args.draws ?? process.env.AWARE_EVAL_DRAWS ?? 1);
  if (!Number.isInteger(draws) || draws < 1) {
    console.error(`ERROR: --draws must be a positive integer, got ${args.draws}`);
    process.exit(2);
  }

  // Optional: load custom fixtures from a directory.
  // Each file is JSON with shape { id, prompt, finalAnswer?, functionName?, testCases? }
  // Filename is informational; id from the JSON is the canonical key.
  let overrides = {};
  if (fixturesDir) {
    const { readdir, readFile } = await import('node:fs/promises');
    const files = (await readdir(fixturesDir)).filter((f) => f.endsWith('.json'));
    const gsm = [];
    const lcb = [];
    for (const f of files) {
      const full = path.join(fixturesDir, f);
      const data = JSON.parse(await readFile(full, 'utf8'));
      if (typeof data.functionName === 'string' && Array.isArray(data.testCases)) {
        lcb.push(data);
      } else if (typeof data.finalAnswer === 'number') {
        gsm.push(data);
      }
    }
    overrides = { gsm8k: gsm, livecodebench: lcb };
    console.log(`Loaded custom fixtures: ${gsm.length} gsm8k, ${lcb.length} livecodebench from ${fixturesDir}`);
  } else {
    console.log(`Using in-repo fixtures: ${GSM8K_FIXTURES.length} gsm8k + ${LIVECODE_FIXTURES.length} livecodebench`);
  }

  console.log(`AWARE 2.0 eval driver`);
  console.log(`  ollamaUrl:  ${ollamaUrl}`);
  console.log(`  model:      ${modelName}`);
  console.log(`  label:      ${label}`);
  console.log(`  timeout:    ${timeoutMs}ms per problem`);
  console.log(`  seed:       ${seed}`);
  console.log(`  temperature:${temperature}`);
  console.log(`  draws:      ${draws}`);
  console.log('');

  const generate = makeOllamaGenerator({
    ollamaUrl, modelName, timeoutMs, seed, temperature,
  });

  // Artefact identity: the model's DIGEST (a tag is a name, a digest
  // is an identity) and the harness's own code revision.
  const modelIdentity = await fetchModelIdentity({ ollamaUrl, modelName });
  const gitRevision = readGitRevision({ cwd: path.resolve(__dirname, '..') });
  console.log(`  model digest: ${modelIdentity.digest || 'UNAVAILABLE'}` +
    (modelIdentity.error ? ` (${modelIdentity.error})` : ''));
  console.log(`  harness rev:  ${gitRevision.revision || 'UNAVAILABLE'}` +
    (gitRevision.error ? ` (${gitRevision.error})` : ''));
  console.log('');

  // Connectivity probe — fail fast with a clear error if Ollama
  // isn't reachable. We send a tiny /api/generate and check the
  // response is parseable.
  try {
    const probe = await generate('Reply with just the word OK.');
    if (!probe || typeof probe !== 'string') {
      throw new Error(`Ollama returned empty response: ${JSON.stringify(probe)}`);
    }
    console.log(`  connectivity: ok (probe response: ${JSON.stringify(probe.slice(0, 30))})`);
  } catch (e) {
    console.error(`ERROR: cannot reach Ollama at ${ollamaUrl}: ${e?.message || e}`);
    console.error(`Is Ollama running? Try: docker compose -p aware-2 up -d ollama`);
    process.exit(2);
  }
  console.log('');

  // Run the draws. Each draw is an independent run of the same model
  // on the same fixtures — the paper's "null draws".
  const results = [];
  for (let i = 0; i < draws; i++) {
    const drawLabel = draws === 1 ? label : `${label}-draw${i + 1}`;
    const result = await runEvalSuite({
      generate,
      overrides,
      modelName,
      label: drawLabel,
      seed,
      temperature,
      n: draws,
      drawId: draws === 1 ? null : i + 1,
      modelIdentity,
      gitRevision,
    });
    results.push(result);
    if (draws === 1) {
      const text = formatResult(result);
      process.stdout.write(text);
    } else {
      console.log(
        `  draw ${i + 1}/${draws}: mean=${result.accuracy} ` +
        `gsm8k=${result.gsm8k.accuracy} lcb=${result.livecodebench.accuracy}`
      );
    }
  }

  // The null band: the draws summarised as a distribution, not as a
  // point. This is the number a future comparison's threshold must be
  // measured against.
  const accuracies = results.map((r) => r.accuracy);
  const band = draws > 1 ? summariseDraws(accuracies) : null;
  if (band) {
    const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}pp` : 'n/a');
    console.log('');
    console.log(`  Null band over ${band.n} draws of the SAME model on the SAME fixtures:`);
    console.log(`    accuracies: ${band.values.map((a) => pct(a)).join(', ')}`);
    console.log(`    null center (mean): ${pct(band.mean)}`);
    console.log(`    sd:                   ${pct(band.sd)}`);
    console.log(`    range:                ${pct(band.range)}`);
    if (band.ci95) {
      console.log(`    95% CI:               [${pct(band.ci95.low)}, ${pct(band.ci95.high)}] (${band.intervalKind})`);
    }
  }

  // Print + persist. With >1 draw we write ONE band file plus the
  // per-draw files, so a comparison can pair draw-by-draw.
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (draws === 1) {
    const result = results[0];
    const jsonPath = path.join(outputDir, `${stamp}-${label}.json`);
    const txtPath = path.join(outputDir, `${stamp}-${label}.txt`);
    await writeFile(jsonPath, JSON.stringify(result, null, 2));
    await writeFile(txtPath, formatResult(result));
    console.log(`Wrote: ${jsonPath}`);
    console.log(`Wrote: ${txtPath}`);
    return;
  }

  const bandPath = path.join(outputDir, `${stamp}-${label}-band.json`);
  const bandDoc = {
    label,
    modelName,
    modelIdentity,
    gitRevision,
    seed,
    temperature,
    n: draws,
    accuracies,
    band,
    // Per-draw per-problem scores, so eval-delta.sh can pair the two
    // arms problem-by-problem rather than comparing two point scores.
    draws: results.map((r, i) => ({
      drawId: i + 1,
      label: r.label,
      accuracy: r.accuracy,
      gsm8k: r.gsm8k.accuracy,
      livecodebench: r.livecodebench.accuracy,
      perProblem: [
        ...r.gsm8k.perProblem.map((p) => ({ id: p.id, score: p.score, detail: p.detail })),
        ...r.livecodebench.perProblem.map((p) => ({ id: p.id, score: p.score, detail: p.detail })),
      ],
    })),
  };
  await writeFile(bandPath, JSON.stringify(bandDoc, null, 2));
  console.log(`Wrote: ${bandPath}`);

  for (const r of results) {
    const jsonPath = path.join(outputDir, `${stamp}-${r.label}.json`);
    await writeFile(jsonPath, JSON.stringify(r, null, 2));
    console.log(`Wrote: ${jsonPath}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e?.stack || e);
  process.exit(1);
});
