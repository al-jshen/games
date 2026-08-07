/**
 * One self-play game, and the players that drive it.
 *
 * Shared by the main thread and the worker pool so there is exactly one definition of what a game is
 * — a second copy in the worker would be the obvious place for the two to drift apart.
 */

import { RandomCursor } from '@games/engine';
import { measureDisagreement, search } from '@games/bot-ismcts';
import splendorDuel, {
  determinize,
  encodeView,
  evaluate,
  redactFor,
  rolloutPreference,
  sampleAction,
  visitsToPolicy,
} from '@games/splendor-duel';

/** Self-play must terminate. The official rules do not guarantee it, so the house rule goes on. */
export const OPTIONS = { maxTurnsWithoutPurchase: 60 };

export const deps = {
  mod: splendorDuel,
  determinize,
  sampleAction,
  evaluate: (state, seat) => evaluate(state, seat),
  rolloutPolicy: (state, seat, actions, rng) => {
    // Only consulted when the fast sampler is off; the sampler carries its own bias.
    const buys = rolloutPreference(actions);
    if (buys.length > 0 && rng.int(4) > 0) return buys[rng.int(buys.length)];
    return rng.int(actions.length);
  },
};

function ismctsPlayer(config, record) {
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
      const result = search(deps, view, seat, { ...config, seed: `${config.seed}:${move++}` });
      if (record) {
        samples.push({
          x: encodeView(view, seat),
          pi: visitsToPolicy(result.ranking),
          seat,
          move: move - 1,
          // Filled in once the game ends; a position's worth is not known until then.
          z: 0,
        });
      }
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
    samples: [],
    choose(state, seat) {
      const { actions } = splendorDuel.legalActions(state, seat);
      return actions[rng.int(actions.length)];
    },
  };
}

/** Build a player from a plain description, so a whole matchup can cross a worker boundary. */
export function makePlayer(spec, record = false) {
  return spec.kind === 'random' ? randomPlayer(spec.seed) : ismctsPlayer(spec.config, record);
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
