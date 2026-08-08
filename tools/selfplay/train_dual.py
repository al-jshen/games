"""One trunk, two heads, trained together. AlphaZero's architecture, and the reason for it.

The two heads have been trained as separate networks until now, which was a build-order artifact
rather than a design: the value head existed first as the gate on the whole project, and the policy
head was added as a mirror of it. Separate is not what the reference implementations do, and
AlphaGo Zero's own ablation is the argument -- a shared trunk with two heads (`dual-res`) beat two
separate towers (`sep-res`) on elo, with lower value error and no loss of move accuracy.

**The asymmetry here is the strongest version of that case.** The value head has one label per game,
so 2.28M rows carry ~20,000 independent targets and capacity actively hurts it -- trained alone it
peaked at 32 hidden units and got worse from there. The policy head has one target per row, 2.28M of
them, and capacity helped monotonically up to 512x512 without saturating. A shared trunk is exactly
the mechanism for letting the abundant signal shape features the starved one reuses.

Which makes the question not "shared or separate" but **how wide the shared trunk has to be**. The
cost of sharing is that the value head stops choosing its own size: today's value network is 719->32
and 23,040 multiply-adds, evaluated at every one of ~300 leaves per move. A 256-wide trunk is ten
times that whether or not the policy head is called. So this sweeps the width, and the two numbers
worth reading off are whether the value head beats 0.8227 at any of them, and how narrow the trunk
can get before the policy head stops clearing a uniform prior.

    python3 tools/selfplay/train_dual.py .data/gen0-25k --save .data/models/dual-gen0
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
from checkpoint import save_dual  # noqa: E402
from read_dataset import load_window  # noqa: E402
from train_policy import calibrate, cross_entropy, evaluate as policy_metrics, split_test  # noqa: E402
from train_value import pick_device, report as value_report, resident, split_by_game  # noqa: E402

torch.manual_seed(7)
np.random.seed(7)

WIDTHS = (32, 64, 128, 256)


class Dual(nn.Module):
    """Trunk, then a value head and a policy head off the same features.

    `forward` returns both; `value_only` runs the trunk and stops. That split is not a micro
    optimisation -- the value is wanted at every leaf and the policy only where priors are computed,
    which under root-only PUCT is once per move against three hundred times. The policy head is 20%
    of a forward pass at a 256-wide trunk, so not calling it is 20% off the hot path.
    """

    def __init__(self, features: int, slots: int, width: int, depth: int = 1):
        super().__init__()
        layers: list[nn.Module] = [nn.Linear(features, width), nn.ReLU()]
        for _ in range(depth - 1):
            layers += [nn.Linear(width, width), nn.ReLU()]
        self.trunk = nn.Sequential(*layers)
        self.value = nn.Sequential(nn.Linear(width, 1), nn.Tanh())
        self.policy = nn.Linear(width, slots)

    def value_only(self, x: torch.Tensor) -> torch.Tensor:
        return self.value(self.trunk(x)).squeeze(-1)

    def forward(self, x: torch.Tensor):
        h = self.trunk(x)
        return self.value(h).squeeze(-1), self.policy(h)


class ValueView(nn.Module):
    """Presents the value path as a plain module, so the existing metric code can score it."""

    def __init__(self, dual: Dual):
        super().__init__()
        self.dual = dual

    def forward(self, x):
        return self.dual.value_only(x)


class PolicyView(nn.Module):
    """The same for the policy path, so `train_policy`'s masked and calibrated metrics apply."""

    def __init__(self, dual: Dual):
        super().__init__()
        self.dual = dual

    def forward(self, x):
        return self.dual.policy(self.dual.trunk(x))


def fit(width, slots, x_train, v_train, pi_train, x_test, v_test, pi_test,
        epochs=60, decay=1e-4, batch=8192, lr=1e-3, policy_weight=1.0):
    """Both heads at once, on one loss.

    `mse + w * cross_entropy`, which is AlphaZero's `(z-v)^2 - pi.log p` with a knob on the second
    term. The knob exists because the two are not on the same scale here -- mean squared error lands
    near 0.83 and cross entropy near 2.5 -- so equal weighting is a choice about their gradients
    rather than a neutral default, and it is worth being able to move.

    Early stopping is on the *value* head's held-out error, deliberately. The point of this
    architecture is whether the policy's abundant signal helps the starved head; stopping on the
    joint loss would let the policy term, which is both larger and easier to improve, decide when to
    stop and quietly optimise for the wrong one.
    """
    device = x_train.device
    model = Dual(x_train.shape[1], slots, width).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=decay, fused=device.type == "cuda")
    mse = nn.MSELoss()
    best, best_state, best_epoch = float("inf"), None, 0

    for epoch in range(epochs):
        model.train()
        order = torch.randperm(len(x_train), device=device)
        for i in range(0, len(order), batch):
            idx = order[i : i + batch]
            opt.zero_grad()
            v, logits = model(x_train[idx])
            (mse(v, v_train[idx]) + policy_weight * cross_entropy(logits, pi_train[idx])).backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            held = float(mse(model.value_only(x_test), v_test).item())
        if held < best:
            best, best_epoch = held, epoch + 1
            best_state = {k: v.clone() for k, v in model.state_dict().items()}

    if best_state is None:
        raise RuntimeError(f"width {width}: held-out value loss was never finite over {epochs} epochs")
    model.load_state_dict(best_state)
    model.eval()
    return model, best_epoch


