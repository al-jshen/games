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

## Speed

Self-play throughput is strength: 4x the iterations measured 31-1. So the profile matters. Timing the
engine calls directly (the `--prof` output on macOS mis-attributes almost everything to one bogus
symbol) showed **94% of self-play in two functions** — `apply` at 55% and `legalActions` at 39%.

| Change | Effect |
| --- | --- |
| Hand-written clone in `apply`, replacing a JSON round trip | copy 6.33µs → 0.23µs (**27x**), ~40% off total |
| `sampleAction` fast path, replacing enumeration in rollouts | **1.8x** |
| Worker-thread pool for self-play | **3.9x** on 9 workers |

About **13x** end to end: 77ms per move down to 22ms, then divided across cores. Parallel scaling is
sub-linear because the workload is allocation-heavy and threads contend for memory bandwidth, each
with its own heap.

Two of those needed a second look:

`structuredClone` is *slower* than the JSON round trip here, which is not what you would guess. The
hand-written copy wins because it never builds a string — no formatting every number and key into
text and parsing it back.

The sampler was initially **worse**, 8-24 at equal iterations, despite doing what looked like the
same job as enumerate-then-choose. Measuring the two distributions showed why: it proposed purchases
2.2% of the time against enumeration's 28.7%. Picking one random card and testing it almost always
finds an unaffordable one, where enumeration finds every affordable card and the rollout bias then
picks it. Scanning for affordability instead — still far cheaper than full enumeration, which also
expands payment variants and 145 token lines — brought it to 19-13, and 23-9 at equal time.

## What the measurements said

32 games per matchup at 120 iterations, seats swapped every game. At that sample the significance
threshold is about 25-7, so treat the middle rows as unresolved rather than as results. Several of
these reversed between 16 and 32 games, which is the argument for the threshold being printed.

| Matchup | Result | Read |
| --- | --- | --- |
| ismcts vs random | 32-0 | it plays |
| 480 iterations vs 120 | 31-1 | **search scales**; the bottleneck is still the tree, not the evaluation |
| tuned vs plain baseline | 25-7 | the package of extras is worth having |
| heuristic shrinkage 0.5 | 25-7 | helping |
| fast sampler, equal *time* | 23-9 | worth its slight cost per simulation |
| value rescaling | 22-10 | probably helping |
| fast sampler, equal iterations | 19-13 | no longer worse, after the fix above |
| biased rollouts | 17-15 | no evidence either way |
| heuristic only, no rollout | 8-24 | **rollouts do matter** — this reversed at a bigger sample |

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

## Tree reuse was tried and removed

Keeping the subtree under the moves played is standard, and normally good for 2-4x effective
iterations. Here it was worth **an 11% head start** — about 13 visits of 120 — and 19-13 in strength,
which is not significant. The turn structure is why: reuse pays when you descend one ply between your
own moves, and a Splendor Duel turn is several atomic decisions, so you descend three to five levels
and each one splits the inherited visits across that node's options.

It was removed because it is also not sound under imperfect information, and the marginal gain did
not justify the hazard. A retained node pools statistics gathered across many *sampled* worlds, and a
chance event between two searches makes those worlds diverge in **public** state: when the opponent
replenishes, every sample draws different tokens onto the board. The node "after their replenish"
then holds moves that were legal against boards which never happened. Self-play died on one — a
reserve against a cell that held gold only in the search's imagination.

Pruning inherited children against the real position fixed the crash, but not the deeper problem: the
surviving moves' values were still averaged over boards that did not occur. A biased prior rather
than an illegal move. For an unproven 11%, not worth carrying.

Worth revisiting only if the search gets much deeper per turn, where the inheritance would survive
further down.

## Verification

The search is checked against tic-tac-toe, where the answers are known: it must never lose to itself
or to random play, must take every immediate win and block every immediate loss, and must agree with
an exact minimax solver across a spread of positions. Splendor Duel cannot tell you any of that — a
subtly broken search still produces plausible moves and still beats a random bot.
