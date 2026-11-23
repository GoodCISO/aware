#!/usr/bin/env node
// nullband.mjs — measure the eval harness's null band.
//
// The paper (arXiv:2611.14068 §9) says: "Run two or more null draws, the
// same policy on the same seeds, before reading any arm ... and judge each
// comparison by its own paired interval, using the null draws to check the
// noise that interval assumes."
//
// This script drives the REAL harness against the REAL Ollama sidecar, N
// times, with the same model and the same fixtures, and reports the spread
// of the published mean accuracy.
//
// Two modes:
//
//   --mode=unseeded  reproduces the PRE-CHANGE harness request body exactly
//                     ({ model, prompt, stream: false } — no seed, no
//                     options). This is the "today" band.
//
//   --mode=seeded    uses the CHANGED harness (makeOllamaGenerator with an
//                     explicit seed and temperature). This is the "after"
//                     band.
//
// Every number below comes from an actual harness run. Nothing is invented.
//
// Usage:
//   node nullband.mjs --mode=unseeded --runs=5 --model=qwen3.5:9b --out=band.json
//   node nullband.mjs --mode=seeded   --runs=5 --seed=20261123 --temperature=0
//   node nullband.mjs --mode=seeded --harness=/path/to/eval-harness.js ...

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
        else out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function sd(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * The PRE-CHANGE request body, byte-for-byte what
 * src/training/eval-harness.js:381 sent before this card:
 *   { model, prompt, stream: false }
 * No seed, no options. This is the "today" generator.
 */
function makeLegacyGenerator({ ollamaUrl, modelName, timeoutMs }) {
  return async (prompt) => {
    const url = `${ollamaUrl.replace(/\/+$/, '')}/api/generate`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelName, prompt, stream: false }),
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || 'unseeded');
  const runs = Number(args.runs || 5);
  const modelName = String(args.model || 'qwen3.5:9b');
  const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const timeoutMs = Number(process.env.AWARE_EVAL_TIMEOUT_MS || 60_000);
  const outPath = String(args.out || path.join(__dirname, `nullband-${mode}.json`));
  // The harness this script measures. Defaults to the repo's own
  // copy; `--harness` lets a caller point it at a pre-change tree to
  // measure the OLD behaviour against the same model.
  const harnessPath = String(
    args.harness ||
    path.resolve(__dirname, '..', 'src', 'training', 'eval-harness.js')
  );

  const { makeOllamaGenerator, runEvalSuite } = await import(harnessPath);

  // Seeded mode: fixed seed + temperature (the only combination this Ollama
  // build actually honours — see the artefact note).
  const seed = mode === 'seeded' ? Number(args.seed ?? 20261123) : undefined;
  const temperature = mode === 'seeded' ? Number(args.temperature ?? 0) : undefined;

  const draws = [];
  for (let i = 0; i < runs; i++) {
    const label = `${mode}-draw${i + 1}`;
    const t0 = Date.now();
    const generate = mode === 'seeded'
      ? makeOllamaGenerator({ ollamaUrl, modelName, timeoutMs, seed, temperature })
      : makeLegacyGenerator({ ollamaUrl, modelName, timeoutMs });
    const result = await runEvalSuite({ generate, modelName, label });
    const allProblems = [
      ...result.gsm8k.perProblem,
      ...result.livecodebench.perProblem,
    ];
    draws.push({
      label,
      accuracy: result.accuracy,
      gsm8k: result.gsm8k.accuracy,
      livecodebench: result.livecodebench.accuracy,
      elapsed_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
      // Per-problem scores, so a paired comparison can be done draw-vs-draw.
      perProblemScores: allProblems.map((p) => ({
        id: p.id,
        score: p.score,
        error: /^error:/.test(p.detail) ? p.detail : null,
      })),
      timedOutProblems: allProblems.filter((p) => /^error:/.test(p.detail)).map((p) => p.id),
    });
    console.error(
      `[${label}] mean=${result.accuracy} gsm8k=${result.gsm8k.accuracy} ` +
      `lcb=${result.livecodebench.accuracy} (${((Date.now() - t0) / 1000).toFixed(0)}s)` +
      (draws[i].timedOutProblems.length ? ` timeouts=${draws[i].timedOutProblems.join(',')}` : '')
    );
  }

  const accs = draws.map((d) => d.accuracy);
  const band = {
    mode,
    model: modelName,
    runs,
    seed: seed ?? null,
    temperature: temperature ?? null,
    timeoutMs,
    harnessPath,
    measuredAt: new Date().toISOString(),
    accuracies: accs,
    mean: mean(accs),
    sd: sd(accs),
    min: Math.min(...accs),
    max: Math.max(...accs),
    range: Math.max(...accs) - Math.min(...accs),
    // Per-benchmark spread, so we can tell WHICH axis carries the noise.
    gsm8k: { accuracies: draws.map((d) => d.gsm8k), sd: sd(draws.map((d) => d.gsm8k)) },
    livecodebench: {
      accuracies: draws.map((d) => d.livecodebench),
      sd: sd(draws.map((d) => d.livecodebench)),
    },
    draws,
  };
  fs.writeFileSync(outPath, JSON.stringify(band, null, 2));
  console.error(`\nmode=${mode} runs=${runs} seed=${band.seed} temp=${band.temperature}`);
  console.error(`accuracies: ${accs.map((a) => (a * 100).toFixed(1) + 'pp').join(', ')}`);
  console.error(`mean=${(band.mean * 100).toFixed(1)}pp sd=${(band.sd * 100).toFixed(1)}pp range=${(band.range * 100).toFixed(1)}pp`);
  console.error(`wrote ${outPath}`);
}

main().catch((e) => { console.error('FATAL:', e?.stack || e); process.exit(1); });
