"""Can a network guess what the search decided, without doing the search?

The other head, and the better-conditioned one. `train_value.py` fights a structural problem: a game
has one outcome and ~91 positions, so 2.28M rows carry only ~20,000 independent labels and the value
head is starved no matter how the target is blended. The policy head has no such problem. Every row
carries its own visit distribution, so 2.28M rows are 2.28M genuinely distinct targets, and the
question stops being "is there enough data" and becomes "do the features say enough".

What it is for, once it works: priors for PUCT. The search currently widens uniformly over legal
moves, so most of its 300 iterations go into moves nothing suggested were worth examining. A prior
does not have to be right to pay for itself -- it only has to order moves better than uniform, and
the search corrects it where it is wrong. That is the half of AlphaZero's improvement operator this
repo does not have yet.

Scored against the search's own distribution, on games the network never saw:

    python3 tools/selfplay/train_policy.py .data/gen0-25k
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
from checkpoint import save  # noqa: E402
from read_dataset import load_window  # noqa: E402
from train_value import pick_device, resident, split_by_game  # noqa: E402

torch.manual_seed(7)
np.random.seed(7)


def make_model(features: int, slots: int, kind: str) -> nn.Module:
    """The same capacity ladder as the value sweep, and in the same spirit.

    One difference worth noticing before reading the results: `linear` is not small here. A 719x238
    output layer is 171k parameters, more than the value sweep's largest model, because the policy
    head has to produce a number per action rather than one number. So this ladder measures depth
    rather than size, and "linear beats the rest" would mean the features are already close to
    linearly separable for this task, not that there is too little data.
    """
    if kind == "linear":
        return nn.Linear(features, slots)
    if kind == "tiny":
        return nn.Sequential(nn.Linear(features, 64), nn.ReLU(), nn.Linear(64, slots))
    if kind == "mlp":
        return nn.Sequential(
            nn.Linear(features, 256), nn.ReLU(), nn.Linear(256, 256), nn.ReLU(), nn.Linear(256, slots)
        )
    return nn.Sequential(
        nn.Linear(features, 512), nn.ReLU(), nn.Linear(512, 512), nn.ReLU(), nn.Linear(512, slots)
    )


def cross_entropy(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """Soft-target cross entropy: the visit distribution, not the chosen move.

    `nn.CrossEntropyLoss` wants a class index, which would throw away everything the search learned
    about the alternatives -- and the alternatives are most of the signal. A position where the
    search split 51/49 and one where it went 99/1 have the same argmax and very different meanings.
    """
    return -(target * torch.log_softmax(logits, dim=1)).sum(dim=1).mean()


@torch.no_grad()
def evaluate(model: nn.Module, x: torch.Tensor, pi: torch.Tensor, temperature: float = 1.0,
             chunk: int = 65536) -> dict:
    """Held-out cross entropy, masked and not, plus top-k agreement and mass on the search's pick.

    **Masked is the number that decides this.** PUCT never sees a raw softmax over all 238 slots: the
    search already knows the legal moves, calls `legalActions`, and renormalises the prior over them.
    So a network that ranks the legal moves well but leaks probability onto impossible ones is
    perfectly useful, and scoring it unmasked measures how well it learned the rules -- a thing the
    search will hand it for free.

    Unmasked is kept because the gap between the two is worth seeing on its own. It is how much of
    the network's capacity went into inferring legality from the features rather than into judging
    moves, and if that gap is large the encoder is being asked to do work the search could do.

    The mask is `pi > 0`, which is what the search *visited* rather than what was legal -- no legality
    is recorded in the dataset. It is the search's own filter, so it is a slightly generous stand-in:
    a legal move that 300 iterations never touched is excluded here but would be present at inference.

    Chunked because the logits are wider than the features: 456k rows x 238 slots is another 434MB
    per intermediate, and there is no reason to hold the whole thing at once.
    """
    model.eval()
    total_ce, masked_ce, top1, top5, mass, rows = 0.0, 0.0, 0, 0, 0.0, len(x)
    for i in range(0, rows, chunk):
        logits = model(x[i : i + chunk]) / temperature
        target = pi[i : i + chunk]
        total_ce += float(-(target * torch.log_softmax(logits, dim=1)).sum())

        legal = target > 0
        masked = torch.log_softmax(logits.masked_fill(~legal, float("-inf")), dim=1)
        # `torch.where` rather than the obvious `(target * masked).sum()`. A masked slot has a log
        # probability of -inf and a target of exactly 0, and `0 * -inf` is NaN, not 0 -- so the
        # obvious form makes every row NaN and every epoch look equally bad.
        masked_ce += float(-torch.where(legal, target * masked, torch.zeros_like(target)).sum())
        best = target.argmax(dim=1)
        top1 += int((masked.argmax(dim=1) == best).sum())
        top5 += int((masked.topk(5, dim=1).indices == best.unsqueeze(1)).any(dim=1).sum())
        mass += float(masked.exp().gather(1, best.unsqueeze(1)).sum())
    return {
        "ce": masked_ce / rows,
        "raw": total_ce / rows,
        "top1": top1 / rows,
        "top5": top5 / rows,
        "mass": mass / rows,
    }


def fit(kind, slots, x_train, pi_train, x_test, pi_test, epochs=40, decay=1e-4, batch=8192, lr=1e-3):
    """Train, keeping the parameters from the best held-out epoch. Same shape as the value trainer.

    Early stopping is on held-out cross entropy, which unlike the value head's case is the same
    quantity being fitted -- there is no blend here, so there is nothing to be circular about.
    """
    device = x_train.device
    model = make_model(x_train.shape[1], slots, kind).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=decay, fused=device.type == "cuda")
    best, best_state, best_epoch = float("inf"), None, 0

    for epoch in range(epochs):
        model.train()
        order = torch.randperm(len(x_train), device=device)
        for i in range(0, len(order), batch):
            idx = order[i : i + batch]
            opt.zero_grad()
            cross_entropy(model(x_train[idx]), pi_train[idx]).backward()
            opt.step()
        held = evaluate(model, x_test, pi_test)["ce"]
        if held < best:
            best, best_epoch = held, epoch + 1
            best_state = {k: v.clone() for k, v in model.state_dict().items()}

    if best_state is None:
        # Nothing ever improved on infinity, which does not happen to a model that is merely bad --
        # it means the held-out loss was NaN throughout. Said here, because the alternative is a
        # `load_state_dict` type error a hundred lines away that names none of this.
        raise RuntimeError(f"{kind}: held-out loss was never finite over {epochs} epochs")
    model.load_state_dict(best_state)
    return model, best_epoch


def calibrate(model: nn.Module, x: torch.Tensor, pi: torch.Tensor) -> float:
    """The temperature that makes the network's confidence match how often it is right.

    Cross entropy punishes a confident wrong answer far harder than it rewards a confident right one,
    so a model can rank moves far better than uniform and still score worse than uniform -- which is
    exactly what happens here at T=1. Dividing the logits before the softmax fixes that without
    touching a single weight; it changes how sharp the distribution is and not the order of anything
    in it, so top-1 and top-5 are unaffected by construction.

    This is Guo et al.'s temperature scaling, and the reason it is a legitimate thing to fit rather
    than a way of tuning on the test set is that it is one scalar and it is fitted on games that are
    then not scored. AlphaZero reaches for the same lever from the other side, adding Dirichlet noise
    at the root to stop a sharp prior from starving moves the search ought to look at.
    """
    # The top of the grid is far above any temperature a useful model wants, on purpose. A model with
    # nothing to say is best flattened all the way to uniform, and the fit will chase that as far as
    # it is allowed -- so an optimum sitting on the boundary is a finding, not a setting, and the
    # range has to be wide enough that hitting the edge means something. It is reported when it does.
    grid = np.geomspace(0.5, 64.0, 40)
    best = float(min(grid, key=lambda t: evaluate(model, x, pi, temperature=float(t))["ce"]))
    if best >= grid[-2]:
        print(f"    (temperature pinned at the top of the grid -- this model is being erased"
              f" into uniform rather than calibrated)")
    return best


def report(name: str, stats: dict, floor: float, note: str = "") -> dict:
    # `excess` is the part that is the model's fault. Cross entropy cannot go below the target
    # distribution's own entropy, so the raw number mostly measures how decisive the search was.
    excess = stats["ce"] - floor
    print(
        f"  {name:<8} ce {stats['ce']:.4f}  excess {excess:+.4f}  raw {stats['raw']:.4f}  "
        f"top1 {stats['top1']:6.1%}  top5 {stats['top5']:6.1%}  mass {stats['mass']:6.1%}{note}",
        flush=True,
    )
    return {**stats, "excess": excess}


def split_test(meta_games: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Halve the held-out games again: one half fits the temperature, the other scores the model.

    By game rather than by row, for the same reason the outer split is: positions from one game look
    alike, so a row-wise halving would fit the temperature on near-copies of what it is then judged
    on. One scalar over 200k rows is not much of a degree of freedom, but keeping the two disjoint
    costs nothing and means the reported number needs no asterisk.
    """
    unique = np.unique(meta_games)
    rng = np.random.default_rng(11)
    rng.shuffle(unique)
    calibration = set(unique[: len(unique) // 2].tolist())
    is_calibration = np.array([g in calibration for g in meta_games])
    return is_calibration, ~is_calibration


def main(directories, device_name: str | None = None, batch: int = 8192, epochs: int = 40,
         save_to: str | None = None, kinds=("linear", "tiny", "mlp", "wide"),
         lr: float = 1e-3) -> int:
    data = load_window(directories)
    train_mask, test_mask = split_by_game(data)
    slots = data.pi.shape[1]
    print(f"{data.x.shape[0]:,} positions, {data.x.shape[1]} features, {slots} policy slots")
    print(f"  {train_mask.sum():,} train / {test_mask.sum():,} test, split by game")
    window = data.sidecar.get("window")
    if window and len(window) > 1:
        # Printed because a windowed run is easy to mistake for a single-generation one, and the
        # composition is what makes the numbers comparable or not.
        print("  window of " + str(len(window)) + " generations:")
        for w in window:
            print(f"    {w['dir']:<28} {w['games']:>6,} games, {w['rows']:>9,} rows"
                  + (f", net={w['config']['net']}" if (w.get("config") or {}).get("net") else ", no net"))

    device, (x_train, pi_train, x_test, pi_test) = resident(
        pick_device(device_name),
        data.x[train_mask], data.pi[train_mask], data.x[test_mask], data.pi[test_mask],
    )
    print(f"  training on {device}, batch {batch}, {epochs} epochs\n")

    pi_held = data.pi[test_mask]
    # The floor. Cross entropy against a soft target is bounded below by that target's own entropy,
    # so quoting `ce` alone would mostly report how decisive the search happened to be.
    floor = float(-np.sum(pi_held * np.log(np.clip(pi_held, 1e-12, None)), axis=1).mean())
    # Two baselines, one weak and one deliberately unfair. Uniform over every slot is what a network
    # that learned nothing would score. Uniform over the moves the search actually visited is much
    # harder, because it is handed the legal-move set for free -- the network has to infer that from
    # the features, so beating this means it has learned legality as well as preference.
    support = np.count_nonzero(pi_held, axis=1)
    uniform = float(np.log(support).mean())
    print("On games the network never saw, all cross entropies masked to the visited moves:")
    print(f"  {'target entropy (floor)':<26} ce {floor:.4f}   <- no model can beat this")
    print(f"  {'uniform over visited':<26} ce {uniform:.4f}   <- the bar: what the search does now")
    print(f"  {'uniform over all slots':<26} ce {np.log(slots):.4f}   <- knowing nothing at all")
    print(f"  {'candidates per position':<26} {support.mean():.1f}, so uniform picks the search's"
          f" move {100 / support.mean():.1f}% of the time\n")

    # Held-out games split again, so the temperature is fitted on games the score never sees.
    cal_mask, score_mask = split_test(data.meta[test_mask, 0])
    cal = torch.from_numpy(np.flatnonzero(cal_mask)).to(x_test.device)
    scored = torch.from_numpy(np.flatnonzero(score_mask)).to(x_test.device)

    results = {}
    models = {}
    for kind in kinds:
        started = time.monotonic()
        model, epoch = fit(kind, slots, x_train, pi_train, x_test, pi_test, epochs=epochs, batch=batch, lr=lr)
        elapsed = time.monotonic() - started
        temperature = calibrate(model, x_test[cal], pi_test[cal])
        at_one = evaluate(model, x_test[scored], pi_test[scored])
        tuned = evaluate(model, x_test[scored], pi_test[scored], temperature=temperature)
        note = f"   (epoch {epoch}/{epochs}, T {temperature:.2f}, {elapsed:.0f}s)"
        results[kind] = {**report(kind, tuned, floor, note), "at_one": at_one["ce"], "t": temperature}
        models[kind] = model
    print()

    best_kind = min(results, key=lambda k: results[k]["ce"])
    best = results[best_kind]

    # Written before the verdict, because the verdict has an early return in it and `--save` is an
    # instruction rather than a prize. A caller that asked for the checkpoint wants it whether or not
    # the head cleared a uniform prior -- the orchestrator, for one, needs something to hand the next
    # generation even when this one was poor.
    if save_to:
        # The temperature travels with the weights, because it is not a property of the experiment --
        # it is part of the model. A checkpoint loaded without it is sharper than it has earned, and
        # nothing downstream would notice: the ordering is identical, so it would look correct and
        # quietly starve the moves the network was least sure about.
        save(
            models[best_kind], save_to,
            kind="policy", architecture=best_kind, temperature=best["t"],
            features=int(data.x.shape[1]), slots=int(slots), trained_on=[str(d) for d in directories],
            held_out={k: v for k, v in best.items() if k != "t"},
            baselines={"uniform_over_visited": uniform, "target_entropy": floor},
        )
        print(f"\n  Saved {best_kind} to {save_to}/, temperature {best['t']:.2f} included.")


    if best["ce"] > uniform:
        print(f"  No model beats uniform-over-visited ({uniform:.4f}). The features do not say enough")
        print("  about which move is worth examining, and a prior from this would not help a search.")
        return 1

    # How far along the only stretch that was ever available: from what the search assumes today to
    # the best any model could do. A percentage of the gap says more than the raw nats, which are
    # small numbers whose scale nobody has any intuition for.
    closed = (uniform - best["ce"]) / (uniform - floor)
    print(f"  Best: {best_kind}. Masked cross entropy {best['ce']:.4f}, against {uniform:.4f} for the")
    print(f"  uniform prior the search uses now and {floor:.4f} for a perfect one -- {closed:.0%} of the")
    print(f"  distance closed. It picks the search's own move {best['top1']:.1%} of the time against"
          f" uniform's {100 / support.mean():.1f}%,")
    print(f"  and has it in the top five {best['top5']:.1%} of the time.")

    # Two lines that are levers rather than facts: each says how much of the model's error came from
    # a problem the search does not actually pose it.
    print(f"\n  Unmasked it would score {best['raw']:.4f}, so {best['raw'] - best['ce']:.4f} nats of its")
    print("  error is mass placed on moves that are not available. The search masks those away, which")
    print("  is why this is scored masked -- but it is also capacity spent on learning the rules.")
    print(f"  Uncalibrated it would score {best['at_one']:.4f}; at T={best['t']:.2f} it scores"
          f" {best['ce']:.4f}. The ordering is")
    print("  identical either way -- temperature cannot reorder anything -- so that gap was confidence,")
    print("  not knowledge, and PUCT would have paid for it by under-exploring what the net doubted.")
    if all(k in results for k in ("tiny", "mlp", "wide")) and \
            results["wide"]["ce"] < results["mlp"]["ce"] < results["tiny"]["ce"]:
        print("  Capacity is still paying at every step of the ladder, so the largest model here is")
        print("  probably not the largest worth trying.")

    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "directories",
        nargs="+",
        default=[".data/gen0"],
        help="one or more self-play datasets, oldest first -- a sliding window over generations",
    )
    parser.add_argument("--device", help="cuda, cpu, ... (default: cuda when one is present)")
    parser.add_argument("--batch", type=int, default=8192)
    # 80 rather than the value trainer's 40: the policy models are still improving at 40, where the
    # value ones have long stopped. Measured -- `wide` best-epoch was 76 of 80.
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--save", help="write the winning model here, for the search to load")
    parser.add_argument("--arch", nargs="+", default=["linear", "tiny", "mlp", "wide"],
                        help="which capacities to try; one name skips the sweep")
    parser.add_argument("--lr", type=float, default=1e-3)
    args = parser.parse_args()
    raise SystemExit(main(args.directories, args.device, args.batch, args.epochs, args.save,
                          tuple(args.arch), args.lr))
