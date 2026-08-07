/**
 * Every choice in the search that we are not sure about, on a switch.
 *
 * The techniques below are all defensible on paper and none of them is obviously worth its cost in
 * this game, so the point is to be able to turn each one off and measure. Defaults are what I would
 * bet on; `BASELINE` is plain ISMCTS with none of the extras, which is what everything gets compared
 * against.
 */
export interface SearchConfig {
  /** Simulations per move. The main strength dial. */
  iterations: number;
  /** UCB exploration weight. Meaningful only against a value scale of roughly [0, 1]. */
  exploration: number;

  /**
   * What to do at a freshly expanded leaf.
   *
   * `evaluate` calls `deps.evaluate` and stops: cheapest, so the most iterations per second, but the
   * evaluator's blind spots become the agent's. `rollout` plays on and uses the outcome: slower and
   * noisier, but it injects real dynamics the evaluator may not know about. `mixed` blends the two
   * by `shrinkage`.
   *
   * This option was called `heuristic`, which named the wrong thing. The evaluator is a dependency
   * the caller supplies, and once a value network was passed as `deps.evaluate` the configuration
   * read `leaf: 'heuristic'` while no heuristic was involved anywhere. These three name a *strategy*
   * for turning a leaf into a number, not the function that does it -- and that distinction is what
   * lets a network be dropped in without the search knowing.
   *
   * Worth measuring rather than assuming: random rollouts are famously uninformative in
   * engine-building games, because two random players never build an engine, so whatever advantage
   * one side had never gets to cash out.
   */
  leaf: 'evaluate' | 'rollout' | 'mixed';
  /** Plies to roll out before giving up and evaluating. Bounds cost, and bounds non-terminating games. */
  rolloutDepth: number;
  /**
   * Weight on the evaluator when `leaf` is `mixed`. 0 is pure rollout, 1 is pure evaluator.
   *
   * A control variate: trading a little bias for a large drop in variance. The classic answer to
   * "the rollouts are noisy".
   */
  shrinkage: number;
  /** Bias rollouts toward buying rather than moving uniformly at random. */
  biasedRollout: boolean;
  /**
   * Use the game's `sampleAction` in rollouts, where it has one, instead of enumerating.
   *
   * Enumerating legal moves measured at 39% of self-play, nearly all of it thrown away — a rollout
   * wants one move, not all of them. The sampler carries its own bias, so `biasedRollout` has no
   * effect while this is on.
   */
  fastRollout: boolean;

  /**
   * Reuse a fixed pool of sampled worlds instead of drawing a fresh one every iteration.
   *
   * Intended as common random numbers: compare siblings under the same worlds so the shared noise
   * cancels. **Measurement says it does not work here, and the reasoning behind it was wrong.** CRN
   * pays off when each candidate action is evaluated against each world in a paired way, as in PIMC.
   * A tree does not do that — an iteration descends one path and the statistics are already pooled
   * across every world that reached the node, so there is no paired comparison for shared noise to
   * cancel out of. All the pool changes is how many distinct worlds get sampled.
   *
   * Which is why it is actively harmful when the pool is small: 32 worlds over 120 iterations means
   * each is reused nearly four times and the search fits those particular worlds. Measured at 6-10
   * against having it off. With the pool larger than the iteration count it recovers to 10-6, which
   * is simply "no difference" — as it should be, since no world is then reused.
   */
  commonRandomNumbers: boolean;
  /** Size of that pool. Below the iteration count, worlds repeat and the search overfits to them. */
  worldPool: number;

  /**
   * Rescale sibling values into [0, 1] before applying the exploration term.
   *
   * UCB's constant assumes rewards spread across roughly [0, 1]. A heuristic that returns everything
   * in a narrow band leaves exploration swamping value, and the search degenerates toward uniform.
   *
   * MuZero rescales Q against the min and max observed in the tree, which is the same mechanism —
   * but for the opposite complaint, and its reasoning does not transfer. It is fixing values that
   * are *unbounded*, and says so of the case we are actually in: "In two-player zero sum games the
   * value functions are assumed to be bounded within the [0,1] interval." The justification here is
   * the narrow band, and it stands on the A/B result below rather than on that paper.
   */
  normaliseValues: boolean;

  /** Seeds the search's own randomness, so a run reproduces exactly. */
  seed: string;
}

/** Plain ISMCTS: no shrinkage, no shared worlds, no rescaling. The thing to beat. */
export const BASELINE: SearchConfig = {
  iterations: 800,
  exploration: 1.4,
  leaf: 'rollout',
  rolloutDepth: 40,
  shrinkage: 0,
  biasedRollout: false,
  fastRollout: false,
  commonRandomNumbers: false,
  worldPool: 32,
  normaliseValues: false,
  seed: 'ismcts',
};

/**
 * What measurement, rather than argument, currently supports.
 *
 * `commonRandomNumbers` is off despite being the technique I expected most from. Over 16 games it
 * lost 6-10 to the same configuration without it — not significant on its own, but it matches the
 * failure mode written into its own doc comment: a pool of 32 worlds against 120 iterations is
 * sampled nearly four times over, so the search starts fitting those particular worlds. The variance
 * it removes from the comparison costs more in bias than it saves. Turn it back on with a pool
 * comfortably larger than the iteration count and re-run `npm run selfplay --only ab`.
 */
export const DEFAULT_CONFIG: SearchConfig = {
  ...BASELINE,
  leaf: 'mixed',
  shrinkage: 0.5,
  biasedRollout: true,
  fastRollout: true,
  commonRandomNumbers: false,
  normaliseValues: true,
};

export function withConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
