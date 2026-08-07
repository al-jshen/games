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

## What the first validation said

The cheapest question worth asking before building a training loop: can a network judge a position
from these features better than a hundred lines of heuristic can?

On 300 games (28,154 positions), held out **by game** rather than by position — positions within a
game share an outcome and look alike, so splitting by row would put near-copies of training data in
the test set and report a score that does not exist:

```
  hand-written           mse 0.8361   sign  68.0%
  always zero            mse 1.0000   sign   0.0%
  learned (linear)       mse 0.9137   sign  62.0%
  learned (tiny)         mse 0.9179   sign  61.7%
  learned (mlp)          mse 0.9498   sign  60.5%
```

Not yet — but **how** it fails is the useful part. Capacity *hurts*: the linear model beats the small
net, which beats the larger one. That is the signature of too little data rather than bad features,
and the two call for opposite responses. Everything also beats predicting zero, so the features do
carry signal.

The reason is structural and worth internalising before scaling anything: **one outcome label per
game.** 28,154 positions sound like a lot and are really 240 independent labels, because every
position in a game is tagged with the same result. The effective sample size is games, not rows.