def main(directories, device_name=None, batch=8192, epochs=60, save_to=None,
         value_lambda=0.6, policy_weight=1.0) -> int:
    data = load_window(directories)
    train_mask, test_mask = split_by_game(data)
    slots = data.pi.shape[1]
    print(f"{data.x.shape[0]:,} positions, {data.x.shape[1]} features, {slots} policy slots")
    print(f"  {train_mask.sum():,} train / {test_mask.sum():,} test, split by game")
    window = data.sidecar.get("window")
    if window and len(window) > 1:
        print(f"  window of {len(window)} generations:")
        for w in window:
            print(f"    {w['dir']:<28} {w['games']:>6,} games, {w['rows']:>9,} rows")

    z_test = data.z[test_mask]
    # The value target is the blend the single-head sweep settled on. Swept again below by capacity
    # rather than by lambda, because lambda is not the variable this file is about.
    target = (1 - value_lambda) * data.z[train_mask] + value_lambda * data.q[train_mask]
    device, (x_train, v_train, pi_train, x_test, v_test, pi_test) = resident(
        pick_device(device_name),
        data.x[train_mask], target, data.pi[train_mask],
        data.x[test_mask], z_test, data.pi[test_mask],
    )
    print(f"  training on {device}, batch {batch}, {epochs} epochs, "
          f"lambda={value_lambda:g}, policy weight={policy_weight:g}\n")

    heuristic = value_report("hand-written", data.h[test_mask], z_test)
    pi_held = data.pi[test_mask]
    floor = float(-np.sum(pi_held * np.log(np.clip(pi_held, 1e-12, None)), axis=1).mean())
    uniform = float(np.log(np.count_nonzero(pi_held, axis=1)).mean())
    print(f"  {'uniform prior':<22} ce {uniform:.4f}   (the bar for the policy head)")
    print(f"  {'perfect prior':<22} ce {floor:.4f}   (the floor)\n")

    cal_mask, score_mask = split_test(data.meta[test_mask, 0])
    cal = torch.from_numpy(np.flatnonzero(cal_mask)).to(x_test.device)
    scored = torch.from_numpy(np.flatnonzero(score_mask)).to(x_test.device)

    print("width   params    value mse   vs tiny-alone      policy ce   vs uniform   top1")
    results = {}
    for width in WIDTHS:
        started = time.monotonic()
        model, epoch = fit(width, slots, x_train, v_train, pi_train, x_test, v_test, pi_test,
                           epochs=epochs, batch=batch, policy_weight=policy_weight)
        with torch.no_grad():
            pred = model.value_only(x_test).cpu().numpy()
        value_mse = float(np.mean((pred - z_test) ** 2))

        head = PolicyView(model)
        temperature = calibrate(head, x_test[cal], pi_test[cal])
        policy = policy_metrics(head, x_test[scored], pi_test[scored], temperature=temperature)

        params = sum(p.numel() for p in model.parameters())
        results[width] = {"mse": value_mse, "policy": policy, "t": temperature,
                          "model": model, "epoch": epoch, "params": params}
        print(f"{width:>5} {params:>8,}   {value_mse:>9.4f}   {value_mse - 0.8227:>+13.4f}"
              f"   {policy['ce']:>12.4f}   {policy['ce'] - uniform:>+10.4f}   {policy['top1']:>5.1%}"
              f"   ({epoch}/{epochs}, {time.monotonic() - started:.0f}s)", flush=True)

    best_width = min(results, key=lambda w: results[w]["mse"])
    best = results[best_width]
    print()
    # The two questions this file exists to answer, stated rather than left to be read off the table.
    # A margin, not a sign. The batch-size sweep put a 0.002 spread on this metric squarely inside
    # the noise of which games land in the holdout, so anything under that is a tie reported as a
    # win. Saying "sharing helps" on 0.0016 is how a project talks itself into an architecture.
    alone, noise = 0.8227, 0.005
    if best["mse"] < alone - noise:
        print(f"  Sharing helps the value head: {best['mse']:.4f} at width {best_width} against {alone}")
        print("  for the 32-wide value network trained alone. The policy head's signal is doing work.")
    elif best["mse"] < alone + noise:
        print(f"  Sharing changes nothing for the value head: {best['mse']:.4f} at width {best_width}")
        print(f"  against {alone} trained alone, a gap well inside the noise of the holdout split.")
    else:
        print(f"  Sharing hurts the value head: {best['mse']:.4f} at width {best_width}, against")
        print(f"  {alone} trained alone. The joint objective is not paying for the wider trunk.")
    usable = [w for w in WIDTHS if results[w]["policy"]["ce"] < uniform]
    print(f"  The policy head clears a uniform prior at width {min(usable)} and up."
          if usable else "  No width gives a policy head that clears a uniform prior.")

    if save_to:
        save_dual(
            best["model"], save_to,
            kind="dual", width=best_width, value_lambda=value_lambda, policy_weight=policy_weight,
            temperature=best["t"], features=int(data.x.shape[1]), slots=int(slots),
            trained_on=[str(d) for d in directories],
            held_out={"value_mse": best["mse"], **{f"policy_{k}": v for k, v in best["policy"].items()}},
            baselines={"heuristic": heuristic["mse"], "value_alone": 0.8227,
                       "uniform_prior": uniform, "target_entropy": floor},
        )
        print(f"\n  Saved width {best_width} to {save_to}/, temperature {best['t']:.2f} included.")
    return 0 if best["mse"] < heuristic["mse"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("directories", nargs="+", default=[".data/gen0"],
                        help="one or more self-play datasets, oldest first")
    parser.add_argument("--device")
    parser.add_argument("--batch", type=int, default=8192)
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--lambda", dest="value_lambda", type=float, default=0.6,
                        help="value target blend; 0.6 is what the single-head sweep settled on")
    parser.add_argument("--policy-weight", type=float, default=1.0)
    parser.add_argument("--save")
    args = parser.parse_args()
    raise SystemExit(main(args.directories, args.device, args.batch, args.epochs, args.save,
                          args.value_lambda, args.policy_weight))
