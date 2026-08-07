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
    z: np.ndarray  # the game's outcome: one label per game, shared by all its positions
    q: np.ndarray  # the search's estimate at that position: varies row by row
    h: np.ndarray  # the hand-written heuristic's value, for a baseline
    meta: np.ndarray  # (N, 3): game, move, seat
    sidecar: dict

    def seed_for(self, row: int) -> str:
        """The game seed behind a row, so a suspicious sample can be found in the replay viewer."""
        return self.sidecar["seeds"][int(self.meta[row, 0])]


def load(directory: str | Path) -> Dataset:
    d = Path(directory)
    sidecar = json.loads((d / "dataset.json").read_text())
    rows, f, p = sidecar["rows"], sidecar["featureSize"], sidecar["policySize"]

    def fit(raw: np.ndarray, name: str, width: int) -> np.ndarray:
        """Take exactly the rows the sidecar claims, which may be fewer than the file holds.

        Generation appends rows and republishes the count afterwards, so a run that was interrupted
        -- and a long one usually is -- leaves blobs running past the last published row: the tail of
        a game whose six columns did not all land. The count is the authority and the overhang is
        dropped, which is why it is published second. Reshaping the whole file instead would fail
        outright on the one kind of dataset this ordering exists to keep readable.

        Short is the opposite story, and not recoverable: the file is truncated or the layout moved.
        """
        want = rows * width
        if raw.size < want:
            raise ValueError(
                f"{name!r} holds {raw.size} values, short of the {want} the sidecar claims"
            )
        return raw[:want].reshape(rows, width) if width > 1 else raw[:want]

    def column(name: str, optional: bool = False, width: int = 1) -> np.ndarray:
        """A `float32` column, or zeros if the dataset predates it.

        Columns get added over time and datasets are large enough that regenerating one to read it is
        a real cost. Absent is not corrupt -- zeros, and let the caller notice. A missing key here
        would otherwise surface as a bare `KeyError` on a letter, which says nothing about what is
        actually wrong or what to do about it.
        """
        file = sidecar["files"].get(name)
        if file is None:
            if not optional:
                raise KeyError(f"dataset at {d} has no {name!r} column")
            return np.zeros(rows if width == 1 else (rows, width), dtype="<f4")
        return fit(np.fromfile(d / file, dtype="<f4"), name, width)

    x = column("x", width=f)
    pi = column("pi", width=p)
    z = column("z")
    q = column("q", optional=True)
    h = column("h", optional=True)
    meta = fit(np.fromfile(d / sidecar["files"]["meta"], dtype="<i4"), "meta", 3)

    # Shapes are asserted rather than trusted: a layout change on the TypeScript side would otherwise
    # reshape silently into nonsense and train perfectly happily on it.
    assert x.shape == (rows, f), f"features are {x.shape}, expected {(rows, f)}"
    assert pi.shape == (rows, p), f"policy is {pi.shape}, expected {(rows, p)}"
    assert z.shape == (rows,), f"values are {z.shape}, expected {(rows,)}"
    assert np.isfinite(x).all(), "features contain NaN or inf"
    assert np.allclose(pi.sum(axis=1), 1.0, atol=1e-4), "policy rows do not sum to 1"

    return Dataset(x=x, pi=pi, z=z, q=q, h=h, meta=meta, sidecar=sidecar)


if __name__ == "__main__":
    import sys

    data = load(sys.argv[1] if len(sys.argv) > 1 else ".data/gen0")
    print(f"{data.x.shape[0]:,} positions, {data.x.shape[1]} features, {data.pi.shape[1]} policy slots")
    print(f"  outcomes: {np.mean(data.z > 0):.1%} wins, {np.mean(data.z < 0):.1%} losses, {np.mean(data.z == 0):.1%} drawn")
    print(f"  row 0 came from seed {data.seed_for(0)!r}, move {data.meta[0, 1]}, seat {data.meta[0, 2]}")
