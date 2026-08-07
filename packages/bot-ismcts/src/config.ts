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

  /**
   * How a child is chosen once the tree has been walked into.
   *
   * `ucb1` is what this search has always done: score by mean value plus an exploration bonus that
   * depends only on how often an action has been tried. It has no opinion about a move it has never
   * tried, which is why `descend` has to expand every legal action once, uniformly at random, before
   * `select` runs at all. Measured cost of that: at a position with 48 legal moves and 300
   * iterations, 48 of them go on random expansion and the resulting visit distribution has an
   * effective support of 45.9 moves. The search never gets far enough to have an opinion.
   *
   * `puct` scores unvisited actions too, by weighting the exploration term with a prior from a
   * policy network -- `Q + c·P·√ΣN/(1+N)`, finite at `N = 0`. A move nothing recommended can simply
   * never be expanded, which is what lets the budget concentrate.
   *
   * Under `ucb1` the policy network is never consulted, and `deps.priors` may be absent. That is the
   * point of the toggle: one search, one measurement at a time.
   *
   * **Measured, and `puct` currently loses badly.** Against the same search with `ucb1`, both using
   * the same value network at the leaf: 30-90 over 120 games with priors at the root, and 4-16 over
   * 20 at full depth. On move agreement with a 3000-iteration reference across 150 positions, `ucb1`
   * scores 44% and `puct` 33-39% at every exploration constant from 1.5 to 16.
   *
   * The reason is not tuning, and it is worth understanding before trying again. PUCT trades
   * exploration for prior-guidance, and there is no prior-guidance here to gain: gen-0's policy head
   * produces priors with an effective support of 47.7 out of 48 legal moves, which is uniform to
   * within a rounding error. Meanwhile the trade costs real exploration -- at a child with ten
   * visits, UCB1's bonus is ~1.06 against PUCT's ~0.05 on the same [0, 1] value scale, a twentyfold
   * difference in how fast the search stops questioning itself.
   *
   * And this search needs that questioning more than AlphaZero's does. Every iteration re-determinizes,
   * so the same node returns a different value depending on which world was drawn: a 3000-iteration
   * search agrees with *itself* on only 74% of positions across reseeds. UCB1's oversized exploration
   * term is insurance against that variance, and PUCT cashes it in for a prior that says nothing.
   *
   * Which points at the order of operations rather than at abandoning it. `pi` is flat in exactly the
   * high-branching positions where a prior would earn its keep, because the search that produced the
   * targets did not concentrate there either -- 5.3% on the favourite at 300 iterations, 28.2% at
   * 1232. Deeper search sharpens the targets, sharper targets train a policy head worth consulting,
   * and then this becomes worth re-running.
   */
  selection: 'ucb1' | 'puct';
  /**
   * PUCT's exploration constant, the `c` in `Q + c·P·√ΣN/(1+N)`.
   *
   * Separate from `exploration` because the two terms are on different scales and share nothing but
   * a name -- UCB1's multiplies `√(log a / n)`, PUCT's multiplies `P·√ΣN/(1+n)`. Tuning one to the
   * other's value would be a coincidence. 1.5 is the value Tian et al. inferred for AlphaGo Zero,
   * which is a starting point and not a measurement of this game.
   */
  puctExploration: number;
  /**
   * How deep priors are used, counting the root as 0. Beyond it, `ucb1`.
   *
   * A knob because priors are not free: they cost a forward pass per node, and until the policy and
   * value heads share a trunk that is a second network call on top of the leaf evaluation. At depth
   * 0 it is one call per *move* rather than one per iteration -- ~4% overhead -- and the root is
   * where the waste is worst, since it has the most legal moves and the most iterations to squander
   * on them. So the cheap experiment and the full one are the same code path with a different number.
   */
  puctDepth: number;

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
  selection: 'ucb1',
  puctExploration: 1.5,
  puctDepth: 99,
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
