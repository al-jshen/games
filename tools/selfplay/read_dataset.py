"""Read a self-play dataset. The Python end of the seam, and deliberately tiny.

Everything the trainer needs is already numeric by the time it gets here -- the game encodes its own
positions -- so this file knows nothing about Splendor Duel and never has to.

    from read_dataset import load
    data = load(".data/gen0")
    x, pi, z = data.x, data.pi, data.z      # (N, F), (N, P), (N,)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class Dataset:
    x: np.ndarray
    pi: np.ndarray
    z: np.ndarray
    meta: np.ndarray  # (N, 3): game, move, seat
    sidecar: dict

    def seed_for(self, row: int) -> str:
        """The game seed behind a row, so a suspicious sample can be found in the replay viewer."""
        return self.sidecar["seeds"][int(self.meta[row, 0])]


def load(directory: str | Path) -> Dataset:
    d = Path(directory)
    sidecar = json.loads((d / "dataset.json").read_text())
    rows, f, p = sidecar["rows"], sidecar["featureSize"], sidecar["policySize"]

    x = np.fromfile(d / sidecar["files"]["x"], dtype="<f4").reshape(rows, f)
    pi = np.fromfile(d / sidecar["files"]["pi"], dtype="<f4").reshape(rows, p)
    z = np.fromfile(d / sidecar["files"]["z"], dtype="<f4")
    meta = np.fromfile(d / sidecar["files"]["meta"], dtype="<i4").reshape(rows, 3)

    # Shapes are asserted rather than trusted: a layout change on the TypeScript side would otherwise
    # reshape silently into nonsense and train perfectly happily on it.
    assert x.shape == (rows, f), f"features are {x.shape}, expected {(rows, f)}"
    assert pi.shape == (rows, p), f"policy is {pi.shape}, expected {(rows, p)}"
    assert z.shape == (rows,), f"values are {z.shape}, expected {(rows,)}"
    assert np.isfinite(x).all(), "features contain NaN or inf"
    assert np.allclose(pi.sum(axis=1), 1.0, atol=1e-4), "policy rows do not sum to 1"

    return Dataset(x=x, pi=pi, z=z, meta=meta, sidecar=sidecar)


if __name__ == "__main__":
    import sys

    data = load(sys.argv[1] if len(sys.argv) > 1 else ".data/gen0")
    print(f"{data.x.shape[0]:,} positions, {data.x.shape[1]} features, {data.pi.shape[1]} policy slots")
    print(f"  outcomes: {np.mean(data.z > 0):.1%} wins, {np.mean(data.z < 0):.1%} losses, {np.mean(data.z == 0):.1%} drawn")
    print(f"  row 0 came from seed {data.seed_for(0)!r}, move {data.meta[0, 1]}, seat {data.meta[0, 2]}")
