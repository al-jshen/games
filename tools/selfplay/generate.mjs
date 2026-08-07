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
import { openDataset } from './dataset.mjs';
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

const duration = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
};

console.log(`Generating ${GAMES} games at ${ITERATIONS} iterations on ${WORKERS} worker(s)…`);
const started = Date.now();

const writer = await openDataset(OUT, {
  seeds,
  featureSize: FEATURE_SIZE,
  policySize: POLICY_SIZE,
  featureLayout: FEATURE_LAYOUT,
  policyLayout: POLICY_LAYOUT,
  config,
  generatedAt: new Date().toISOString(),
});

let finished = 0;
let decided = 0;
let announced = 0;
/*
 * Games finish out of order -- a decisive one takes a third of a stalled one -- but the rows go down
 * in game order anyway, held back in `pending` until their turn. Purely so that a seed set produces
 * the same bytes every time: nothing downstream cares about the order, and reproducibility is worth
 * more than the handful of games this holds in memory.
 */
const pending = new Map();
let cursor = 0;
// One game's rows are ~340KB, so the interval is a reporting choice rather than a throughput one.
const step = Math.max(1, Math.round(GAMES / 100));

let writing = Promise.resolve();
let failure = null;

const drain = async () => {
  while (pending.has(cursor)) {
    const samples = pending.get(cursor);
    pending.delete(cursor);
    cursor += 1;
    await writer.append(samples);
  }
  if (finished - announced < step && finished < GAMES) return;
  announced = finished;
  const elapsed = (Date.now() - started) / 1000;
  const remaining = ((GAMES - finished) * elapsed) / finished;
  await writer.flush();
  console.log(
    `  ${finished}/${GAMES} games · ${writer.rows.toLocaleString()} rows · ` +
      `${(finished / elapsed).toFixed(2)} games/s · ${duration(elapsed)} elapsed · ${duration(remaining)} left`,
  );
};

await runJobs(jobs, WORKERS, (result, index) => {
  /*
   * Stop at the first failed write rather than at the end of the run. The writes are serialised
   * behind the pool, so a full disk an hour in would otherwise be discovered an hour later, having
   * spent the whole time generating games it had nowhere to put.
   */
  if (failure) throw failure;
  finished += 1;
  if (result.aWon !== null) decided += 1;
  pending.set(index, result.samples ?? []);
  // Serialised behind whatever is already writing; the pool carries on underneath.
  writing = writing.then(drain).catch((error) => {
    failure ??= error;
  });
});
await writing;
if (failure) throw failure;

const sidecar = await writer.close();
const seconds = (Date.now() - started) / 1000;

const megabytes = (sidecar.rows * (FEATURE_SIZE + POLICY_SIZE + 1) * 4) / 1e6;
console.log(`\n  ${sidecar.rows.toLocaleString()} positions from ${GAMES} games in ${duration(seconds)}`);
console.log(`  ${(sidecar.rows / GAMES).toFixed(0)} positions per game, ${decided}/${GAMES} decided`);
console.log(`  features ${FEATURE_SIZE}, policy ${POLICY_SIZE}, about ${megabytes.toFixed(0)}MB`);
console.log(`  written to ${OUT}/`);
