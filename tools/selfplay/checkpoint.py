"""Write a trained network somewhere the search can read it.

The search is TypeScript and the trainer is Python, so a checkpoint has to cross a language boundary.
`torch.save` cannot: it is pickled Python objects. So this uses the format the datasets already use --
a raw little-endian `float32` blob and a JSON sidecar describing it -- because there is no reason for
this repo to have two ways of handing arrays to another language, and the other one is already
documented and already read from both sides.

Deliberately only dense layers with one of three activations. A checkpoint that can express anything
needs an interpreter on the far side; this one needs about thirty lines of TypeScript, and if the
architecture ever outgrows that the right answer is to widen this on purpose rather than to have
built a general one first.

    from checkpoint import save
    save(model, "models/value-gen0", kind="value", trained_on=".data/gen0-25k", scores={...})
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
from torch import nn

ACTIVATIONS = {nn.ReLU: "relu", nn.Tanh: "tanh"}


def describe(model: nn.Module) -> list[dict]:
    """Flatten a `Sequential` of dense layers into something a reader can loop over.

    The activation belongs to the layer *before* it, which is the shape a forward pass wants: read a
    matrix, multiply, apply. Stored that way rather than as a parallel list so a reader cannot pair
    them up wrongly.
    """
    layers = []
    modules = [model] if isinstance(model, nn.Linear) else list(model)
    for module in modules:
        if isinstance(module, nn.Linear):
            layers.append({"in": module.in_features, "out": module.out_features, "activation": None})
        elif type(module) in ACTIVATIONS:
            if not layers:
                raise ValueError("activation before any linear layer")
            layers[-1]["activation"] = ACTIVATIONS[type(module)]
        else:
            raise ValueError(f"checkpoint format cannot express {type(module).__name__}")
    if not layers:
        raise ValueError("model has no linear layers")
    return layers


def warm_start(model: nn.Module, directory: str | Path) -> str:
    """Load a checkpoint's weights into `model`, if the two are the same shape.

    Returns a sentence about what happened, for the caller to print. It never raises on a mismatch
    and never partially loads: a checkpoint whose layers disagree with the model is simply not
    applicable, which is the ordinary case when the architecture changed between generations, and
    the honest response is to say so and train from scratch. Half-loading would be the one outcome
    worse than either.

    The reader is the mirror of `save`: layer order, `weight` then `bias`, `nn.Linear` holding its
    weight as (out, in) and written row-major. Getting the transpose wrong here would produce a
    model that runs, returns plausible numbers, and is wrong -- so the shapes are checked against
    the sidecar rather than inferred from the file's length.
    """
    d = Path(directory)
    sidecar = json.loads((d / "model.json").read_text())
    wanted = describe(model)
    def shape(layers: list[dict]) -> str:
        """`719-32-1`. Includes the input width, because a feature-size mismatch is otherwise
        invisible -- two models can agree on every output and still disagree about what they eat."""
        return "-".join([str(layers[0]["in"])] + [str(l["out"]) for l in layers])

    if [(l["in"], l["out"], l["activation"]) for l in sidecar["layers"]] != [
        (l["in"], l["out"], l["activation"]) for l in wanted
    ]:
        return (f"  no warm start: {d.name} is {shape(sidecar['layers'])} where this model is "
                f"{shape(wanted)} -- training from scratch")

    flat = np.fromfile(d / sidecar["file"], dtype="<f4")
    if flat.size != sidecar["parameters"]:
        return (f"  no warm start: {d.name} holds {flat.size} parameters, sidecar claims "
                f"{sidecar['parameters']} -- training from scratch")

    at = 0
    with torch.no_grad():
        for module in ([model] if isinstance(model, nn.Linear) else list(model)):
            if not isinstance(module, nn.Linear):
                continue
            size = module.weight.numel()
            module.weight.copy_(torch.from_numpy(flat[at : at + size]).view_as(module.weight))
            at += size
            size = module.bias.numel()
            module.bias.copy_(torch.from_numpy(flat[at : at + size]).view_as(module.bias))
            at += size
    assert at == flat.size, f"read {at} of {flat.size} parameters"
    return f"  warm started from {d.name}"


def save(model: nn.Module, directory: str | Path, **meta) -> Path:
    """Weights to `weights.f32`, everything else to `model.json`.

    Weights go down in layer order, each as `weight` then `bias`. `nn.Linear` holds its weight as
    (out, in) and it is written in that order, row-major -- so a reader walks output by output, which
    is also the order a forward pass consumes it in. Said here because getting it transposed produces
    a network that runs, returns plausible numbers, and is wrong.
    """
    d = Path(directory)
    d.mkdir(parents=True, exist_ok=True)
    layers = describe(model)

    blob = []
    for module in ([model] if isinstance(model, nn.Linear) else list(model)):
        if not isinstance(module, nn.Linear):
            continue
        blob.append(module.weight.detach().cpu().numpy().astype("<f4").ravel())
        blob.append(module.bias.detach().cpu().numpy().astype("<f4").ravel())
    flat = np.concatenate(blob)
    (d / "weights.f32").write_bytes(flat.tobytes())

    # The count is published so a reader can check the file rather than trust it. A truncated blob
    # otherwise reads as a network whose last layer is quietly full of whatever followed it.
    sidecar = {"layers": layers, "parameters": int(flat.size), "file": "weights.f32", **meta}
    (d / "model.json").write_text(json.dumps(sidecar, indent=2) + "\n")
    return d


def flatten(module: nn.Module) -> list[np.ndarray]:
    """Weights then bias, per linear layer, in module order."""
    blob = []
    for m in [module] if isinstance(module, nn.Linear) else list(module):
        if not isinstance(m, nn.Linear):
            continue
        blob.append(m.weight.detach().cpu().numpy().astype("<f4").ravel())
        blob.append(m.bias.detach().cpu().numpy().astype("<f4").ravel())
    return blob


def save_dual(model, directory: str | Path, **meta) -> Path:
    """A trunk with a value head and a policy head, as one checkpoint.

    Written as three chains rather than one, because it is no longer a chain: the trunk forks. The
    reader needs to know where the fork is, since running the trunk and then only the value head is
    the common case by a factor of three hundred -- the value is wanted at every leaf and the policy
    only where priors are computed.

    Weights go down trunk, value head, policy head, each layer as weight then bias, same convention
    as `save`. The `order` field says so explicitly rather than leaving a reader to infer it from
    key order in a JSON object.
    """
    d = Path(directory)
    d.mkdir(parents=True, exist_ok=True)
    parts = {"trunk": model.trunk, "value": model.value, "policy": model.policy}
    flat = np.concatenate([a for name in ("trunk", "value", "policy") for a in flatten(parts[name])])
    (d / "weights.f32").write_bytes(flat.tobytes())

    sidecar = {
        "kind": "dual",
        "trunk": describe(model.trunk),
        "heads": {"value": describe(model.value), "policy": describe(model.policy)},
        "order": ["trunk", "value", "policy"],
        "parameters": int(flat.size),
        "file": "weights.f32",
        **meta,
    }
    (d / "model.json").write_text(json.dumps(sidecar, indent=2) + "\n")
    return d


def load(directory: str | Path) -> tuple[list[dict], list[tuple[np.ndarray, np.ndarray]]]:
    """Read one back, for tests and for checking a checkpoint against the model that wrote it.

    Dual checkpoints come back flattened into one chain of layer descriptors, which is right for
    verifying the bytes and wrong for running them -- the fork is in the sidecar, not here.
    """
    d = Path(directory)
    sidecar = json.loads((d / "model.json").read_text())
    flat = np.fromfile(d / sidecar["file"], dtype="<f4")
    if flat.size != sidecar["parameters"]:
        raise ValueError(f"{d} holds {flat.size} parameters, sidecar claims {sidecar['parameters']}")

    if sidecar.get("kind") == "dual":
        layers = sidecar["trunk"] + sidecar["heads"]["value"] + sidecar["heads"]["policy"]
    else:
        layers = sidecar["layers"]

    weights, at = [], 0
    for layer in layers:
        n_in, n_out = layer["in"], layer["out"]
        w = flat[at : at + n_out * n_in].reshape(n_out, n_in)
        at += n_out * n_in
        b = flat[at : at + n_out]
        at += n_out
        weights.append((w, b))
    return layers, weights
