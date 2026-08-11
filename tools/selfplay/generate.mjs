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
 *
 * One generation can be split across machines with `--num-shards` and `--shard-id`; see those flags
 * below. Each shard writes its own directory and the trainer takes all of them at once:
 *
 *   python3 tools/selfplay/train_value.py .data/gen0/shard*
 */

import { DEFAULT_CONFIG } from '@games/bot-ismcts';
import { FEATURE_LAYOUT, FEATURE_SIZE, POLICY_LAYOUT, POLICY_SIZE } from '@games/splendor-duel';
import { openDataset } from './dataset.mjs';
import { defaultWorkers, runJobs } from './pool.mjs';
import { requireFreshBuild } from './fresh.mjs';

requireFreshBuild();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const GAMES = Number(flag('games', '50'));
const ITERATIONS = Number(flag('iterations', '300'));
const WORKERS = Number(flag('workers', String(defaultWorkers())));
const OUT = flag('out', '.data/gen0');
/*
 * Splitting one generation across several machines. `--games` stays the size of the *whole*
 * generation and each process plays the slice of it that belongs to its shard, in the manner of
 * `world_size` and `rank`:
 *
 *   node generate.mjs --games 25000 --num-shards 10 --shard-id 3 --out .../gen0/shard3
 *
 * Each shard writes its own directory and the trainer reads them all at once -- `load_window`
 * already takes N datasets and offsets their game ids so no two collide, which is the same
 * machinery a window over generations uses.
 *
 * The split is contiguous rather than round-robin, and that is not arbitrary: seats alternate with
 * the game index, so a strided split with an even shard count would hand one shard nothing but
 * even indices and it would play every game with the same seat moving first.
 */
const NUM_SHARDS = Number(flag('num-shards', '1'));
const SHARD_ID = Number(flag('shard-id', '0'));

if (!Number.isInteger(NUM_SHARDS) || NUM_SHARDS < 1) {
  throw new Error(`--num-shards must be a positive integer, got ${NUM_SHARDS}`);
}
if (!Number.isInteger(SHARD_ID) || SHARD_ID < 0 || SHARD_ID >= NUM_SHARDS) {
  throw new Error(`--shard-id must be in [0, ${NUM_SHARDS}), got ${SHARD_ID}`);
}

/*
 * Floor of both ends rather than a per-shard size, so the remainder spreads one game at a time over
 * the leading shards and the slices tile [0, GAMES) exactly -- no gap, no overlap, no last shard
 * left holding the remainder on its own.
 */
const FIRST = Math.floor((SHARD_ID * GAMES) / NUM_SHARDS);
const MINE = Math.floor(((SHARD_ID + 1) * GAMES) / NUM_SHARDS) - FIRST;
/*
 * The value network to put at the leaf, which is what makes this a *loop* rather than one dataset.
 * Generation zero had no network and searched with `0.5*heuristic + 0.5*rollout`; every generation
 * after it searches with the network the previous one trained, so the data improves as the network
 * does. Measured on gen-0's network: +230 elo at equal iterations and 4.1x the iterations per
 * second, since one forward pass replaces a forty-ply playout.
 *
 * It also breaks a circularity. `q` was the search's own estimate, and the search evaluated leaves
 * with the heuristic, so `q` correlated +0.92 with it and a network fitted to `q` partly distilled
 * the heuristic. With the network at the leaf, `q` derives from a network fitted to real outcomes,
 * and the heuristic's influence decays with each generation rather than being re-injected.
 */
const NET = flag('net', null);
/*
 * Sampling the played move in proportion to visit counts, for the opening only.
 *
 * Without it a deal is played out one way and one way only, so a generation explores just the lines
 * the current network already likes and the next one learns from a narrower slice of the game.
 * AlphaZero samples for the first thirty moves at T=1 and plays greedily after.
 *
 * The window is shorter here for two reasons. Their thirty counts plies of a ~90-ply game, while
 * this counter counts one player's own decisions -- so thirty of ours would be two thirds of the
 * game rather than a third. And their initial position is *identical* every game, which is the
 * pressure temperature exists to relieve; ours is a fresh random deal each time, so a good deal of
 * the diversity is already there. Fifteen is about the same fraction of the game as theirs.
 *
 * It is not free. A sampled move is sometimes a worse move, and `z` is the outcome of the game that
 * actually got played -- so exploration adds noise to the label the value head is already starved
 * of. AlphaZero could absorb that across 44 million games. Worth watching at 25,000.
 *
 * **Off by default, on measurement.** Sampling in proportion to visits only means anything if the
 * visits mean something, and in the opening they do not. Measured at 300 iterations from a position
 * with 48 legal moves: the most-visited move had 16 visits, 5.3%, and the distribution's effective
 * support was 45.9 moves -- indistinguishable from uniform. UCB1 spends the first 48 iterations
 * force-visiting every child and the remaining 252 spread five apiece, which separates nothing. So
 * T=1 over the opening would not diversify the data, it would play the opening at random.
 *
 * The same position at 1232 iterations concentrates properly -- 28.2% on the favourite, effective
 * support 27.3 -- and mid-game positions with six legal moves concentrate at 300. So this becomes
 * worth switching on with a deeper search, or once PUCT stops the budget being spread uniformly
 * across every legal move. It is a real lever; it is just not calibrated for the search we have.
 */
