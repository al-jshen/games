"""Score a saved checkpoint against a dataset it has never seen, on a scale that does not move.

    python3 tools/selfplay/score_holdout.py models/gen11-value holdout/shard0
    python3 tools/selfplay/score_holdout.py --all models/ holdout/shard*

**Why this exists.** Every trainer splits its own data, so each generation reports held-out numbers
on a *different* holdout drawn from a *different* distribution -- and that has been actively
misleading. Across generations 2 to 11 the value head's held-out sign accuracy fell from 70.0% to
63.7%, which reads as a network getting steadily worse. It was not: the hand-written heuristic, a
fixed function that cannot change, fell from 66.0% to 59.7% on those same holdouts. The task was
getting harder as both players improved. Only a holdout that never changes can tell those apart.

A frozen holdout is a set of games generated once, kept outside `gen{N}/` so the training window can
never reach it, and scored the same way for ever. `loop.py` builds its window from `existing(g)`,
which only globs `gen{N}/shard*`, so a dataset at any other path is invisible to it -- the guarantee
is structural rather than a filter somebody has to maintain.

**Deliberately a separate script rather than a flag on the trainers.** Two reasons. It runs against
checkpoints that already exist, so eleven generations of history can be scored retroactively and the
series exists today instead of starting at the next generation. And the trainers are on the loop's
critical path; this is a read-only observer that cannot break a run.

**Deliberately numpy rather than torch.** A checkpoint is a flat `float32` blob and a JSON sidecar --
dense layers with three activations -- so a forward pass is three matrix multiplies. That needs no
GPU, no CUDA build, and no agreement with whatever the trainer happened to be using. The arithmetic
mirrors `@games/net`, which is what the search actually runs.

The metric definitions are copied from the trainers on purpose, including the awkward parts: the
policy head is scored on the *masked* cross entropy, because PUCT renormalises over the legal moves
and never sees a raw softmax, and the mask is `pi > 0` -- what the search visited, since legality is
not recorded in the dataset.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from read_dataset import load_window  # noqa: E402


def forward(layers: list[dict], weights: list[tuple[np.ndarray, np.ndarray]], x: np.ndarray) -> np.ndarray:
    """A dense chain, in float64.

    Float64 rather than the float32 the weights are stored in, for the same reason `@games/net`
    widens them: it is what the trainer computed in, and a scorer that disagreed with the trainer in
    the fourth decimal would waste somebody's afternoon. The cost is irrelevant here -- this runs
    once per checkpoint, not once per leaf.
    """
    out = x.astype(np.float64)
    for layer, (w, b) in zip(layers, weights):
        out = out @ w.T + b
        if layer["activation"] == "relu":
            np.maximum(out, 0, out=out)
        elif layer["activation"] == "tanh":
            np.tanh(out, out=out)
    return out


def in_chunks(layers, weights, x, rows: int = 65536):
    """The policy head is 719 -> 512 -> 512 -> 238; the intermediates are wider than the input."""
    return np.concatenate([forward(layers, weights, x[i : i + rows]) for i in range(0, len(x), rows)])


def score_value(pred: np.ndarray, z: np.ndarray) -> dict:
    """Identical to `report` in train_value.py, so the numbers are directly comparable to its logs."""
    mse = float(np.mean((pred - z) ** 2))
    decided = z != 0
    sign = float(np.mean(np.sign(pred[decided]) == np.sign(z[decided]))) if decided.any() else float("nan")
    corr = float(np.corrcoef(pred, z)[0, 1]) if np.std(pred) > 0 else float("nan")
    return {"mse": mse, "sign": sign, "corr": corr}


def score_policy(logits: np.ndarray, pi: np.ndarray, temperature: float = 1.0) -> dict:
    """Identical to `evaluate` in train_policy.py, masked the same way and for the same reason."""
    logits = logits / temperature
    legal = pi > 0

    # Log-softmax over everything, for the unmasked figure.
    shifted = logits - logits.max(axis=1, keepdims=True)
    raw_log = shifted - np.log(np.exp(shifted).sum(axis=1, keepdims=True))
    raw_ce = float(-(pi * raw_log).sum() / len(pi))

    # And again over the legal slots only. `-inf` on the rest, then the same trick the trainer uses:
    # a masked slot has log-probability -inf and a target of exactly 0, and `0 * -inf` is NaN.
    masked_logits = np.where(legal, logits, -np.inf)
    m = masked_logits - np.nanmax(np.where(legal, masked_logits, -np.inf), axis=1, keepdims=True)
    exp = np.where(legal, np.exp(m), 0.0)
    masked_log = np.where(legal, m - np.log(exp.sum(axis=1, keepdims=True)), 0.0)
    masked_ce = float(-np.where(legal, pi * masked_log, 0.0).sum() / len(pi))

    best = pi.argmax(axis=1)
    order = np.argsort(-np.where(legal, masked_log, -np.inf), axis=1)
    top1 = float(np.mean(order[:, 0] == best))
    top5 = float(np.mean((order[:, :5] == best[:, None]).any(axis=1)))
    mass = float(np.mean(np.exp(masked_log[np.arange(len(pi)), best])))
    return {"ce": masked_ce, "raw": raw_ce, "top1": top1, "top5": top5, "mass": mass}


def uniform_over_visited(pi: np.ndarray) -> float:
    """What the search's prior costs with no network at all -- the bar the policy head has to clear."""
    visited = (pi > 0).sum(axis=1)
    return float(np.mean(np.log(visited)))


