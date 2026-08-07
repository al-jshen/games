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

Each row carries its game, move number and seat, so a suspicious sample leads back to a seed and can
be opened in the replay viewer. Without that a bad row is 719 anonymous floats.

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

The reason is structural and worth internalising before scaling anything: **one outcome label per
game.** 149,000 positions sound like a lot and are 1,200 independent labels, because every position
in a game is tagged with the same result. The effective sample size is games, not rows — so a run
that takes 25 minutes buys 1,200 labels, and the interesting regime is further out than it looks.
