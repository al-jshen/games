/**
 * Wiring the game-agnostic search to this particular game, with or without a network.
 *
 * `@games/bot-ismcts` knows nothing about Splendor Duel: it takes an evaluator, a determinizer and
 * optionally a prior as dependencies. Everything that fills those in is here.
 *
 * **This exists because it had two callers and they must not drift.** Self-play, the arena and every
 * elo number in this repo run through `tools/selfplay/game.mjs`; the bot a player faces in
 * `apps/web` runs through the browser. If the priors were softmaxed slightly differently on the two
 * sides, the opponent in the web client would not be the agent that was measured, and nothing would
 * fail -- it would just be a bit weaker than the number next to its name claims. So both import
 * this, and `game.mjs` is left holding only the parts that are genuinely node-specific: reading
 * checkpoints off disk and caching them per worker thread.
 */

import { RandomCursor, type Seat } from '@games/engine';
import type { SearchDeps } from '@games/bot-ismcts';
import { policyOf, valueOf, type Net } from '@games/net';
import {
  determinize,
  encodeView,
  evaluate,
  redactFor,
  rolloutPreference,
  sampleAction,
  actionToIndex,
  splendorDuel,
  type SplendorAction,
  type SplendorOptions,
  type SplendorState,
  type SplendorView,
} from '@games/splendor-duel';

export type SplendorSearchDeps = SearchDeps<SplendorState, SplendorAction, SplendorView, SplendorOptions>;

/**
 * The house rule that makes a game terminate.
 *
 * The official rules do not guarantee it -- two players who never buy anything can pass tokens back
 * and forth for ever -- and a search that has to bound its rollouts anyway is not the place to find
 * that out. Self-play needs it because a run of 50,000 games cannot afford one that never ends; a
 * human game needs it for the duller reason that a stalled position should resolve rather than sit.
 */
export const OPTIONS: SplendorOptions = { maxTurnsWithoutPurchase: 60 };

/** The hand-written evaluation at the leaf. What generation zero played with, and the baseline since. */
export const heuristicDeps: SplendorSearchDeps = {
  mod: splendorDuel,
  determinize,
  sampleAction,
  evaluate: (state, seat) => evaluate(state, seat),
  rolloutPolicy: (state, seat, actions, rng) => {
    // Only consulted when the fast sampler is off; the sampler carries its own bias.
    const buys = rolloutPreference(actions);
    if (buys.length > 0 && rng.int(4) > 0) return buys[rng.int(buys.length)] as number;
    return rng.int(actions.length);
  },
};

/**
 * Priors over the legal actions, from the policy head, for PUCT.
 *
 * Two things happen here that the network cannot do for itself.
 *
 * The softmax is over the *legal* slots only, which is what makes the network's leaked probability
 * mass on impossible moves harmless -- 0.32 nats of its held-out error, and every bit of it
 * renormalised away here. The search knows the legal moves; the network never had to.
 *
 * And the action-to-slot map is deliberately many-to-one -- which gold you substitute, which token
 * you take when reserving -- so several legal actions can land in one slot. That slot's probability
 * is the group's, since the training target summed their visit counts to build it, so it is split
 * evenly back among them. Giving each the full value instead would inflate a group purely for being
 * large.
 */
function policyPriors(net: Net) {
  return (state: SplendorState, actor: Seat, actions: readonly SplendorAction[]): readonly number[] => {
    const logits = policyOf(net, encodeView(redactFor(actor, state), actor as 0 | 1));
    const slots = actions.map((a) => actionToIndex(a));

    const shared = new Map<number, number>();
    let max = -Infinity;
    for (const slot of slots) {
      shared.set(slot, (shared.get(slot) ?? 0) + 1);
      if ((logits[slot] as number) > max) max = logits[slot] as number;
    }
    // Subtract the max before exponentiating: without it a confident logit overflows to Infinity and
    // every prior comes back NaN, which PUCT would silently turn into "never select anything".
    let total = 0;
    const weight = new Map<number, number>();
    for (const slot of shared.keys()) {
      const w = Math.exp(((logits[slot] as number) - max) / net.temperature);
      weight.set(slot, w);
      total += w;
    }
    return slots.map((slot) => (weight.get(slot) as number) / total / (shared.get(slot) as number));
  };
}

/**
 * Deps for a network at the leaf, and optionally priors for PUCT.
 *
 * A dual checkpoint supplies both from one net: pass it alone and no separate policy is needed. A
 * single-headed value checkpoint still works and still takes a second one for the policy, which is
 * what every measurement before the dual net was made with.
 *
 * Pass `policy: null` deliberately to get a value net with no priors -- `selection: 'ucb1'`, or
 * `puct` falling back to UCB1's expansion phase, which is what generation zero ran.
 */
export function netDeps(value: Net, policy?: Net | null): SplendorSearchDeps {
  const priorNet = policy === undefined ? (value.kind === 'dual' ? value : null) : policy;
  return {
    ...heuristicDeps,
    ...(priorNet ? { priors: policyPriors(priorNet) } : {}),
    /*
     * Re-redacted at every leaf, deliberately. The state inside the tree is a *determinized* world
     * with hidden information sampled, and the network was trained on redacted views -- so handing
     * it the determinized state would feed it cards the player cannot see, at a scale it never saw
     * in training. Redaction throws the sample away again, which is the correct thing: the sampled
     * world decides which positions the search reaches, not what the evaluation is allowed to know.
     */
    // `Seat` is the engine's open-ended number; `encodeView` narrows it, because the feature layout
    // has one block per player and this game has exactly two of them.
    evaluate: (state, seat) => valueOf(value, encodeView(redactFor(seat, state), seat as 0 | 1)),
  };
}

/**
 * Which move to play out of what the search found.
 *
 * Greedy on visit counts is right for playing and wrong for generating training data -- a deal
 * played greedily produces exactly one line, so a generation of self-play explores only the moves
 * the current network already prefers. AlphaZero samples proportional to visits for the opening and
 * plays greedily thereafter, and this is that.
 *
 * `visits ** (1/T)`: T=1 samples in proportion to visits, T below 1 sharpens toward the favourite,
 * and T at 0 is greedy. The exponent goes on visit counts rather than on the search's value
 * estimates deliberately -- visits are the low-variance statistic, which is the same reason the
 * greedy choice uses them.
 */
export function pickAction<A>(
  ranking: readonly { action: A; visits: number }[],
  moveNumber: number,
  explore: { temperature: number; moves: number } | null | undefined,
  rng: RandomCursor,
): A {
  const first = ranking[0];
  if (first === undefined) throw new Error('pickAction: empty ranking');
  if (!explore || explore.temperature <= 0 || moveNumber >= explore.moves) return first.action;
  const weights = ranking.map((r) => Math.pow(r.visits, 1 / explore.temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return first.action;
  // `RandomCursor` deals in integers, so a uniform float comes from a wide integer draw. 2^30 is
  // far more resolution than a distribution over ~25 actions can use.
  let pick = (rng.int(1 << 30) / (1 << 30)) * total;
  for (let i = 0; i < ranking.length; i++) {
    pick -= weights[i] as number;
    if (pick <= 0) return (ranking[i] as { action: A }).action;
  }
  return (ranking[ranking.length - 1] as { action: A }).action;
}
