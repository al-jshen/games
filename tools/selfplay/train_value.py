"""Does a learned value beat the hand-written one?

The cheapest question that decides whether the rest of the machinery is worth building. Everything
downstream -- a policy head, PUCT, the self-play loop -- rests on a network being able to judge a
position from these features. If it cannot beat a hundred lines of heuristic at that, the features
are wrong and the loop would be built on sand.

Deliberately small: an MLP, minutes rather than hours, no tuning. The bar is not "good", it is
"better than what we already have", and it is measured on games the network never saw.

It also sweeps the *value target*. The obvious target is the game's outcome, but every position in a
game carries the same one, so a hundred rows share a single bit and the effective sample size is the
number of games rather than of positions. The search's own estimate of each position varies row by
row, so mixing the two trades a little bias for a lot of variance. This is Leela Chess Zero's
`q_ratio`: `target = q_ratio * Q + (1 - q_ratio) * Z`, and their reasoning is the same one -- a single
blunder flips Z for every position in the game. Whether it helps *here* is measured, not assumed.

    python3 tools/selfplay/train_value.py .data/gen0
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).parent))
from checkpoint import save, warm_start  # noqa: E402
from read_dataset import load_window  # noqa: E402

torch.manual_seed(7)
np.random.seed(7)


def pick_device(requested: str | None) -> torch.device:
    """Where the sweep runs, and what a GPU is actually worth here.

    Not FLOPs. These models are small enough that a step costs more in launching kernels than in
    arithmetic -- on 96 CPU cores the larger net and the tiny one ran at the same speed, which is the
    signature of overhead rather than work. What a GPU buys is that all 6.6GB of the split fits in
    its memory, so every batch is gathered where the weights already are.

    Which is also why the batch size matters more here than it would on a machine doing real work per
    step: at 256 almost all of the wall clock is overhead that a larger batch simply deletes.
    """
    if requested:
        return torch.device(requested)
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def resident(device, *arrays):
    """Move a split onto the device once and leave it there for the whole sweep.

    Copying batches across as they are needed would spend more time on the bus than on the
    arithmetic, since the step that consumes a batch takes microseconds.

    The fallback exists because the amount that has to fit scales with the dataset and the dataset is
    the thing we keep growing. Falling back is much better than discovering at 25,000 games that the
    sweep no longer starts. Returns the device actually used, which may not be the one asked for.
    """
    try:
        return device, [torch.from_numpy(a).to(device) for a in arrays]
    except torch.cuda.OutOfMemoryError:
        need = sum(a.nbytes for a in arrays) / 1e9
        print(f"  {device} cannot hold {need:.1f} GB of split -- falling back to CPU")
        torch.cuda.empty_cache()
        return torch.device("cpu"), [torch.from_numpy(a) for a in arrays]


def split_by_game(data, holdout=0.2):
    """Split on *games*, not positions.

    Positions from one game share an outcome and look alike, so splitting on rows would put near
    copies of a training position in the test set and report a score that does not exist.
    """
    games = data.meta[:, 0]
    unique = np.unique(games)
    # An empty dataset is readable by design -- generation publishes one before playing a game, so
    # that a kill in the first second still leaves something coherent -- which means a trainer can
    # be pointed at one. Said plainly here, because the alternative is what it used to do: build a
    # float64 mask out of an empty list and die on `~` with a TypeError about casting rules, several
    # frames from anything that names the dataset.
    if len(unique) < 2:
        raise SystemExit(
            f"  dataset has {data.x.shape[0]:,} rows across {len(unique)} game(s) -- nothing to "
            f"split into train and test.\n  Self-play probably failed or was killed early; check "
            f"its log and regenerate before training."
        )
    rng = np.random.default_rng(7)
    rng.shuffle(unique)
    cut = max(1, min(int(len(unique) * (1 - holdout)), len(unique) - 1))
    train_games = set(unique[:cut].tolist())
    train = np.array([g in train_games for g in games], dtype=bool)
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


def report(name: str, pred: np.ndarray, z: np.ndarray, note: str = "") -> dict:
    mse = float(np.mean((pred - z) ** 2))
    # Sign agreement is the number that matters for a search: does it know who is winning?
    decided = z != 0
    accuracy = float(np.mean(np.sign(pred[decided]) == np.sign(z[decided]))) if decided.any() else float("nan")
    corr = float(np.corrcoef(pred, z)[0, 1]) if np.std(pred) > 0 else float("nan")
    print(f"  {name:<22} mse {mse:.4f}   sign {accuracy:6.1%}   corr {corr:+.3f}{note}", flush=True)
    return {"mse": mse, "accuracy": accuracy, "corr": corr}


def fit(kind, x_train, target_train, x_test, z_test, epochs=40, decay=1e-4, batch=8192,
        lr=1e-3, init=None):
    """Train, and keep the parameters from the best held-out epoch rather than the last.

    Without early stopping this measures how thoroughly a model can memorise 300 games, which is not
    the question.

    `target_train` is what the model is fitted to and may be a blend; `z_test` is the real outcome
    and is what it is early-stopped and scored on. Those must not be the same quantity, or a blend
    would be judged by how well it reproduces itself.

    The default was 256 until it was measured. A larger batch at a fixed epoch count is fewer
    parameter updates, not merely bigger ones -- 8192 is 8,900 where 256 is 284,800 -- so the
    expectation was that it would underfit, and the expectation was wrong. Sweeping 256 / 1024 / 4096
    / 16384 on the linear model moved held-out MSE only between 0.8351 and 0.8371, a spread far
    inside the noise of which games land in the holdout, while the run went from 197s to 3s. Scaling
    the learning rate with the batch, the usual remedy, was tried in the same sweep and helped
    nowhere: Adam already normalises by gradient scale, so `lr` stays at 1e-3.

    Then the whole 12-config sweep was run at both 256 and 4096, and the linear row agreed to within
    0.0018 with lambda=1 identical to four decimals -- so this is a free speedup rather than a
    different experiment.
    """
    device = x_train.device
    model = make_model(x_train.shape[1], kind)
    if init:
        # Warm start, before the move to the device: the checkpoint reader works in numpy and the
        # copy is one-off, so there is nothing to gain from doing it on the GPU.
        print(warm_start(model, init), flush=True)
    model = model.to(device)
    # `fused` on CUDA for the same reason the device was chosen: a step here is launch-bound, and the
    # fused optimiser collapses a per-parameter kernel each into one. Same Adam, same update.
    opt = torch.optim.Adam(
        model.parameters(), lr=lr, weight_decay=decay, fused=device.type == "cuda"
    )
    loss_fn = nn.MSELoss()
    best, best_state, best_epoch = float("inf"), None, 0
    if init:
        # Score the warm-started weights before training touches them, so epoch zero competes.
        #
        # Without this the sweep can only ever return a *trained* epoch, and a warm start makes that
        # a real hazard rather than a formality: the starting point is now a model that already
        # works, and a couple of epochs at this learning rate can leave it worse than it began. The
        # gate would catch that and reject the generation, which is a whole generation spent to
        # learn nothing. Keeping the initial weights when nothing beats them makes a warm start
        # incapable of going backwards on the holdout it is judged by.
        model.eval()
        with torch.no_grad():
            best = float(loss_fn(model(x_test).squeeze(-1), z_test).item())
        best_state = {k: v.clone() for k, v in model.state_dict().items()}

    for epoch in range(epochs):
        model.train()
        order = torch.randperm(len(x_train), device=device)
        for i in range(0, len(order), batch):
            idx = order[i : i + batch]
            opt.zero_grad()
            loss_fn(model(x_train[idx]).squeeze(-1), target_train[idx]).backward()
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
        return model(x_test).squeeze(-1).cpu().numpy(), best_epoch, model


def main(directories, device_name: str | None = None, batch: int = 8192, epochs: int = 40,
         save_to: str | None = None, kinds=("linear", "tiny", "mlp"),
         lambdas=None, lr: float = 1e-3, init: str | None = None) -> int:
    data = load_window(directories)
    train_mask, test_mask = split_by_game(data)
    print(f"{data.x.shape[0]:,} positions, {data.x.shape[1]} features")
    print(f"  {train_mask.sum():,} train / {test_mask.sum():,} test, split by game")
    window = data.sidecar.get("window")
    if window and len(window) > 1:
        # Printed because a windowed run is easy to mistake for a single-generation one, and the
        # composition is what makes the numbers comparable or not.
        print("  training on " + str(len(window)) + " datasets:")
        for w in window:
            print(f"    {w['dir']:<28} {w['games']:>6,} games, {w['rows']:>9,} rows"
                  + (f", net={w['config']['net']}" if (w.get("config") or {}).get("net") else ", no net"))

    z_test = data.z[test_mask]
    device, (x_train, z_train, q_train, x_test, z_test_t) = resident(
        pick_device(device_name),
        data.x[train_mask], data.z[train_mask], data.q[train_mask], data.x[test_mask], z_test,
    )
    # From the shapes, not by re-indexing: `data.x[mask]` is a 5GB copy and it has been made already.
    gb = data.x.shape[0] * data.x.shape[1] * 4 / 1e9
    print(f"  training on {device}, {gb:.1f} GB of features resident, batch {batch}, {epochs} epochs\n")

    games = len(np.unique(data.meta[train_mask, 0]))
    print(f"  {games} training games. Every position in one shares a single outcome, so against a")
    print("  pure outcome target the effective sample size sits far nearer that than the row count.\n")

    print("On games neither the network nor the heuristic has seen:")
    heuristic = report("hand-written", data.h[test_mask], z_test)
    # Predicting nothing is the floor. A model that only learned the base rate would still look
    # respectable on mean squared error alone.
    report("always zero", np.zeros_like(z_test), z_test)

    # The search's own estimate, scored as if it were a prediction. Worth seeing before using it as
    # a target: this is the ceiling for the part of the signal that comes from `q`.
    has_q = not np.allclose(data.q, 0)
    search_q = None
    if has_q:
        search_q = report("search value (q)", data.q[test_mask], z_test)
        # How much of `q` is just the heuristic wearing a hat. The search evaluates leaves with the
        # heuristic, so a blend that leans on `q` partly distils it -- worth knowing how much.
        print(f"  {'q vs heuristic':<22} corr {np.corrcoef(data.q, data.h)[0, 1]:+.3f}"
              "   (they share the leaf evaluator, so overlap is expected)")
    else:
        print("  no search values in this dataset -- outcome target only")
    print()

    # 0 is the pure game outcome, 1 the pure search estimate. In between trades the outcome's
    # unbiasedness for the search estimate's much lower variance.
    # Swept unless the caller fixed them. A loop turning the crank every few hours does not
    # need twelve configurations per generation; an experiment does.
    lambdas = (lambdas if lambdas is not None else [0.0, 0.3, 0.6, 1.0]) if has_q else [0.0]
    results = {}
    models = {}
    for kind in kinds:
        for lam in lambdas:
            target = (1 - lam) * z_train + lam * q_train
            started = time.monotonic()
            pred, epoch, models[(kind, lam)] = fit(
                kind, x_train, target, x_test, z_test_t, epochs=epochs, batch=batch, lr=lr,
                init=init,
            )
            # The epoch is worth seeing next to the score: a best epoch equal to the budget means the
            # run was still improving when it ran out, and the number below is a floor, not a result.
            note = f"   (epoch {epoch}/{epochs}, {time.monotonic() - started:.0f}s)"
            results[(kind, lam)] = report(f"learned ({kind}, l={lam:g})", pred, z_test, note)
            results[(kind, lam)]["epoch"] = epoch
        print()

    best_kind, best_lambda = min(results, key=lambda k: results[k]["mse"])
    best = results[(best_kind, best_lambda)]

    if save_to:
        # The sweep's whole output used to be printed text. Saving the winner is what turns it from a
        # question answered into a thing the search can use -- and the losing eleven are worth nothing
        # to anyone, so only the winner goes down.
        save(
            models[(best_kind, best_lambda)], save_to,
            kind="value", architecture=best_kind, value_lambda=best_lambda,
            features=int(data.x.shape[1]), trained_on=[str(d) for d in directories], games=int(games),
            held_out=dict(best),
            baselines={"heuristic": heuristic["mse"],
                       "search_q": search_q["mse"] if search_q else None},
        )
        print(f"  Saved the winner to {save_to}/ -- {best_kind}, lambda={best_lambda:g}.\n")

    # Both comparisons below need the sweep to have actually run. A caller that fixed the blend --
    # the loop does, having settled it once -- has not asked whether blending helps and must not be
    # handed an answer keyed on a lambda that was never trained.
    swept = has_q and len(lambdas) > 1
    if swept and best_lambda == 0:
        # The sweep ran and the outcome still won. Worth saying plainly -- a blend that did not help
        # is a result, and leaving it implicit invites someone to add it again later.
        blended = min(results[(best_kind, l)]["mse"] for l in lambdas if l > 0)
        print(f"  Bootstrapping did not help: the pure outcome target won at {best['mse']:.4f},"
              f" against {blended:.4f} for the best blend.")
    elif swept and 0.0 in lambdas:
        # Did the blend earn its keep, holding capacity fixed? Comparing the best blend against the
        # best outcome-only model would let a lucky capacity take credit for the target.
        pure = results[(best_kind, 0.0)]["mse"]
        delta = (pure - best["mse"]) / pure
        verdict = "clear of" if delta > 0.02 else "inside the noise of"
        print(f"  Best target: l={best_lambda:g} at {best['mse']:.4f}, {delta:+.0%} against the pure"
              f" outcome's {pure:.4f} at the same capacity -- {verdict} it.")
    best_kind = f"{best_kind}, l={best_lambda:g}"
    print()

    gain = (heuristic["mse"] - best["mse"]) / heuristic["mse"]
    beats = best["mse"] < heuristic["mse"] and best["accuracy"] > heuristic["accuracy"]
    # Whether more parameters help, at each one's own best target. This is the diagnostic the linear
    # model is in the sweep for, and it is computed rather than asserted -- it was true at 1,200
    # games and false at 25,000, and a sentence that hardcodes either will eventually be a lie.
    # Only meaningful if both ends of the ladder were actually trained; a caller that fixed the
    # architecture has not asked this question and must not be told the answer.
    have_ladder = "linear" in kinds and "mlp" in kinds
    flat = min(results[("linear", l)]["mse"] for l in lambdas) if have_ladder else float("nan")
    deep = min(results[("mlp", l)]["mse"] for l in lambdas) if have_ladder else float("nan")
    capacity_hurts = have_ladder and flat < deep

    # A margin, not merely a win. Crossing over by one percent is inside the noise of which games
    # landed in the held-out split, and calling that a success is how a project talks itself into
    # building on a result that is not there.
    if beats and gain > 0.05:
        print(f"  The learned value wins ({best_kind}): {gain:.1%} lower error, better sign agreement.")
        print("  The features carry signal. A value head is worth building on.")
    elif beats:
        print(f"  The learned value edges ahead ({best_kind}) by {gain:.1%}, which is inside the noise.")
        print("  Signal, but not yet a result.")
    elif capacity_hurts:
        # Which way it failed matters, and the two call for opposite responses.
        print("  No model beats the heuristic yet, but the *linear* model beats the larger ones —")
        print("  the classic signature of too little data rather than bad features. With one label")
        print(f"  per game, {games} games is not enough to fit anything with capacity.")
        print("  Generate more games before touching the encoder.")
        return 1
    else:
        print("  No model beats the heuristic, and capacity is not the constraint.")
        print("  Suspect the features. Fix them before building the loop on top.")
        return 1

    # Said either way, because it is the reading that decides what to do next and it is easy to carry
    # a stale answer forward. Capacity hurting means the lever is more games; capacity helping means
    # the data has caught up with the model and a bigger one is finally worth trying.
    if not have_ladder:
        pass
    elif capacity_hurts:
        print(f"  Capacity still hurts -- linear {flat:.4f} against mlp {deep:.4f} -- so it remains")
        print("  data-bound: more games is the lever, not a different encoder.")
    else:
        print(f"  And capacity now helps -- mlp {deep:.4f} against linear {flat:.4f}, which reverses")
        print(f"  the reading at smaller sizes. {games:,} games is enough to fit parameters with.")
    return 0 if (beats and gain > 0.05) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "directories",
        nargs="+",
        default=[".data/gen0"],
        help="one or more self-play datasets, oldest first -- a sliding window over generations",
    )
    parser.add_argument("--device", help="cuda, cpu, ... (default: cuda when one is present)")
    parser.add_argument("--batch", type=int, default=8192, help="see fit() -- it was measured")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--save", help="write the winning model here, for the search to load")
    parser.add_argument("--arch", nargs="+", default=["linear", "tiny", "mlp"],
                        help="which capacities to try; one name skips the sweep")
    parser.add_argument("--lambda", dest="lambdas", nargs="+", type=float, default=None,
                        help="value target blends to try; one value skips the sweep")
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument(
        "--init",
        help="a checkpoint directory to start from instead of random initialisation. Ignored, with "
             "a note, if its architecture does not match -- so changing --arch mid-run is safe.",
    )
    args = parser.parse_args()
    raise SystemExit(main(args.directories, args.device, args.batch, args.epochs, args.save,
                          tuple(args.arch), args.lambdas, args.lr, args.init))
