#!/usr/bin/env node
/**
 * Self-play for the ISMCTS bot, and the measurements that say whether any of it is working.
 *
 * Runs entirely in process against the same reducer the server runs -- no sockets, no database.
 * Games are distributed across worker threads, which is close to free: the engine is pure, nothing
 * is shared, and a game is a few hundred kilobytes of state that never leaves its own thread.
 *
 * Every extra in the search is a switch, and each one is here to be measured rather than believed.
 * The A/B mode plays each against the same configuration with it turned off.
 *
 *   node tools/selfplay/selfplay.mjs                        # the standard battery
 *   node tools/selfplay/selfplay.mjs --games 40             # more games per matchup
 *   node tools/selfplay/selfplay.mjs --only ab              # just the toggle comparison
 *   node tools/selfplay/selfplay.mjs --only ab --filter crn # one comparison
 *   node tools/selfplay/selfplay.mjs --workers 1            # serial, for profiling
 */

import { BASELINE, DEFAULT_CONFIG } from '@games/bot-ismcts';
import { defaultWorkers, runJobs } from './pool.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const GAMES = Number(flag('games', '20'));
const ITERATIONS = Number(flag('iterations', '300'));
const ONLY = flag('only', 'all');
/** Substring filter for the A/B list, so one comparison can be re-run on its own. */
const FILTER = flag('filter', '');
const WORKERS = Number(flag('workers', String(defaultWorkers())));
/** Measured speedup of the fast rollout sampler, used to make the equal-time comparison fair. */
const FAST_SPEEDUP = Number(flag('fast-speedup', '1.8'));

const ismcts = (overrides = {}) => (seed) => ({
  kind: 'ismcts',
  config: { ...DEFAULT_CONFIG, iterations: ITERATIONS, ...overrides, seed },
});
const baseline = (overrides = {}) => (seed) => ({
  kind: 'ismcts',
  config: { ...BASELINE, iterations: ITERATIONS, ...overrides, seed },
});
const random = () => (seed) => ({ kind: 'random', seed });

async function matchup(label, makeA, makeB, games = GAMES) {
  const jobs = Array.from({ length: games }, (_, game) => ({
    seed: `sp-${game}`,
    aFirst: game % 2 === 0,
    a: makeA(`a${game}`),
    b: makeB(`b${game}`),
  }));

  const started = Date.now();
  const results = await runJobs(jobs, WORKERS);
  const seconds = (Date.now() - started) / 1000;

  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let totalMoves = 0;
  const collected = { disagreement: [], noiseFloor: [], valueSpan: [] };
  for (const r of results) {
    totalMoves += r.moves;
    if (r.aWon === null) draws += 1;
    else if (r.aWon) winsA += 1;
    else winsB += 1;
    collected.disagreement.push(...r.collected.disagreement);
    collected.noiseFloor.push(...r.collected.noiseFloor);
    collected.valueSpan.push(...r.collected.valueSpan);
  }

  const decided = winsA + winsB;
  const rate = decided === 0 ? 0.5 : winsA / decided;
  console.log(
    `  ${label.padEnd(38)} ${String(winsA).padStart(3)}-${String(winsB).padEnd(3)}` +
      `${draws > 0 ? ` (${draws} drawn)` : '        '}  ${(rate * 100).toFixed(0)}%  ` +
      `${(totalMoves / games).toFixed(0)} moves/game  ${seconds.toFixed(1)}s`,
  );
  return { rate, winsA, winsB, draws, collected };
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);


console.log(
  `ISMCTS self-play — ${GAMES} games per matchup, ${ITERATIONS} iterations per move, ${WORKERS} worker(s)`,
);
// Worth stating, because the eye reads 10-6 as a result. At 16 games only a rout is significant:
// 14-2 is about p=0.004, 12-4 about p=0.08, and 10-6 is indistinguishable from a coin.
console.log(`At ${GAMES} games, roughly ${Math.ceil(GAMES * 0.78)}-${Math.floor(GAMES * 0.22)} is the`);
console.log('threshold for significance; anything closer than that is not evidence of much.\n');

