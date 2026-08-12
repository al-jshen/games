/**
 * One self-play game, and the players that drive it.
 *
 * Shared by the main thread and the worker pool so there is exactly one definition of what a game is
 * — a second copy in the worker would be the obvious place for the two to drift apart.
 */

import { RandomCursor } from '@games/engine';
import { measureDisagreement, search } from '@games/bot-ismcts';
import { OPTIONS, heuristicDeps, netDeps, pickAction } from '@games/bot-splendor-duel';
import splendorDuel, { determinize, encodeView, evaluate, redactFor, visitsToPolicy } from '@games/splendor-duel';
import { loadNet } from './net.mjs';

export { OPTIONS };

/**
 * The search's dependencies, with the hand-written evaluation at the leaf.
 *
 * Re-exported rather than defined here: `@games/bot-splendor-duel` owns this wiring now, because the
 * web client's bot needs the identical thing and two copies of a softmax over policy slots is the
 * sort of drift nobody notices until an opponent is quietly weaker than the elo beside its name.
 */
export const deps = heuristicDeps;

/**
 * The same search with a network at the leaf instead of the hand-written evaluation.
 *
 * No change to `bot-ismcts` was needed and that is the point: `evaluate` was always a dependency the
 * search takes rather than a function it owns, and `leaf: 'evaluate'` already means "evaluate the
 * position, do not roll out" -- which is exactly AlphaZero's leaf. So swapping the evaluator is the
 * whole change, and the search cannot tell the difference. Both return tanh into [-1, 1].
 *
 * Cached per worker thread, because this module is loaded once per worker and a 92KB read plus parse
 * on every game would be pure overhead for a file that never changes mid-run.
 */
const nets = new Map();
const cachedNet = (path) => {
  let net = nets.get(path);
  if (net === undefined) {
    net = loadNet(path);
    nets.set(path, net);
  }
  return net;
};

/**
 * Deps for a network at the leaf, and optionally priors for PUCT, named by path.
 *
 * A dual checkpoint supplies both from one file: `--net` alone is enough, and no separate policy
 * path is needed. A single-headed value checkpoint still works and still takes a second file for the
 * policy, which is what every measurement before the dual net was made with.
 */
export function depsWithNet(path, policyPath) {
  const net = cachedNet(path);
  return netDeps(net, policyPath ? cachedNet(policyPath) : undefined);
}

function ismctsPlayer(config, record, netPath, explore, policyPath) {
  const searchDeps = netPath ? depsWithNet(netPath, policyPath) : deps;
  // Seeded off the player's own seed, so a generation run stays reproducible move for move.
  const exploreRng = explore ? new RandomCursor(`explore:${config.seed}`, 0) : null;
  let move = 0;
  const stats = { disagreement: [], noiseFloor: [], valueSpan: [] };
  /*
   * Recorded here rather than reconstructed later, because the training target is the *search's*
   * visit distribution and that exists only at the moment of choosing. Replaying the game afterwards
   * would recover the moves but not the search's opinion of the alternatives, which is the whole
   * signal.
   */
  const samples = [];
  return {
    stats,
    samples,
    choose(state, seat) {
      const view = JSON.parse(JSON.stringify(redactFor(seat, state)));
      // A fresh seed per move: reuse one for a whole game and every search samples the same worlds.
      const result = search(searchDeps, view, seat, { ...config, seed: `${config.seed}:${move++}` });
      if (record) {
        samples.push({
          x: encodeView(view, seat),
          pi: visitsToPolicy(result.ranking),
          /*
           * The hand-written evaluation's own opinion of this position, recorded so a learned value
           * has something to be measured against. Without a baseline "the loss went down" says
           * nothing about whether the network is worth having.
           */
          h: evaluate(determinize(view, seat, new RandomCursor(`h:${config.seed}:${move}`, 0)), seat),
          /*
           * What the search concluded about this position. Recorded separately from `z` rather than
           * blended into it, and deliberately so: it derives from the heuristic through the rollouts,
           * so training against it partly distils the heuristic. Keeping it apart lets the trainer
           * choose a mix while still being scored against the actual result -- blend the two here and
           * "does the network beat the heuristic?" would quietly become circular.
           */
          q: result.rootValue,
          seat,
          move: move - 1,
          // Filled in once the game ends; a position's worth is not known until then.
          z: 0,
        });
      }
      stats.valueSpan.push(result.valueRange.max - result.valueRange.min);
      // Expensive -- a separate search per world -- so only sampled occasionally.
      if (config.measureDisagreement && move % 12 === 0) {
        const spread = measureDisagreement(searchDeps, view, seat, { ...config, iterations: 120 }, 8);
        stats.disagreement.push(spread.acrossWorlds);
        stats.noiseFloor.push(spread.sameWorld);
      }
      // `move` has already been incremented for the search's seed, so the move just chosen is one back.
      return pickAction(result.ranking, move - 1, explore, exploreRng);
    },
  };
}

function randomPlayer(seed) {
  const rng = new RandomCursor(seed, 0);
  return {
    stats: null,
    samples: [],
    choose(state, seat) {
      const { actions } = splendorDuel.legalActions(state, seat);
      return actions[rng.int(actions.length)];
    },
  };
}

/** Build a player from a plain description, so a whole matchup can cross a worker boundary. */
export function makePlayer(spec, record = false) {
  return spec.kind === 'random'
    ? randomPlayer(spec.seed)
    : ismctsPlayer(spec.config, record, spec.net, spec.explore, spec.policy);
}

/**
 * Play one game and report it from A's point of view.
 *
 * Seats alternate between games, because Splendor Duel's first player has an advantage and a matchup
 * that did not swap would mostly measure who drew seat zero.
 */
export function playGame(job) {
  const a = makePlayer(job.a, job.record);
  const b = makePlayer(job.b, job.record);
  const players = job.aFirst ? [a, b] : [b, a];

  let state = splendorDuel.setup({ seed: job.seed, seats: [0, 1], options: OPTIONS });
  let moves = 0;
  let winner = null;
  for (; moves < 4000; moves++) {
    const outcome = splendorDuel.outcome(state);
    if (outcome.status === 'over') {
      winner = outcome.winners[0] ?? null;
      break;
    }
    const seat = splendorDuel.currentActors(state)[0];
    if (seat === undefined) break;
    const action = players[seat].choose(state, seat);
    const result = splendorDuel.apply(state, seat, action);
    if (!result.ok) throw new Error(`self-play: ${result.error.code} ${result.error.message}`);
    state = result.state;
  }

  const collected = { disagreement: [], noiseFloor: [], valueSpan: [] };
  for (const player of [a, b]) {
    if (!player.stats) continue;
    collected.disagreement.push(...player.stats.disagreement);
    collected.noiseFloor.push(...player.stats.noiseFloor);
    collected.valueSpan.push(...player.stats.valueSpan);
  }

  /*
   * A position is worth what the game turned out to be worth to whoever was about to move. Filled in
   * only now, because that is the first moment it is known.
   */
  const samples = [];
  if (job.record) {
    for (const player of [a, b]) {
      for (const sample of player.samples) {
        sample.z = winner === null ? 0 : winner === sample.seat ? 1 : -1;
        sample.game = job.gameIndex ?? 0;
        samples.push(sample);
      }
    }
  }

  return {
    moves,
    // `null` for a draw or a stall; otherwise did A win?
    aWon: winner === null ? null : (winner === 0) === job.aFirst,
    collected,
    samples,
  };
}
