#!/usr/bin/env node
/**
 * Generate a training dataset from self-play.
 *
 * Separate from the A/B harness on purpose: that one exists to answer questions about the search,
 * this one exists to produce data. Mixing them would mean every dataset carried whichever
 * experimental toggles happened to be under test.
 *
 *   node tools/selfplay/generate.mjs --games 200 --iterations 300 --out .data/gen0
 *
 * Generation zero should come from the current ISMCTS bot rather than from a randomly initialised
 * network. Random self-play in this game is not merely weak, it wanders into the positions the
 * official rules never terminate from -- so bootstrapping is faster *and* avoids the failure mode.
 */

import { DEFAULT_CONFIG } from '@games/bot-ismcts';
import { FEATURE_LAYOUT, FEATURE_SIZE, POLICY_LAYOUT, POLICY_SIZE } from '@games/splendor-duel';
import { writeDataset } from './dataset.mjs';
import { defaultWorkers, runJobs } from './pool.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const GAMES = Number(flag('games', '50'));
const ITERATIONS = Number(flag('iterations', '300'));
const WORKERS = Number(flag('workers', String(defaultWorkers())));
const OUT = flag('out', '.data/gen0');

const config = { ...DEFAULT_CONFIG, iterations: ITERATIONS };
const seeds = Array.from({ length: GAMES }, (_, i) => `gen-${i}`);

const jobs = seeds.map((seed, game) => ({
  seed,
  game,
  gameIndex: game,
  record: true,
  // Both seats searched, so every position is a training row rather than half of them.
  aFirst: game % 2 === 0,
  a: { kind: 'ismcts', config: { ...config, seed: `a${game}` } },
  b: { kind: 'ismcts', config: { ...config, seed: `b${game}` } },
}));

console.log(`Generating ${GAMES} games at ${ITERATIONS} iterations on ${WORKERS} worker(s)…`);
const started = Date.now();
const results = await runJobs(jobs, WORKERS);
const seconds = (Date.now() - started) / 1000;

const samples = results.flatMap((r) => r.samples ?? []);
const decided = results.filter((r) => r.aWon !== null).length;

const sidecar = await writeDataset(OUT, {
  samples,
  seeds,
  featureSize: FEATURE_SIZE,
  policySize: POLICY_SIZE,
  featureLayout: FEATURE_LAYOUT,
  policyLayout: POLICY_LAYOUT,
  config,
  generatedAt: new Date().toISOString(),
});

const megabytes = (samples.length * (FEATURE_SIZE + POLICY_SIZE + 1) * 4) / 1e6;
console.log(`\n  ${sidecar.rows.toLocaleString()} positions from ${GAMES} games in ${seconds.toFixed(0)}s`);
console.log(`  ${(samples.length / GAMES).toFixed(0)} positions per game, ${decided}/${GAMES} decided`);
console.log(`  features ${FEATURE_SIZE}, policy ${POLICY_SIZE}, about ${megabytes.toFixed(0)}MB`);
console.log(`  written to ${OUT}/`);