if (ONLY === 'all' || ONLY === 'sanity') {
  console.log('1. Is it playing at all?');
  await matchup('ismcts vs random', ismcts(), random());
  console.log();
}

if (ONLY === 'all' || ONLY === 'budget') {
  console.log('2. Does more search make it stronger?');
  // If this is flat, the bottleneck is the evaluation, not the search -- which is the signal that a
  // learned value would start to be worth the trouble.
  await matchup(`${ITERATIONS * 4} iterations vs ${ITERATIONS}`, ismcts({ iterations: ITERATIONS * 4 }), ismcts());
  console.log();
}

if (ONLY === 'all' || ONLY === 'ab') {
  console.log('3. Is each extra earning its place? (each vs the same config with it off)');
  const comparisons = [
    ['common random numbers (pool 32)', { commonRandomNumbers: true, worldPool: 32 }, { commonRandomNumbers: false }],
    // The same idea with a pool comfortably larger than the iteration count, so no world is reused.
    // If the small pool was the problem, this should look very different.
    ['common random numbers (pool 4x iters)', { commonRandomNumbers: true, worldPool: ITERATIONS * 4 }, { commonRandomNumbers: false }],
    ['heuristic shrinkage 0.5', { leaf: 'mixed', shrinkage: 0.5 }, { leaf: 'rollout', shrinkage: 0 }],
    ['heuristic only (no rollout)', { leaf: 'heuristic' }, { leaf: 'rollout' }],
    ['biased rollouts', { biasedRollout: true }, { biasedRollout: false }],
    ['fast rollout sampler', { fastRollout: true }, { fastRollout: false }],
    /*
     * The comparison that actually decides it: nobody runs a search for a fixed number of
     * simulations, they run it for a fixed number of seconds. The sampler is faster, so at equal
     * time it gets proportionally more iterations.
     *
     * The multiplier has to track the *measured* speedup or the comparison is rigged. It was 2.6x
     * before the sampler was taught to scan for affordable cards; that scan costs, and it is 1.8x
     * now. Re-measure it if the sampler changes again.
     */
    [
      'fast sampler, equal time',
      { fastRollout: true, iterations: Math.round(ITERATIONS * FAST_SPEEDUP) },
      { fastRollout: false },
    ],
    ['value rescaling', { normaliseValues: true }, { normaliseValues: false }],
  ];
  for (const [label, on, off] of comparisons) {
    if (FILTER && !label.includes(FILTER)) continue;
    await matchup(label, ismcts(on), ismcts(off));
  }
  console.log();

  console.log('4. Against the plain baseline, everything off');
  await matchup('tuned vs baseline', ismcts(), baseline());
  console.log();
}

if (ONLY === 'all' || ONLY === 'diagnostics') {
  console.log('5. Diagnostics');
  const { collected } = await matchup(
    'mirror match (score is meaningless)',
    ismcts({ measureDisagreement: true }),
    ismcts({ measureDisagreement: true }),
    Math.max(4, Math.round(GAMES / 4)),
  );
  const disagreement = mean(collected.disagreement);
  const noise = mean(collected.noiseFloor);
  const excess = disagreement - noise;
  const span = mean(collected.valueSpan);
  console.log();
  console.log(`  disagreement across worlds  ${(disagreement * 100).toFixed(1)}%`);
  console.log(`  same world, different seed  ${(noise * 100).toFixed(1)}%   <- noise floor`);
  console.log(`  excess attributable to the hidden state  ${(excess * 100).toFixed(1)}%`);
  console.log(
    excess < 0.1
      ? '    -> the worlds barely matter; nearly all the flipping is search noise, so strategy fusion has little room here'
      : '    -> the hidden state really does change the best move; fusion is worth taking seriously',
  );
  console.log(`  leaf value spread    ${span.toFixed(3)} of a possible 2.0`);
  console.log(
    span < 0.3
      ? '    -> narrow: exploration will dominate the value term, so value rescaling should be earning its place'
      : '    -> wide enough that UCB is comparing values rather than noise',
  );
}
