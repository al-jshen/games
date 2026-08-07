# Self-play tooling

Three programs, deliberately separate:

| | |
| --- | --- |
| `selfplay.mjs` | A/B the search's options against each other. Answers questions about the search. |
| `generate.mjs` | Produce a training dataset. Answers nothing; just makes data. |
| `train_value.py` | Ask whether a learned value beats the hand-written one. |

Mixing the first two would mean every dataset carried whichever experimental toggles happened to be
under test that day.

```bash
npm run selfplay                                        # the A/B battery
node tools/selfplay/generate.mjs --games 300 --out .data/gen0
python3 tools/selfplay/train_value.py .data/gen0
```

## The dataset format

Raw little-endian `float32` blobs and a JSON sidecar — `np.fromfile(...).reshape(-1, width)`, no
library on either side. `read_dataset.py` is the whole Python end, and it knows nothing about
Splendor Duel: by the time data reaches it a position is an array of floats, which is what lets the
rules stay in one language.

Each row is `x` (the encoded view), `pi` (the search's visit counts over the policy space), and two
value signals — `z`, how the game turned out, and `q`, what the search concluded about that position.
Plus `h`, the hand-written heuristic's opinion, kept purely as a baseline to be measured against.

`z` and `q` are stored separately rather than pre-blended, because the trainer needs both: `q` is
derived from the heuristic through the rollouts, so a model fitted to it partly distils the
heuristic. Blend at write time and "does the network beat the heuristic?" quietly becomes circular.

Each row also carries its game, move number and seat, so a suspicious sample leads back to a seed and
can be opened in the replay viewer. Without that a bad row is 719 anonymous floats.

## What the validation said

The cheapest question worth asking before building a training loop: can a network judge a position
from these features better than a hundred lines of heuristic can?

On 300 games (28,154 positions), held out **by game** rather than by position — positions within a
game share an outcome and look alike, so splitting by row would put near-copies of training data in
the test set and report a score that does not exist:

Run at two sizes, because the second reading is what makes the first interpretable. Held-out MSE,
lower is better:

| | 240 games | 1,200 games |
| --- | --- | --- |
| hand-written heuristic | 0.836 | 0.870 |
| always zero | 1.000 | 1.000 |
| **learned, linear** | 0.914 | **0.862** |
| learned, small net | 0.918 | 0.905 |
| learned, larger net | 0.950 | 1.134 |

Two things to take from that.

**Capacity hurts, at both sizes.** Linear beats small beats large. That is the signature of too
little data rather than bad features, and the two call for opposite responses — one says generate
more games, the other says rewrite the encoder. Everything also beats predicting zero, so the
features carry real signal.

**Five times the data closed a nine-percent gap and crossed over.** The linear model went from 9%
worse than the heuristic to 1% better. One percent is inside the noise of which games landed in the
held-out split, so it is not yet a result — but the *direction and size* of the move is the actual
finding, and it says the lever is more games.

The reason is structural and worth internalising before scaling anything: **the outcome label is
shared across a whole game.** 149,000 positions sound like a lot; a single coin flip decides the
label on all ~99 rows of a game. The inputs all differ, so it is not literally 1,200 data points —
but it is clustered data whose targets are perfectly correlated within a cluster, and the effective
sample size for the value head sits far closer to games than to rows. A run that takes 25 minutes
buys 1,200 outcomes, and the interesting regime is further out than the row count suggests.

Two caveats on that, in both directions. It does not apply to the **policy** head at all — every row
has its own visit distribution, so those are 149,000 genuinely distinct targets. And it is not even
across a game: a position three moves from the end is nearly determined by the board, while one on
turn two is a near-random position with a coin flip stapled to it.

### Bootstrapping the value target

Which is what `q` is for. The search's estimate varies row by row where the outcome does not, so
mixing them trades a little bias for a lot of variance — not an invention here. It is precisely
[Leela Chess Zero's `q_ratio`](https://lczero.org/dev/wiki/neural-net-training/):
`target = q_ratio·Q + (1 − q_ratio)·Z`, adopted for the same stated reason, that a single blunder
flips Z for every position in the game. `train_value.py` fits at several mixtures,
`target = (1-λ)·z + λ·q`, and scores every one of them against `z` alone.

Worth being exact about the precedent, because the obvious citation is the wrong one.
[MuZero](https://arxiv.org/abs/1911.08265) bootstraps n-step returns from search values — but only
for Atari. Its Appendix G says the opposite for our case: *"For board games, we bootstrap directly to
the end of the game, equivalent to predicting the final outcome; for Atari we bootstrap for n=10
steps into the future."* Board-game AlphaZero and MuZero both train on the outcome. Lc0 is the
board-game engine that blends, and it is the honest citation.

On 1,200 games (960 training, 109,381 positions), held-out MSE:

| target | linear | small net | larger net |
| --- | --- | --- | --- |
| λ=0 — pure outcome | 0.9079 | 0.9635 | 1.1095 |
| λ=0.3 | 0.8823 | 0.9282 | 1.0206 |
| λ=0.6 | 0.8668 | 0.8881 | 0.9320 |
| **λ=1 — pure search value** | **0.8631** | **0.8571** | **0.8786** |

Monotone in every column: 11% better at small capacity, 21% at large. The variance argument holds,
and at this data size there is no interior optimum — the outcome label is noisy enough that the more
of it you replace, the better. Capacity still hurts at every λ, so it is still data-bound.

**The deflating half, which matters more than the win.** `q` scores **0.8174** by itself, against the
heuristic's 0.8789 — better than any network fitted to it. The network is not surpassing its teacher,
it is approximating it imperfectly. And `q` correlates +0.92 with `h`, so "the learned value beats
the heuristic by 2%" mostly means "the search beats the heuristic, and the network partly captures
that". Which is worth saying plainly, because the number alone reads like a stronger claim.

So what this value head is: **not a better evaluator than the search, a faster one** — one forward
pass in place of 300 iterations. That is the useful thing, and it is what AlphaZero's value head is
for. It is not evidence that the features permit exceeding search quality.

Two consequences. `q` at λ=1 is a distillation target, so it caps the network at search strength —
escaping that needs the outcome to carry more weight, which needs more games.

And the next thing to try is an n-step target: bootstrap from the search value *n moves later* rather
than at the same position, so the label carries played-out consequence instead of re-reading one
evaluation. That idea is worth testing on the strength of the table above and not on anyone's
authority — MuZero uses n-step for Atari and explicitly declines it for board games. The reason to
suspect it applies here anyway is scale: AlphaZero and MuZero trained board games on millions of
self-play games, where the outcome label's variance averages out. At 960 games it plainly does not,
which is what the λ column measures.
