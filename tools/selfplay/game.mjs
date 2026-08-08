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
  actionToIndex,
} from '@games/splendor-duel';
import { loadNet, policyOf, valueOf } from './net.mjs';

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
 * Priors over the legal actions, from the policy head, for PUCT.
 *
 * Two things happen here that the network cannot do for itself.
 *
 * The softmax is over the *legal* slots only, which is what makes the network's leaked probability
 * mass on impossible moves harmless -- 0.35 nats of its held-out error, and every bit of it
 * renormalised away here. The search knows the legal moves; the network never had to.
 *
 * And the action-to-slot map is deliberately many-to-one -- which gold you substitute, which token
 * you take when reserving -- so several legal actions can land in one slot. That slot's probability
 * is the group's, since the training target summed their visit counts to build it, so it is split
 * evenly back among them. Giving each the full value instead would inflate a group purely for being
 * large.
 */
function policyPriors(net) {
  return (state, actor, actions) => {
    const logits = policyOf(net, encodeView(redactFor(actor, state), actor));
    const slots = actions.map((a) => actionToIndex(a));

    const shared = new Map();
    let max = -Infinity;
    for (const slot of slots) {
      shared.set(slot, (shared.get(slot) ?? 0) + 1);
      if (logits[slot] > max) max = logits[slot];
    }
    // Subtract the max before exponentiating: without it a confident logit overflows to Infinity and
    // every prior comes back NaN, which PUCT would silently turn into "never select anything".
    let total = 0;
    const weight = new Map();
    for (const slot of shared.keys()) {
      const w = Math.exp((logits[slot] - max) / net.temperature);
      weight.set(slot, w);
      total += w;
    }
    return slots.map((slot) => weight.get(slot) / total / shared.get(slot));
  };
}

/**
 * Deps for a network at the leaf, and optionally priors for PUCT.
 *
 * A dual checkpoint supplies both from one file: `--net` alone is enough, and no separate policy
 * path is needed. A single-headed value checkpoint still works and still takes a second file for the
 * policy, which is what every measurement before the dual net was made with.
 */
export function depsWithNet(path, policyPath) {
  const net = cachedNet(path);
  const priorNet = policyPath ? cachedNet(policyPath) : net.kind === 'dual' ? net : null;
  return {
    ...deps,
    ...(priorNet ? { priors: policyPriors(priorNet) } : {}),
    /*
     * Re-redacted at every leaf, deliberately. The state inside the tree is a *determinized* world
     * with hidden information sampled, and the network was trained on redacted views -- so handing
     * it the determinized state would feed it cards the player cannot see, at a scale it never saw
     * in training. Redaction throws the sample away again, which is the correct thing: the sampled
     * world decides which positions the search reaches, not what the evaluation is allowed to know.
     */
    evaluate: (state, seat) => valueOf(net, encodeView(redactFor(seat, state), seat)),
  };
}

/**
 * Which move to actually play, given what the search found.
 *
 * Greedy on visit counts is right for measuring strength and wrong for generating training data. A
 * deal played greedily produces exactly one line, so a generation of self-play explores only the
 * moves the current network already prefers, and the next generation learns from a narrower slice of
 * the game than the one before it. AlphaZero's answer is to sample proportional to visits for the
 * opening and play greedily thereafter, and this is that.
 *
 * `visits ** (1/T)`: T=1 samples in proportion to visits, T below 1 sharpens toward the favourite,
 * and T at 0 is greedy. The exponent is applied to visit counts rather than to the search's value
 * estimates deliberately -- visits are the low-variance statistic, which is the same reason the
 * greedy choice uses them.
 *
 * The recorded policy target is untouched by any of this. `pi` is the visit distribution, which is
 * what the search concluded; sampling changes only which move gets played out of it.
 */
function pickAction(ranking, moveNumber, explore, rng) {
  if (!explore || explore.temperature <= 0 || moveNumber >= explore.moves) return ranking[0].action;
  const weights = ranking.map((r) => Math.pow(r.visits, 1 / explore.temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return ranking[0].action;
  // `RandomCursor` deals in integers, so a uniform float comes from a wide integer draw. 2^30 is
  // far more resolution than a distribution over ~25 actions can use.
  let pick = (rng.int(1 << 30) / (1 << 30)) * total;
  for (let i = 0; i < ranking.length; i++) {
    pick -= weights[i];
    if (pick <= 0) return ranking[i].action;
  }
  return ranking[ranking.length - 1].action;
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
