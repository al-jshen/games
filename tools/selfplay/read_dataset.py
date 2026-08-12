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
    source: np.ndarray | None = None  # which generation each row came from, when several are loaded

    def seed_for(self, row: int) -> str:
        """The game seed behind a row, so a suspicious sample can be found in the replay viewer."""
        return self.sidecar["seeds"][int(self.meta[row, 0])]


def blob(path: Path, dtype: str) -> np.ndarray:
    """Map a column instead of reading it into a private allocation.

    The format was built for this without anyone planning it: raw contiguous little-endian floats
    with the shape in a sidecar, which is exactly what `memmap` wants and exactly what `np.fromfile`
    has to allocate for. Mapping costs nothing up front and the pages are the kernel's, so they are
    reclaimable under pressure rather than a fixed charge against the job.

    It matters most in `load_window`, which reads one generation at a time into a temporary and
    copies it into a preallocated whole. That temporary used to be a real 17GB allocation on top of
    the 67GB destination -- 84GB of peak to hold 67GB of data. Mapped, the copy streams and the peak
    is the destination alone.

    It does not make loading *free*: the validation below touches every element, so the bytes still
    cross the network. What goes away is holding two copies of them at once.

    An empty dataset cannot be mapped -- `mmap` refuses a zero-length file -- and that is a real
    case here, since generation publishes a readable empty dataset before playing anything.
    """
    if path.stat().st_size == 0:
        return np.empty(0, dtype=dtype)
    return np.memmap(path, dtype=dtype, mode="r")


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
        return fit(blob(d / file, "<f4"), name, width)

    x = column("x", width=f)
    pi = column("pi", width=p)
    z = column("z")
    q = column("q", optional=True)
    h = column("h", optional=True)
    meta = fit(blob(d / sidecar["files"]["meta"], "<i4"), "meta", 3)

    # Shapes are asserted rather than trusted: a layout change on the TypeScript side would otherwise
    # reshape silently into nonsense and train perfectly happily on it.
    assert x.shape == (rows, f), f"features are {x.shape}, expected {(rows, f)}"
    assert pi.shape == (rows, p), f"policy is {pi.shape}, expected {(rows, p)}"
    assert z.shape == (rows,), f"values are {z.shape}, expected {(rows,)}"
    assert np.isfinite(x).all(), "features contain NaN or inf"
    assert np.allclose(pi.sum(axis=1), 1.0, atol=1e-4), "policy rows do not sum to 1"

    return Dataset(x=x, pi=pi, z=z, q=q, h=h, meta=meta, sidecar=sidecar)


def load_window(directories) -> Dataset:
    """Several generations at once, as one dataset. AlphaZero's replay buffer, done by hand.

    A generation trained only on its own games learns from a narrower slice of the game each round,
    and the value head is the one that suffers: its effective sample size is the *number of games*,
    not the row count, so a window of two generations is genuinely twice the labels rather than twice
    the rows. That is the one lever measurement has actually supported here.

    **Game ids are offset per generation, and this is the part that must not be got wrong.**
    `split_by_game` groups rows by `meta[:, 0]` so that positions from one game never straddle the
    train/test boundary -- they share an outcome and look alike, so splitting through a game reports a
    score that does not exist. Concatenating raw would make generation zero's game 5 and generation
    one's game 5 the same group. Nothing would fail; the holdout would just quietly be contaminated,
    and every number after it would be a little too good.

    Weighting is uniform, which is the assumption most worth revisiting. AlphaZero's window spans
    generations of comparable strength; ours will not, at least at first -- gen-0's games come from a
    search measured 352 elo weaker than the one that will produce gen-1. Whether the extra games are
    worth the staler play is an experiment, not a principle: train on the last generation alone and on
    the window, and compare on the same holdout.
    """
    dirs = [Path(d) for d in directories]
    if not dirs:
        raise ValueError("load_window needs at least one directory")
    sidecars = [json.loads((d / "dataset.json").read_text()) for d in dirs]

    features, policy = sidecars[0]["featureSize"], sidecars[0]["policySize"]
    for d, s in zip(dirs, sidecars):
        if (s["featureSize"], s["policySize"]) != (features, policy):
            raise ValueError(
                f"{d} is {s['featureSize']}x{s['policySize']}, expected {features}x{policy} -- "
                "the encoding changed between these generations and they cannot be mixed"
            )

    total = sum(s["rows"] for s in sidecars)
    # Preallocated and filled one generation at a time, rather than concatenated at the end. A
    # generation is ~8GB; holding every one of them plus the joined copy is how a window of four
    # stops fitting in memory for no reason.
    x = np.empty((total, features), dtype="<f4")
    pi = np.empty((total, policy), dtype="<f4")
    z, q, h = (np.empty(total, dtype="<f4") for _ in range(3))
    meta = np.empty((total, 3), dtype="<i4")
    source = np.empty(total, dtype="<i4")

    at, game_offset, seeds = 0, 0, []
    for index, directory in enumerate(dirs):
        part = load(directory)
        rows = part.x.shape[0]
        x[at : at + rows] = part.x
        pi[at : at + rows] = part.pi
        z[at : at + rows] = part.z
        q[at : at + rows] = part.q
        h[at : at + rows] = part.h
        meta[at : at + rows] = part.meta
        meta[at : at + rows, 0] += game_offset
        source[at : at + rows] = index
        at += rows
        game_offset += len(part.sidecar["seeds"])
        seeds.extend(part.sidecar["seeds"])
        del part  # ~8GB, and the next iteration wants the room

    sidecar = {
        "rows": total,
        "featureSize": features,
        "policySize": policy,
        "seeds": seeds,
        "window": [
            {"dir": str(d), "rows": s["rows"], "games": len(s["seeds"]), "config": s.get("config")}
            for d, s in zip(dirs, sidecars)
        ],
    }
    return Dataset(x=x, pi=pi, z=z, q=q, h=h, meta=meta, sidecar=sidecar, source=source)


if __name__ == "__main__":
    import sys

    data = load(sys.argv[1] if len(sys.argv) > 1 else ".data/gen0")
    print(f"{data.x.shape[0]:,} positions, {data.x.shape[1]} features, {data.pi.shape[1]} policy slots")
    print(f"  outcomes: {np.mean(data.z > 0):.1%} wins, {np.mean(data.z < 0):.1%} losses, {np.mean(data.z == 0):.1%} drawn")
    print(f"  row 0 came from seed {data.seed_for(0)!r}, move {data.meta[0, 1]}, seat {data.meta[0, 2]}")
