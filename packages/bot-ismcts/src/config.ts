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
   * value functions are assumed to be bounded within the [0,1] interval."
   *
   * **On by default, and it was briefly turned off on principle -- which cost 207-13.** AlphaZero and
   * Leela both keep a fixed [-1, 1] scale rather than min-max rescaling, and the one engine that does
   * rescale is fixing unbounded values and declines it for board games. That argument is sound and it
   * is not sufficient, because they also tune their exploration constants *for* a fixed scale and we
   * had tuned ours for a rescaled one.
   *
   * Measured, both sides PUCT at c=4 and 300 iterations, rescaling the only difference: 207-13 over
   * 220 games, about +470 elo for having it on. Not a tuning gap -- a broken search. Without
   * rescaling the values arrive in a band roughly 0.07 wide while the exploration term still assumes
   * a spread near 1.0, so exploration swamps value and the search is close to random. That is the
   * failure this option was added to prevent, now with a number attached rather than the twenty-game
   * A/B it originally rested on.
   *
   * Turning it off is still defensible, but it is a *two* variable change: `exploration` and
   * `puctExploration` both scale with the value range, and at a 0.07-wide band they want to be
   * roughly an order of magnitude smaller. Nobody has tried that. What is settled is that flipping
   * this alone does not work.
   *
   * The costs are real and remain. It amplifies noise along with signal -- this network reports root
   * positions in a band 0.14 wide, so filling [0, 1] multiplies everything by about seven, in a
   * search that already disagrees with itself a quarter of the time. And it destroys any absolute
   * reference: "Q = 0 is neutral" becomes "zero is wherever it falls among this node's siblings",
   * which is exactly what made PUCT's unvisited children unreachable.
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
   * **`puct` lost 30-90 and then turned out to have a bug, which is worth recording in that order.**
   * Unvisited children were scored at a nominal `Q = 0` passed through `rescale`, which under
   * `normaliseValues` put them near the bottom of the sibling range rather than at the middle -- so a
   * move the prior did not favour was unreachable rather than merely deprioritised. See `selectPuct`.
   *
   * Before diagnosing it I wrote three confident explanations for the loss: the prior said nothing,
   * the sims-to-branching ratio was too thin, determinization needs more exploration than perfect
   * information does. The second and third are probably true in general. Neither was the cause, and
   * the first was simply wrong -- the priors are 1.5 to 3x uniform on their top slot.
   *
   * After the fix, the same matchup at the same 300 iterations with the same networks: **172-108
   * over 280 games, 61.4% [55.6%, 66.9%], about +81 elo [39, 122]**. It had been 30-90. A ~270 elo
   * swing out of one line, which is worth stating plainly because the three explanations written for
   * the loss were all plausible, none of them was the cause, and one of them was flatly wrong.
   *
   * The cheaper proxy agreed and would have been enough to justify the games: move agreement with a
   * 3000-iteration reference over 150 positions went from 33-39% at every constant to 44% for `ucb1`
   * against 47-53% for `puct`, best around c=4.
   *
   * **Its advantage shrinks as the budget grows**, which is the opposite of what I predicted twice.
   * At 300 iterations, +81 elo [39, 122]. At 1000, +21 elo [-27, 69] over 200 games -- no result.
   *
   * The reason is duller than the ratio argument it replaces. UCB1's forced random expansion is a
   * *fixed* cost: one wasted iteration per legal move, about 76 at a typical position here. That is
   * a quarter of a 300-iteration budget and a thirteenth of a 1000-iteration one. Most of what PUCT
   * buys is recovering that fixed cost, so its share falls as iterations rise -- and what remains,
   * the prior's actual guidance, is small because the priors are only 1.5 to 3x uniform.
   *
   * So it is worth having exactly where search is cheapest relative to branching, which is not where
   * anyone would look for it. And the way to make it matter at depth is a policy head worth
   * consulting, not a bigger exploration constant.
   *
   * Which loops back to `pi` being flat in the high-branching positions where a prior would earn its
   * keep, because the search that produced those targets did not concentrate there either -- 5.3% on
   * the favourite at 300 iterations, 28.2% at 1232. Deeper search sharpens the targets; sharper
   * targets are what would raise that +21.
   */
  selection: 'ucb1' | 'puct';
  /**
   * PUCT's exploration constant, the `c` in `Q + c·P·√ΣN/(1+N)`.
   *
   * Separate from `exploration` because the two terms are on different scales and share nothing but
   * a name -- UCB1's multiplies `√(log a / n)`, PUCT's multiplies `P·√ΣN/(1+n)`. Tuning one to the
   * other's value would be a coincidence.
   *
   * 4, not the 1.5 Tian et al. inferred for AlphaGo Zero. That was the starting point and it is the
   * wrong one here: on move agreement with a 3000-iteration reference over 150 positions, 1.5 scored
   * 47% and 4 scored 53%, and the +81 elo arena result was measured at 4. Borrowed constants are a
   * place to start looking, not a default to ship.
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
   *
   * **The default is 0 and the self-play loop overrides it to full depth. Both are measurements,
   * taken against different priors, and the difference between them is the whole point.**
   *
   * At 300 iterations against generation zero's priors, full depth scored 47.7% versus root-only,
   * -16 elo [-56, 23] -- no result over 300 games -- while costing 3.1x the time, since priors move
   * from one forward pass per move to one per iteration. Root-only got the same strength for 9%
   * overhead, so 0 was right, and this note used to say full depth was "not worth its cost and
   * possibly not worth anything".
   *
   * It also said that was not an argument deeper priors cannot help, only that *those* priors did
   * not -- gen-0's `pi` targets being near-uniform exactly where the tree is widest. That hedge
   * turned out to be the important sentence.
   *
   * Re-measured at 1000 iterations with a policy head that beats uniform-over-visited by 0.15 nats,
   * trained on targets from a 1000-iteration search. Same value net both sides, same 1000 deals,
   * one opponent (`ucb1`) for both arms:
   *
   *   root-only   53.9%   +27 elo [+6, +49]     177s
   *   full depth  74.0%   +182 elo [+157, +206] 312s
   *
   * Seven times the gain for 1.76x the time -- cheaper than the 3.1x above, because at 1000
   * iterations the network leaf already pays a forward pass per iteration, so a second one roughly
   * doubles the network work rather than tripling it.
   *
   * So the knob is not "how deep can we afford priors" but "are the priors worth consulting". With
   * a near-uniform policy head, consulting it deeper buys nothing and costs time. With one that has
   * something to say, it is the second largest effect measured in this search after
   * `normaliseValues`. The default stays 0 because a caller supplying no policy net or an untrained
   * one is the case it protects; the loop sets 99 because it knows what it trained.
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
  normaliseValues: true,
  selection: 'ucb1',
  puctExploration: 4,
  puctDepth: 0,
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
};

export function withConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