def score(checkpoint: Path, data) -> dict:
    sidecar = json.loads((checkpoint / "model.json").read_text())
    if sidecar.get("kind") == "dual":
        raise SystemExit(f"{checkpoint}: dual checkpoints are not supported here yet")

    flat = np.fromfile(checkpoint / sidecar["file"], dtype="<f4")
    if flat.size != sidecar["parameters"]:
        raise SystemExit(f"{checkpoint}: {flat.size} parameters on disk, sidecar claims {sidecar['parameters']}")

    layers, weights, at = sidecar["layers"], [], 0
    for layer in layers:
        n_in, n_out = layer["in"], layer["out"]
        w = flat[at : at + n_out * n_in].reshape(n_out, n_in).astype(np.float64)
        at += n_out * n_in
        b = flat[at : at + n_out].astype(np.float64)
        at += n_out
        weights.append((w, b))
    if at != flat.size:
        raise SystemExit(f"{checkpoint}: read {at} of {flat.size} parameters")

    if layers[0]["in"] != data.x.shape[1]:
        raise SystemExit(
            f"{checkpoint} takes {layers[0]['in']} features, the holdout has {data.x.shape[1]} -- "
            "the encoding changed between them and they cannot be compared"
        )

    kind = sidecar.get("kind", "value")
    out = in_chunks(layers, weights, data.x)
    if kind == "policy":
        got = score_policy(out, data.pi, sidecar.get("temperature", 1.0))
        got["uniform_over_visited"] = uniform_over_visited(data.pi)
        got["excess"] = got["uniform_over_visited"] - got["ce"]
    else:
        got = score_value(out[:, 0], data.z)
        # The two fixed references, on these same rows. Without them the numbers are only comparable
        # to each other; with them they are comparable to something that cannot move at all.
        got["heuristic_mse"] = float(np.mean((data.h - data.z) ** 2))
        got["search_q_mse"] = float(np.mean((data.q - data.z) ** 2)) if not np.allclose(data.q, 0) else None
        got["vs_heuristic"] = got["mse"] / got["heuristic_mse"]
    got["kind"] = kind
    return got


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("checkpoint", help="a checkpoint directory, or a models/ directory with --all")
    parser.add_argument("holdout", nargs="+", help="dataset directories, never trained on")
    parser.add_argument("--all", action="store_true",
                        help="score every checkpoint under the directory, oldest generation first")
    parser.add_argument("--kind", choices=("value", "policy"),
                        help="with --all, score only this head. A models/ directory holds both, and "
                             "they are scored on different metrics, so mixing them reads as noise.")
    parser.add_argument("--json", help="write the scores here as well as printing them")
    args = parser.parse_args()

    data = load_window([Path(d) for d in args.holdout])
    games = len(np.unique(data.meta[:, 0]))
    print(f"holdout: {data.x.shape[0]:,} positions from {games:,} games, "
          f"{data.x.shape[1]} features\n")

    root = Path(args.checkpoint)
    if args.all:
        found = sorted(
            (d for d in root.iterdir() if (d / "model.json").exists()),
            # gen10 must sort after gen9, so on the number rather than the string.
            key=lambda d: (int("".join(c for c in d.name.split("-")[0] if c.isdigit()) or -1), d.name),
        )
    else:
        found = [root]
    if args.kind:
        found = [d for d in found
                 if json.loads((d / "model.json").read_text()).get("kind", "value") == args.kind]
    if not found:
        raise SystemExit(f"no checkpoints under {root}")

    out = {}
    for checkpoint in found:
        got = score(checkpoint, data)
        out[checkpoint.name] = got
        if got["kind"] == "policy":
            print(f"  {checkpoint.name:<18} ce {got['ce']:.4f}  excess {got['excess']:+.4f}  "
                  f"top1 {got['top1']:6.1%}  top5 {got['top5']:6.1%}")
        else:
            print(f"  {checkpoint.name:<18} mse {got['mse']:.4f}  sign {got['sign']:6.1%}  "
                  f"corr {got['corr']:+.3f}  vs heuristic {got['vs_heuristic']:.4f}")

    if out and next(iter(out.values()))["kind"] != "policy":
        h = next(iter(out.values()))["heuristic_mse"]
        print(f"\n  the fixed references on these same rows: heuristic mse {h:.4f}")
        q = next(iter(out.values()))["search_q_mse"]
        if q is not None:
            print(f"  {'':>42}search q mse {q:.4f}")
        print("  These cannot move. Any change above is the network, not the task.")

    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=2) + "\n")
        print(f"\n  wrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
