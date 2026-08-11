#!/usr/bin/env python3
"""Turn the crank: self-play, train, gate on an arena, promote or reject. Repeat.

    python3 tools/selfplay/loop.py tools/selfplay/loop.yaml

Every step already existed and every step was run by hand. This is the thing that runs them in
order, decides between generations, and can be killed and restarted -- which matters more than it
sounds, because a generation of self-play is hours and something will interrupt it.

**Four commitments shape the design.**

*Nothing is inferred from printed text.* Each step writes a machine-readable artefact -- the dataset
sidecar, the checkpoint's `model.json`, the arena's `--report` -- and the orchestrator reads those.
Scraping a score out of prose meant for a human is a coupling that breaks the first time the wording
improves, and it breaks silently, at hour six.

*Every step is resumable and skipped if already done.* State lives in `state.json` and is rewritten
after each step. Re-running the same command after a kill picks up at the first incomplete step
rather than regenerating 25,000 games.

*A generation is promoted only if it wins.* The candidate plays the incumbent and has to clear a
threshold, not merely tie. AlphaGo Zero gated at 55% and AlphaZero did not bother, having 44 million
games for mistakes to wash out in; a generation here is hours, so a silent regression would poison
everything after it. Rejection is a normal outcome, and the rejected model stays on disk.

*Absolute strength is tracked separately from relative.* Gating compares each generation with the one
before it, which says nothing about whether the sequence as a whole is going anywhere -- a loop can
pass every gate by 56% and still be circling. So after each decision the reigning model plays a fixed
opponent that never changes, and the series of those scores is the only thing here that measures
progress rather than change.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
NODE = "node"
RULE = "─" * 78


def banner(title: str, char: str = "━") -> None:
    print(f"\n{char * 78}\n  {title}\n{char * 78}", flush=True)


def step(number: int, total: int, title: str) -> None:
    print(f"\n{RULE}\n  step {number}/{total} · {title}\n{RULE}", flush=True)


def duration(seconds: float) -> str:
    hours, rest = divmod(int(seconds), 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}h{minutes:02d}m" if hours else (f"{minutes}m{secs:02d}s" if minutes else f"{secs}s")


def sh(command: list[str], log: Path, ok: tuple[int, ...] = (0,)) -> None:
    """Run a step, streaming its output live and keeping a copy.

    Streamed byte-by-chunk rather than line-by-line, deliberately: both the generator and the arena
    report progress with a carriage return and no newline, so anything that waits for `\\n` would
    show nothing at all until a step finished. That is precisely the output worth watching -- games
    completed, current score, throughput, time left.

    The log is kept because when a generation looks wrong three days later the question is always
    "what did it actually say", and by then the terminal is gone.
    """
    log.parent.mkdir(parents=True, exist_ok=True)
    print(f"  $ {' '.join(command)}\n", flush=True)
    started = time.monotonic()
    with subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, bufsize=0) as proc:
        with log.open("wb") as handle:
            while True:
                # `bufsize=0` makes this a raw stream, whose `read` is a single syscall returning
                # whatever is available rather than blocking for a full buffer. That is what keeps
                # a carriage-return progress line moving instead of arriving all at once at the end.
                chunk = proc.stdout.read(65536)
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
                handle.write(chunk)
        code = proc.wait()
    if code not in ok:
        tail = "".join(log.read_text(errors="replace").splitlines(keepends=True)[-25:])
        raise SystemExit(f"\n  step failed ({code}); last lines of {log}:\n\n{tail}")
    print(f"\n  ✓ {duration(time.monotonic() - started)}   log: {log.relative_to(ROOT)}", flush=True)


class Loop:
    def __init__(self, config: dict, config_path: Path):
        self.config = config
        self.run_dir = ROOT / config["run"]["dir"]
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.run_dir / "state.json"
        self.state = self._load_state(config_path)

    def _load_state(self, config_path: Path) -> dict:
        if self.state_path.exists():
            state = json.loads(self.state_path.read_text())
            print(f"  resuming from {self.state_path.relative_to(ROOT)} "
                  f"at generation {state['generation']}")
            return state
        seed = self.config["run"].get("seed_model") or {}
        return {
            "generation": 0,
            "config": str(config_path),
            # The incumbent. `null` means there is no network yet, and generation zero is played with
            # the hand-written evaluation -- which is exactly how the first dataset was ever made.
            "best": {"value": seed.get("value"), "policy": seed.get("policy")},
            "history": [],
        }

    def save(self) -> None:
        self.state_path.write_text(json.dumps(self.state, indent=2) + "\n")

    # -- steps ------------------------------------------------------------------------------

    def selfplay(self, generation: int) -> Path:
        out = self.run_dir / f"gen{generation}"
        sidecar = out / "dataset.json"
        cfg = self.config["selfplay"]
        wanted = int(cfg["games"])
        if sidecar.exists():
            meta = json.loads(sidecar.read_text())
            # `games`, never `seeds`. The seed list is the *plan* and the generator writes it whole
            # before playing anything, so it reads full from the first millisecond -- a run that
            # died on its first move leaves `seeds` at 25,000 and the blobs at zero bytes. Measuring
            # completion by it made this branch unreachable and handed the trainer an empty dataset,
            # which failed several steps later as a numpy TypeError about `invert`. Older datasets
            # predate the field, so fall back to the plan but only when rows were actually written.
            done = meta.get("games")
            if done is None:
                done = len(meta["seeds"]) if meta["rows"] else 0
            if done >= wanted:
                print(f"  already done: {meta['rows']:,} rows from {done:,} games")
                return out
            # A partial dataset is readable by design, but it is not what was asked for, and quietly
            # training on a third of a generation is worse than saying so and doing it again.
            print(f"  incomplete ({done:,} of {wanted:,} games) -- regenerating")

        command = [NODE, "tools/selfplay/generate.mjs",
                   "--games", str(wanted),
                   "--iterations", str(cfg["iterations"]),
                   "--out", str(out.relative_to(ROOT)),
                   "--temperature", str(cfg.get("temperature", 0)),
                   "--temperature-moves", str(cfg.get("temperature_moves", 15))]
        if cfg.get("workers"):
            command += ["--workers", str(cfg["workers"])]
        if self.state["best"]["value"]:
            command += ["--net", self.state["best"]["value"]]
        sh(command, self.run_dir / "logs" / f"gen{generation}-selfplay.log")
        return out

    def window(self, generation: int) -> list[str]:
        """The datasets to train on: this generation and the previous few.

        A window rather than the newest alone, because the value head's effective sample size is the
        number of *games*, and more games is the only lever measurement has consistently supported.
        Older generations come from weaker play, which is the cost. `window: 1` turns it off.
        """
        span = max(1, int(self.config["training"].get("window", 1)))
        first = max(0, generation - span + 1)
        return [str((self.run_dir / f"gen{g}").relative_to(ROOT))
                for g in range(first, generation + 1)
                if (self.run_dir / f"gen{g}" / "dataset.json").exists()]

    def train(self, generation: int, head: str, datasets: list[str]) -> Path:
        """Train one head and return where it was saved.

        The trainers use their exit code to carry a *verdict* -- 1 means the model did not beat the
        heuristic -- which is right for a script run by hand and wrong here. A generation that fails
        to clear that bar is a result to record and carry on from, not a crash. So the code is
        accepted and the artefact is checked instead: decide from what was written, never from what
        was printed or signalled.
        """
        cfg = self.config["training"][head]
        out = self.run_dir / "models" / f"gen{generation}-{head}"
        if (out / "model.json").exists():
            print(f"  already trained: {out.relative_to(ROOT)}")
            return out

        command = [sys.executable, f"tools/selfplay/train_{head}.py", *datasets,
                   "--save", str(out.relative_to(ROOT)),
                   "--epochs", str(cfg["epochs"]),
                   "--batch", str(cfg["batch"]),
                   "--lr", str(cfg["lr"])]
        if cfg.get("arch"):
            command += ["--arch", *[str(a) for a in cfg["arch"]]]
        if head == "value" and cfg.get("lambda") is not None:
            blends = cfg["lambda"]
            command += ["--lambda", *[str(v) for v in (blends if isinstance(blends, list) else [blends])]]
        if self.config["training"].get("device"):
            command += ["--device", str(self.config["training"]["device"])]
        sh(command, self.run_dir / "logs" / f"gen{generation}-train-{head}.log", ok=(0, 1))
        if not (out / "model.json").exists():
            raise SystemExit(f"\n  {head} training wrote no checkpoint to {out}")
        return out

    def play(self, name: str, generation: int, a: dict, b: dict, cfg: dict) -> dict:
        """One arena, cached by its report file. `a` and `b` are `{spec, net, policy}`."""
        report_path = self.run_dir / "reports" / f"gen{generation}-{name}.json"
        if report_path.exists():
            print(f"  already played: {report_path.relative_to(ROOT)}")
            return json.loads(report_path.read_text())
        report_path.parent.mkdir(parents=True, exist_ok=True)

        command = [NODE, "tools/selfplay/arena.mjs",
                   "--a", a["spec"], "--b", b["spec"],
                   "--pairs", str(max(1, int(cfg["games"]) // 2)),
                   "--iterations", str(cfg["iterations"]),
                   "--label-a", a["label"], "--label-b", b["label"],
                   "--report", str(report_path.relative_to(ROOT))]
        for side, player in (("a", a), ("b", b)):
            if player.get("net"):
                command += [f"--{side}-net", player["net"]]
            if player.get("policy"):
                command += [f"--{side}-policy", player["policy"]]
        if cfg.get("workers"):
            command += ["--workers", str(cfg["workers"])]
        sh(command, self.run_dir / "logs" / f"gen{generation}-{name}.log")
        return json.loads(report_path.read_text())

    def gate(self, generation: int, candidate: dict) -> dict | None:
        cfg = self.config["arena"]
        if not self.state["best"]["value"]:
            print("  no incumbent yet — generation 0 is promoted unopposed")
            return None
        spec = json.dumps(cfg.get("search", {}))
        use_policy = bool(cfg.get("use_policy", False))
        return self.play(
            "gate", generation,
            {"spec": spec, "label": f"gen{generation}", "net": candidate["value"],
             "policy": candidate["policy"] if use_policy else None},
            {"spec": spec, "label": "incumbent", "net": self.state["best"]["value"],
             "policy": self.state["best"]["policy"] if use_policy else None},
            cfg,
        )

    def baseline(self, generation: int) -> dict | None:
        """The reigning model against an opponent that never changes.

        The gate only ever compares neighbours, so a loop can clear it every time and still be going
        nowhere -- 56% against something 56% better than the thing before it is not the same as
        getting stronger, and the gate cannot tell the difference. This can.

        `random` is the default opponent and it is the weakest useful one: it will saturate at 100%
        almost immediately and then measure nothing. Any spec works, so the more informative anchor
        is a fixed configuration that does not move -- the original heuristic search, say -- which
        keeps resolving long after random has stopped.
        """
        cfg = self.config.get("baseline")
        if not cfg or not cfg.get("enabled", True):
            return None
        opponent = cfg.get("opponent", "random")
        return self.play(
            "baseline", generation,
            {"spec": json.dumps(cfg.get("search", {})), "label": f"gen{generation} best",
             "net": self.state["best"]["value"]},
            {"spec": opponent, "label": opponent if opponent == "random" else "anchor",
             "net": cfg.get("opponent_net")},
            cfg,
        )

    def progress_table(self) -> None:
        rows = [h for h in self.state["history"]]
        if not rows:
            return
        print(f"\n{RULE}\n  progress so far\n{RULE}")
        print("  gen   gate score   verdict     vs baseline      model")
        for h in rows:
            gate = f"{h['score']:.1%}" if h.get("score") is not None else "unopposed"
            base = f"{h['baseline']:.1%}" if h.get("baseline") is not None else "—"
            mark = "accepted" if h["accepted"] else "rejected"
            print(f"  {h['generation']:>3}   {gate:>10}   {mark:<9}   {base:>11}      "
                  f"{Path(h['candidate']['value']).name}")
        print(flush=True)

    # -- the crank --------------------------------------------------------------------------

    def run(self) -> int:
        total = int(self.config["run"]["generations"])
        first = int(self.state["generation"])
        steps = 5 if self.config.get("baseline", {}).get("enabled", True) else 4

        for generation in range(first, first + total):
            started = time.monotonic()
            incumbent = self.state["best"]["value"] or "the hand-written evaluation"
            done = generation - first
            banner(f"GENERATION {generation}   ·   {done} of {total} done this run   "
                   f"·   incumbent: {incumbent}")

            step(1, steps, f"self-play — {self.config['selfplay']['games']:,} games at "
                           f"{self.config['selfplay']['iterations']} iterations")
            self.selfplay(generation)

            datasets = self.window(generation)
            step(2, steps, f"train value head — window of {len(datasets)}: {', '.join(datasets)}")
            value = str(self.train(generation, "value", datasets).relative_to(ROOT))

            step(3, steps, f"train policy head — window of {len(datasets)}")
            policy = str(self.train(generation, "policy", datasets).relative_to(ROOT))
            candidate = {"value": value, "policy": policy}

            threshold = float(self.config["arena"]["threshold"])
            step(4, steps, f"gate — candidate vs incumbent, {self.config['arena']['games']} games, "
                           f"promote at {threshold:.0%}")
            report = self.gate(generation, candidate)
            if report is None:
                accepted, score = True, None
            else:
                score = report["score"]
                accepted = score >= threshold
                tally = f"{report['winsA']}-{report['winsB']}"
                if report["draws"]:
                    tally += f"-{report['draws']}"
                low, high = report["ci"]
                print(f"\n  {tally}   score {score:.1%}   95% CI [{low:.1%}, {high:.1%}]   "
                      f"elo {report['elo']:+.0f}")
                print(f"  → {'ACCEPTED' if accepted else 'REJECTED'} "
                      f"({score:.1%} {'≥' if accepted else '<'} {threshold:.0%} threshold)")

            if accepted:
                self.state["best"] = candidate
            else:
                # The rejected candidate stays on disk. A generation that lost is data about the
                # loop, and deleting it is how you end up unable to answer why it stalled.
                print(f"  keeping incumbent: {self.state['best']['value']}")

            baseline_score = None
            if steps == 5:
                step(5, steps, "baseline — reigning model vs a fixed opponent (absolute progress)")
                base = self.baseline(generation)
                if base:
                    baseline_score = base["score"]
                    low, high = base["ci"]
                    print(f"\n  {base['winsA']}-{base['winsB']}   score {baseline_score:.1%}   "
                          f"95% CI [{low:.1%}, {high:.1%}]   elo {base['elo']:+.0f}")

            self.state["history"].append({
                "generation": generation, "candidate": candidate, "accepted": accepted,
                "score": score, "baseline": baseline_score, "datasets": datasets,
                "seconds": round(time.monotonic() - started),
            })
            self.state["generation"] = generation + 1
            self.save()
            print(f"\n  generation {generation} complete in {duration(time.monotonic() - started)}")
            self.progress_table()

        accepted = sum(1 for h in self.state["history"] if h["accepted"])
        banner(f"DONE   ·   {accepted} of {len(self.state['history'])} generations accepted   "
               f"·   best: {self.state['best']['value']}")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("config", nargs="?", default="tools/selfplay/loop.yaml")
    args = parser.parse_args()
    config_path = Path(args.config)
    banner(f"self-play loop   ·   config: {config_path}", "═")
    return Loop(yaml.safe_load(config_path.read_text()), config_path).run()


if __name__ == "__main__":
    raise SystemExit(main())
