# @games/bot-ismcts

Information Set Monte Carlo Tree Search, game-agnostic.

Plain MCTS assumes you know which position you are in. Under imperfect information you do not, so
each iteration samples a world consistent with what you *do* know and searches that. The trap is that
a tree of *states* would then let the search choose a different move in each sampled world — planning
as though it will know the answer later, when really it must commit blind. That is **strategy
fusion**, and it is why the tree here is keyed on the acting player's **information set**:
indistinguishable worlds share a node, so there is only one place to record a preference.

The other thing ISMCTS has to get right is the exploration term. Different worlds make different
moves legal, so an action tried twice because it was rarely *available* is not the same as one tried
twice because it looked bad. UCB counts **availability**, not node visits.

## Using it

The search needs three things from a game, and only the first is game-specific in an interesting way:

```ts
search({ mod, determinize, evaluate, rolloutPolicy? }, view, seat, config)
```

- `mod` — any `GameModule`.
- `determinize(view, seat, rng)` — sample a concrete state consistent with the view.
- `evaluate(state, seat)` — a position's worth in `[-1, 1]`, on the same scale as a win or loss.

For a perfect-information game the determinizer is the identity, which is how the tic-tac-toe tests
exercise the tree in isolation.

## Everything is a switch

None of the extras is obviously worth its cost, so each is configurable and each is measured rather
than assumed. `BASELINE` has them all off; `DEFAULT_CONFIG` has the ones I would bet on.

| Setting | What it does |
| --- | --- |
| `leaf` | `heuristic` / `rollout` / `mixed` at a freshly expanded node |
| `shrinkage` | how far `mixed` leans on the heuristic — a control variate against noisy rollouts |
| `biasedRollout` | nudge rollouts toward purchases, since uniform play never builds an engine |
| `commonRandomNumbers` | reuse a pool of worlds so siblings are compared under the same conditions |
| `normaliseValues` | rescale sibling values before UCB, so exploration cannot swamp a narrow range |

Run `npm run selfplay` to play each of them against the same configuration with it turned off.

## What the measurements said

16 games per matchup at 120 iterations, seats swapped every game. At that sample only a rout is
significant — roughly 13-3 — so treat the middle rows as unresolved rather than as results.

| Matchup | Result | Read |
| --- | --- | --- |
| ismcts vs random | 16-0 | it plays |
| 480 iterations vs 120 | 14-2 | **search scales**; the bottleneck is still the tree, not the evaluation |
| tuned vs plain baseline | 14-2 | the package of extras is worth having |
| heuristic shrinkage 0.5 | 12-4 | probably helping |
| value rescaling | 12-4 | probably helping |
| heuristic only, no rollout | 10-6 | unresolved, and ~7x slower per move — worth a look |
| biased rollouts | 9-7 | no evidence either way |
| common random numbers (pool 32) | 6-10 | **hurting** |
| common random numbers (pool > iterations) | 10-6 | no effect |

Two things are worth taking from that.

**Common random numbers does not work here, and the reasoning for it was wrong.** CRN pays off when
each candidate action is evaluated against each world in a paired way. A tree never does that: an
iteration descends a single path, and a node's statistics are already pooled over every world that
reached it, so there is no paired comparison for the shared noise to cancel out of. A small pool then
makes things worse by narrowing the sample. It is off by default.

**More search still buys strength**, decisively. That is the signal that a learned value function is
*not* yet the thing to build — the search is still the binding constraint. When that curve flattens,
the evaluation has become the bottleneck and a value net starts to be worth the trouble.

**Strategy fusion has almost no room here.** Sampled worlds disagree about the best move 44.6% of the
time — but running the same measurement against a *single* world with different seeds disagrees 40.8%
of the time, so only about 4 points of that is the hidden state rather than search noise. Without
that control the raw number would have looked alarming and meant nothing.

## Verification

The search is checked against tic-tac-toe, where the answers are known: it must never lose to itself
or to random play, must take every immediate win and block every immediate loss, and must agree with
an exact minimax solver across a spread of positions. Splendor Duel cannot tell you any of that — a
subtly broken search still produces plausible moves and still beats a random bot.
