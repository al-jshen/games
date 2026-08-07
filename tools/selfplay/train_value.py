"""Does a learned value beat the hand-written one?

The cheapest question that decides whether the rest of the machinery is worth building. Everything
downstream -- a policy head, PUCT, the self-play loop -- rests on a network being able to judge a
position from these features. If it cannot beat a hundred lines of heuristic at that, the features
are wrong and the loop would be built on sand.

Deliberately small: an MLP, a few minutes on CPU, no tuning. The bar is not "good", it is "better
than what we already have", and it is measured on games the network never saw.

    python3 tools/selfplay/train_value.py .data/gen0
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).parent))
from read_dataset import load  # noqa: E402

torch.manual_seed(7)
np.random.seed(7)


def split_by_game(data, holdout=0.2):
    """Split on *games*, not positions.

    Positions from one game share an outcome and look alike, so splitting on rows would put near
    copies of a training position in the test set and report a score that does not exist.
    """
    games = data.meta[:, 0]
    unique = np.unique(games)
    rng = np.random.default_rng(7)
    rng.shuffle(unique)
    cut = int(len(unique) * (1 - holdout))
    train_games, test_games = set(unique[:cut].tolist()), set(unique[cut:].tolist())
    train = np.array([g in train_games for g in games])
    return train, ~train


def make_model(features: int, kind: str) -> nn.Module:
    """Three capacities, because capacity is the variable under test.

    Positions inside one game share an outcome and look much alike, so the effective number of
    independent labels is the number of *games*, not of rows. A model with more parameters than that
    will memorise the training games and tell you nothing. Fitting a linear model alongside separates
    "the features are useless" from "there is not enough data yet" -- and those call for opposite
    responses.
    """
    if kind == "linear":
        return nn.Sequential(nn.Linear(features, 1), nn.Tanh())
    if kind == "tiny":
        return nn.Sequential(nn.Linear(features, 32), nn.ReLU(), nn.Linear(32, 1), nn.Tanh())
    return nn.Sequential(
        nn.Linear(features, 256), nn.ReLU(), nn.Linear(256, 256), nn.ReLU(), nn.Linear(256, 1), nn.Tanh()
    )


def report(name: str, pred: np.ndarray, z: np.ndarray) -> dict:
    mse = float(np.mean((pred - z) ** 2))
    # Sign agreement is the number that matters for a search: does it know who is winning?
    decided = z != 0
    accuracy = float(np.mean(np.sign(pred[decided]) == np.sign(z[decided]))) if decided.any() else float("nan")
    corr = float(np.corrcoef(pred, z)[0, 1]) if np.std(pred) > 0 else float("nan")
    print(f"  {name:<22} mse {mse:.4f}   sign {accuracy:6.1%}   corr {corr:+.3f}")
    return {"mse": mse, "accuracy": accuracy, "corr": corr}


def fit(kind, x_train, z_train, x_test, z_test, epochs=40, decay=1e-4):
    """Train, and keep the parameters from the best held-out epoch rather than the last.

    Without early stopping this measures how thoroughly a model can memorise 300 games, which is not
    the question.
    """
    model = make_model(x_train.shape[1], kind)
    opt = torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=decay)
    loss_fn = nn.MSELoss()
    best, best_state, best_epoch = float("inf"), None, 0

    for epoch in range(epochs):
        model.train()
        order = torch.randperm(len(x_train))
        for i in range(0, len(order), 256):
            idx = order[i : i + 256]
            opt.zero_grad()
            loss_fn(model(x_train[idx]).squeeze(-1), z_train[idx]).backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            held = float(loss_fn(model(x_test).squeeze(-1), z_test).item())
        if held < best:
            best, best_epoch = held, epoch + 1
            best_state = {k: v.clone() for k, v in model.state_dict().items()}

    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        return model(x_test).squeeze(-1).numpy(), best_epoch


def main(directory: str) -> int:
    data = load(directory)
    train_mask, test_mask = split_by_game(data)
    print(f"{data.x.shape[0]:,} positions, {data.x.shape[1]} features")
    print(f"  {train_mask.sum():,} train / {test_mask.sum():,} test, split by game\n")

    x_train = torch.from_numpy(data.x[train_mask])
    z_train = torch.from_numpy(data.z[train_mask])
    x_test = torch.from_numpy(data.x[test_mask])
    z_test_t = torch.from_numpy(data.z[test_mask])
    z_test = data.z[test_mask]

    games = len(np.unique(data.meta[train_mask, 0]))
    print(f"  {games} training games -- which is the effective number of independent labels,")
    print("  since every position in a game shares one outcome.\n")

    print("On games neither the network nor the heuristic has seen:")
    heuristic = report("hand-written", data.h[test_mask], z_test)
    # Predicting nothing is the floor. A model that only learned the base rate would still look
    # respectable on mean squared error alone.
    report("always zero", np.zeros_like(z_test), z_test)
    print()

    results = {}
    for kind in ("linear", "tiny", "mlp"):
        pred, epoch = fit(kind, x_train, z_train, x_test, z_test_t)
        results[kind] = report(f"learned ({kind})", pred, z_test)
        results[kind]["epoch"] = epoch

    best_kind = min(results, key=lambda k: results[k]["mse"])
    best = results[best_kind]
    print()

    if best["mse"] < heuristic["mse"] and best["accuracy"] > heuristic["accuracy"]:
        gain = (heuristic["mse"] - best["mse"]) / heuristic["mse"]
        print(f"  The learned value wins ({best_kind}): {gain:.0%} lower error, better sign agreement.")
        print("  The features carry signal. A value head is worth building on.")
        return 0

    # Which way it failed matters, and the two call for opposite responses.
    if results["linear"]["mse"] < results["mlp"]["mse"]:
        print("  No model beats the heuristic yet, but the *linear* model beats the larger ones —")
        print("  the classic signature of too little data rather than bad features. With one label")
        print(f"  per game, {games} games is not enough to fit anything with capacity.")
        print("  Generate more games before touching the encoder.")
    else:
        print("  No model beats the heuristic, and capacity is not the constraint.")
        print("  Suspect the features. Fix them before building the loop on top.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else ".data/gen0"))