const TEMPERATURE = Number(flag('temperature', '0'));
const TEMPERATURE_MOVES = Number(flag('temperature-moves', '15'));
const explore = TEMPERATURE > 0 ? { temperature: TEMPERATURE, moves: TEMPERATURE_MOVES } : null;

const config = { ...DEFAULT_CONFIG, iterations: ITERATIONS, ...(NET ? { leaf: 'evaluate' } : {}) };
const seeds = Array.from({ length: MINE }, (_, i) => `gen-${FIRST + i}`);

/*
 * Two indices, and the distinction is the whole of the sharding.
 *
 * `index` is the game's identity in the generation as a whole. Everything that decides *what is
 * played* hangs off it -- the deal, both searches, which seat moves first -- so game 7 is the same
 * game whether it was produced by one process or by ten, and the union of the shards is exactly the
 * run that one machine would have produced.
 *
 * `game` is the position within this shard's own output, and it is what `gameIndex` stamps into
 * `meta`. That column is an index into this dataset's `seeds` array, which holds only the seeds
 * this shard played, so it has to be local or `seed_for(row)` would point at the wrong game.
 */
const jobs = seeds.map((seed, game) => {
  const index = FIRST + game;
  return {
    seed,
    game: index,
    gameIndex: game,
    record: true,
    // Both seats searched, so every position is a training row rather than half of them.
    aFirst: index % 2 === 0,
    a: { kind: 'ismcts', config: { ...config, seed: `a${index}` }, net: NET, explore },
    b: { kind: 'ismcts', config: { ...config, seed: `b${index}` }, net: NET, explore },
  };
});

const duration = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
};

console.log(
  `Generating ${MINE} games at ${ITERATIONS} iterations on ${WORKERS} worker(s), ` +
    `${NUM_SHARDS > 1 ? `shard ${SHARD_ID} of ${NUM_SHARDS} (games ${FIRST}..${FIRST + MINE - 1} of ${GAMES}), ` : ''}` +
    `leaf=${config.leaf}${NET ? ` net=${NET}` : ''}` +
    `${explore ? `, sampling at T=${TEMPERATURE} for ${TEMPERATURE_MOVES} moves` : ', greedy'}…`,
);
const started = Date.now();

const writer = await openDataset(OUT, {
  seeds,
  featureSize: FEATURE_SIZE,
  policySize: POLICY_SIZE,
  featureLayout: FEATURE_LAYOUT,
  policyLayout: POLICY_LAYOUT,
  // `net` beside `config` because it is part of what produced these rows. A dataset that does not
  // record which network searched it cannot be placed in the sequence of generations later.
  config: { ...config, net: NET, explore, shard: { id: SHARD_ID, of: NUM_SHARDS, first: FIRST, games: MINE, total: GAMES } },
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
const step = Math.max(1, Math.round(MINE / 100));

let writing = Promise.resolve();
let failure = null;

const drain = async () => {
  while (pending.has(cursor)) {
    const samples = pending.get(cursor);
    pending.delete(cursor);
    cursor += 1;
    await writer.append(samples);
  }
  if (finished - announced < step && finished < MINE) return;
  announced = finished;
  const elapsed = (Date.now() - started) / 1000;
  const remaining = ((MINE - finished) * elapsed) / finished;
  await writer.flush();
  console.log(
    `  ${finished}/${MINE} games · ${writer.rows.toLocaleString()} rows · ` +
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
console.log(`\n  ${sidecar.rows.toLocaleString()} positions from ${MINE} games in ${duration(seconds)}`);
console.log(`  ${(sidecar.rows / MINE).toFixed(0)} positions per game, ${decided}/${MINE} decided`);
console.log(`  features ${FEATURE_SIZE}, policy ${POLICY_SIZE}, about ${megabytes.toFixed(0)}MB`);
console.log(`  written to ${OUT}/`);
