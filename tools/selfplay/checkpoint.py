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


def load(directory: str | Path) -> tuple[list[dict], list[tuple[np.ndarray, np.ndarray]]]:
    """Read one back, for tests and for checking a checkpoint against the model that wrote it."""
    d = Path(directory)
    sidecar = json.loads((d / "model.json").read_text())
    flat = np.fromfile(d / sidecar["file"], dtype="<f4")
    if flat.size != sidecar["parameters"]:
        raise ValueError(f"{d} holds {flat.size} parameters, sidecar claims {sidecar['parameters']}")

    weights, at = [], 0
    for layer in sidecar["layers"]:
        n_in, n_out = layer["in"], layer["out"]
        w = flat[at : at + n_out * n_in].reshape(n_out, n_in)
        at += n_out * n_in
        b = flat[at : at + n_out]
        at += n_out
        weights.append((w, b))
    return sidecar["layers"], weights
