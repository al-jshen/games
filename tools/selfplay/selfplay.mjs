#!/usr/bin/env node
/**
 * Self-play for the ISMCTS bot, and the measurements that say whether any of it is working.
 *
 * Runs entirely in process against the same reducer the server runs — no sockets, no database — which
 * is the only reason this is affordable: the rules alone do about 90,000 moves/sec, so the search is
 * the whole cost.
 *
 * Every extra in the search is a switch, and each one is here to be measured rather than believed:
 * common random numbers, heuristic shrinkage, biased rollouts, value rescaling. The A/B mode plays
 * each of them against the baseline that has it turned off.
 *
 *   node tools/selfplay/selfplay.mjs                 # the standard battery
 *   node tools/selfplay/selfplay.mjs --games 40      # more games per matchup
 *   node tools/selfplay/selfplay.mjs --only ab       # just the toggle comparison
 */

import { RandomCursor } from '@games/engine';
import { search, measureDisagreement, BASELINE, DEFAULT_CONFIG } from '@games/bot-ismcts';
import splendorDuel, { determinize, evaluate, redactFor, rolloutPreference } from '@games/splendor-duel';

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

/** Self-play must terminate. The official rules do not guarantee it, so the house rule goes on. */
const OPTIONS = { maxTurnsWithoutPurchase: 60 };

const deps = {
  mod: splendorDuel,
  determinize,
  evaluate: (state, seat) => evaluate(state, seat),
  rolloutPolicy: (state, seat, actions, rng) => {
    // Mostly buy; otherwise anything. Keeps rollouts from being pure noise without making them a
    // fixed strategy the tree can overfit to.
    const buys = rolloutPreference(actions);
    if (buys.length > 0 && rng.int(4) > 0) return buys[rng.int(buys.length)];
    return rng.int(actions.length);
  },
};

/** A player: given the true state and a seat, choose an action. Only ever shown the redacted view. */
function ismctsPlayer(config) {
  let move = 0;
  const stats = { disagreement: [], noiseFloor: [], valueSpan: [] };
  return {
    stats,
    choose(state, seat) {
      const view = JSON.parse(JSON.stringify(redactFor(seat, state)));
      const result = search(deps, view, seat, { ...config, seed: `${config.seed}:${move++}` });
      stats.valueSpan.push(result.valueRange.max - result.valueRange.min);
      // Expensive -- a separate search per world -- so only sampled occasionally.
      if (config.measureDisagreement && move % 12 === 0) {
        const spread = measureDisagreement(deps, view, seat, { ...config, iterations: 120 }, 8);
        stats.disagreement.push(spread.acrossWorlds);
        stats.noiseFloor.push(spread.sameWorld);
      }
      return result.action;
    },
  };
}

function randomPlayer(seed) {
  const rng = new RandomCursor(seed, 0);
  return {
    stats: null,
    choose(state, seat) {
      const { actions } = splendorDuel.legalActions(state, seat);
      return actions[rng.int(actions.length)];
    },
  };
}

/** One game. Returns the winning seat, or null for a draw / stall. */
function playGame(players, seed) {
  let state = splendorDuel.setup({ seed, seats: [0, 1], options: OPTIONS });
  let moves = 0;
  for (; moves < 4000; moves++) {
    const outcome = splendorDuel.outcome(state);
    if (outcome.status === 'over') {
      return { winner: outcome.winners[0] ?? null, moves };
    }
    const seat = splendorDuel.currentActors(state)[0];
    if (seat === undefined) break;
    const action = players[seat].choose(state, seat);
    const result = splendorDuel.apply(state, seat, action);
    if (!result.ok) throw new Error(`self-play: ${result.error.code} ${result.error.message}`);
    state = result.state;
  }
  return { winner: null, moves };
}

/**
 * Play a matchup, swapping seats every game.
 *
 * Splendor Duel's first player has an advantage, so a matchup that did not alternate would mostly
 * measure who got seat zero.
 */
function matchup(label, makeA, makeB, games = GAMES) {
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let totalMoves = 0;
  const started = Date.now();
  const collected = { disagreement: [], noiseFloor: [], valueSpan: [] };

  for (let game = 0; game < games; game++) {
    const aFirst = game % 2 === 0;
    const a = makeA(`a${game}`);
    const b = makeB(`b${game}`);
    const players = aFirst ? [a, b] : [b, a];
    const { winner, moves } = playGame(players, `sp-${game}`);
    totalMoves += moves;
    for (const p of [a, b]) {
      if (!p.stats) continue;
      collected.disagreement.push(...p.stats.disagreement);
      collected.noiseFloor.push(...p.stats.noiseFloor);
      collected.valueSpan.push(...p.stats.valueSpan);
    }
    if (winner === null) draws += 1;
    else if ((winner === 0) === aFirst) winsA += 1;
    else winsB += 1;
  }

  const decided = winsA + winsB;
  const rate = decided === 0 ? 0.5 : winsA / decided;
  const seconds = (Date.now() - started) / 1000;
  console.log(
    `  ${label.padEnd(38)} ${String(winsA).padStart(3)}-${String(winsB).padEnd(3)}` +
      `${draws > 0 ? ` (${draws} drawn)` : '        '}  ${(rate * 100).toFixed(0)}%  ` +
      `${(totalMoves / games).toFixed(0)} moves/game  ${seconds.toFixed(1)}s`,
  );
  return { rate, winsA, winsB, draws, collected };
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

const ismcts = (overrides) => (seed) => ismctsPlayer({ ...DEFAULT_CONFIG, iterations: ITERATIONS, ...overrides, seed });

console.log(`ISMCTS self-play — ${GAMES} games per matchup, ${ITERATIONS} iterations per move`);
// Worth stating, because the eye reads 10-6 as a result. At 16 games only a rout is significant:
// 14-2 is about p=0.004, 12-4 about p=0.08, and 10-6 is indistinguishable from a coin.
console.log(`At ${GAMES} games, roughly ${Math.ceil(GAMES * 0.78)}-${Math.floor(GAMES * 0.22)} is the`);
console.log('threshold for significance; anything closer than that is not evidence of much.\n');

if (ONLY === 'all' || ONLY === 'sanity') {
  console.log('1. Is it playing at all?');
  matchup('ismcts vs random', ismcts({}), (seed) => randomPlayer(seed));
  console.log();
}

if (ONLY === 'all' || ONLY === 'budget') {
  console.log('2. Does more search make it stronger?');
  // If this is flat, the bottleneck is the evaluation, not the search -- which is the signal that a
  // learned value would start to be worth the trouble.
  matchup(`${ITERATIONS * 4} iterations vs ${ITERATIONS}`, ismcts({ iterations: ITERATIONS * 4 }), ismcts({}));
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
    ['value rescaling', { normaliseValues: true }, { normaliseValues: false }],
  ];
  for (const [label, on, off] of comparisons) {
    if (FILTER && !label.includes(FILTER)) continue;
    matchup(label, ismcts(on), ismcts(off));
  }
  console.log();

  console.log('4. Against the plain baseline, everything off');
  matchup('tuned vs baseline', ismcts({}), (seed) => ismctsPlayer({ ...BASELINE, iterations: ITERATIONS, seed }));
  console.log();
}

if (ONLY === 'all' || ONLY === 'diagnostics') {
  console.log('5. Diagnostics');
  const { collected } = matchup(
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
