#!/usr/bin/env python3
"""Turn the crank: self-play, train, measure in an arena, promote. Repeat.

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

*A generation is promoted unless it is measurably worse.* The candidate plays the incumbent, but the
arena reports rather than decides: promotion is refused only when the whole 95% interval sits below
even, which at 300 games means roughly 35 elo of genuine regression.

This used to be a 55% threshold, AlphaGo Zero's number, and it was right while every generation was
an independent refit from random weights -- such a fit can land anywhere, so a candidate had to prove
itself before being trusted to generate the next round of data. Warm starting removed that premise:
a candidate now begins from the incumbent's weights and the outcome it is most likely to have is
"much the same". AlphaZero dropped the gate for exactly this reason and always used the latest net.

Eight generations here say the same thing, and say it as a failure. Every candidate from gen-4 on
landed inside the arena's own +-40 elo resolution, so the threshold was deciding on coin flips: gen-5
was promoted on 0.54 [-12, +67] and became the incumbent that gen-6 and gen-7 then failed to beat.
Worse, rejection fed back into training. The incumbent does not change, so the next generation warm
starts from the same weights, finds nothing that beats them, and ships a byte-identical copy --
gen-4's value head is gen-3's to the byte, and gen-6's is gen-5's. A rejection also leaves the
self-play inputs unchanged, so gen-7 replayed gen-6's 50,000 games exactly. The gate was not
filtering noise out of the loop; it was closing a loop that manufactured it.

What survives is the direction. A candidate that is *significantly* worse is still refused, which is
the regression this exists to stop, and a refused model stays on disk.

*Absolute strength is tracked separately from relative.* Gating compares each generation with the one
before it, which says nothing about whether the sequence as a whole is going anywhere -- a loop can
pass every gate by 56% and still be circling. So after each decision the reigning model plays a fixed
opponent that never changes, and the series of those scores is the only thing here that measures
progress rather than change.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass, field
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


def named(path: Path) -> str:
    """How a path is written, both for the child processes and for the reader.

    Every step runs with `cwd=ROOT`, so a path inside the repo can be handed over relative and stays
    short and readable in the printed command lines. One outside it cannot, and `relative_to` does
    not quietly fall back -- it raises. That matters because the run directory is exactly the thing
    somebody moves: a generation is ~8GB and home directories have quotas, so pointing `run.dir` at
    bulk storage is the expected case, not an exotic one.

    Relative when it can be, absolute when it must be, and the child never sees the difference.
    """
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sh(command: list[str], log: Path, ok: tuple[int, ...] | None = (0,)) -> int:
    """Run a step, streaming its output live and keeping a copy. Returns its exit code.

    `ok=None` accepts any code and leaves the verdict to the caller, which is what a sharded step
    needs: one failed shard out of a hundred is a fact to weigh against the rest, not a reason to
    abandon the ninety-nine that worked.

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
    if ok is not None and code not in ok:
        tail = "".join(log.read_text(errors="replace").splitlines(keepends=True)[-25:])
        raise SystemExit(f"\n  step failed ({code}); last lines of {log}:\n\n{tail}")
    print(f"\n  ✓ {duration(time.monotonic() - started)}   log: {named(log)}", flush=True)
    return code


SHARD = "{shard}"


@dataclass
class Task:
    """One step, described rather than executed, so that either backend can take it.

    `command` may contain the literal `{shard}` in any argument. Locally that is substituted with
    each index in turn and the shards run one after another; under Slurm it becomes
    `$SLURM_ARRAY_TASK_ID` and they run as a job array. Everything else about a task is the same
    under both, which is the point -- the loop builds one description and never asks which backend
    it is talking to.
    """

    name: str
    command: list[str]
    log: Path
    # `None` accepts any exit code. Used where the verdict lives in an artefact rather than in the
    # status: the trainers signal "did not beat the heuristic" with 1, and a self-play array should
    # not throw away 127 good shards because one node was preempted.
    ok: tuple[int, ...] | None = (0,)
    # Which `runner.slurm.<key>` block sizes this step. Ignored by the local backend.
    resources: str = "arena"
    shards: int | None = None

    def for_shard(self, index: int | str) -> list[str]:
        return [part.replace(SHARD, str(index)) for part in self.command]


class LocalRunner:
    """Subprocesses on this machine, which is what the loop has always done.

    Shards run one after another rather than at once: the point of running sharded locally is to
    exercise the same code path the cluster will take, not to go faster, and N generators each
    taking every core would only fight each other.
    """

    kind = "local"

    def __init__(self, config: dict, run_dir: Path, dry_run: bool = False):
        self.dry_run = dry_run

    def run_many(self, tasks: list[Task]) -> None:
        """Sequentially, because there is one machine.

        The two trainers are submitted together so that a cluster can run them side by side, but
        locally they would only divide the same cores between them and finish no sooner.
        """
        for task in tasks:
            self.run(task)

    def run(self, task: Task) -> None:
        if task.shards is None:
            self._one(task.command, task.log, task.ok)
            return
        worst = 0
        for index in range(task.shards):
            print(f"\n  shard {index + 1}/{task.shards}", flush=True)
            log = task.log.with_name(f"{task.log.stem}-shard{index}{task.log.suffix}")
            worst = max(worst, self._one(task.for_shard(index), log, None))
        if task.ok is not None and worst not in task.ok:
            raise SystemExit(f"\n  {task.name}: a shard exited {worst}")

    def _one(self, command: list[str], log: Path, ok: tuple[int, ...] | None) -> int:
        if self.dry_run:
            print(f"  $ {' '.join(command)}", flush=True)
            return 0
        return sh(command, log, ok)


class SlurmRunner:
    """The same steps, submitted as jobs.

    `sbatch --wait` blocks until the job finishes and exits with the job's status, so a submitted
    step keeps `run`'s contract exactly: do this, come back when it is done, say whether it failed.
    That is the whole reason the seam is here and not somewhere more elaborate.

    Deliberately *not* a poll loop over `squeue`. The scheduler is shared by hundreds of people and
    a step-by-step poll across a run of days is real load on it; `--wait` is the supported mechanism
    and costs it nothing extra.
    """

    kind = "slurm"

    def __init__(self, config: dict, run_dir: Path, dry_run: bool = False):
        self.config = (config.get("runner") or {}).get("slurm") or {}
        self.run_dir = run_dir
        self.dry_run = dry_run
        self.script_dir = run_dir / "slurm"
        self.lock_dir = run_dir / "slurm" / "locks"

    # -- the double-submit guard ----------------------------------------------------------

    def check_no_live_jobs(self) -> None:
        """Refuse to start while a previous run's jobs may still be going.

        The orchestrator is expendable -- kill it and the submitted job carries on, which is fine,
        because re-running picks up from the artefacts. The hazard is the gap before an artefact
        exists: restart during a four-hour self-play array and nothing on disk says it is running,
        so a second array is submitted onto the same directories and two writers interleave into
        the same blobs.

        A lock file closes that window without asking the scheduler anything. It is deliberately
        not self-healing: deciding on your behalf that a job is dead is exactly the judgement that
        should not be automated, since guessing wrong corrupts a generation.
        """
        locks = sorted(self.lock_dir.glob("*.lock")) if self.lock_dir.exists() else []
        if not locks:
            return
        lines = "\n".join(
            f"    {lock.name}: {'; '.join(lock.read_text().strip().splitlines())}" for lock in locks
        )
        raise SystemExit(
            f"\n  {len(locks)} step(s) were submitted and never recorded as finished:\n\n{lines}\n\n"
            f"  Another orchestrator may still be running them. Check with:\n"
            f"    squeue -u $USER\n\n"
            f"  If nothing is running, the jobs died and the locks are stale -- remove them and\n"
            f"  re-run; each step will resume from whatever reached the disk:\n"
            f"    rm {self.lock_dir}/*.lock"
        )

    # -- submission -----------------------------------------------------------------------

    def directives(self, task: Task) -> list[str]:
        cfg = self.config.get(task.resources) or {}
        out = [f"--job-name={task.name}"]
        if task.shards is None:
            out.append(f"--output={task.log}")
        else:
            # One file per array task; `%a` is the task index.
            out.append(f"--output={task.log.with_name(task.log.stem + '-shard%a' + task.log.suffix)}")
            out.append(f"--array=0-{task.shards - 1}")
        # `nodes` is the number of *machines the step spreads over*, which for self-play is the
        # array width and is therefore already spent above -- each array task is its own one-node
        # job. So every job here asks for one node, and parallelism comes from how many there are.
        out.append("--nodes=1")
        if cfg.get("cpus_per_node") is not None:
            out.append(f"--cpus-per-task={cfg['cpus_per_node']}")
        for key, flag in (("partition", "--partition"), ("time", "--time"),
                          ("gres", "--gres"), ("mem", "--mem"), ("qos", "--qos"),
                          # `-C`. Node features: which CPU generation the shards land on, which
                          # card the trainer gets. Both matter here -- self-play throughput is the
                          # cost dial, and whether a window fits in GPU memory is decided by it.
                          ("constraint", "--constraint")):
            if cfg.get(key) is not None:
                out.append(f"{flag}={cfg[key]}")
        if self.config.get("account"):
            out.append(f"--account={self.config['account']}")
        out += [str(extra) for extra in (cfg.get("extra") or [])]
        return out

    def script(self, task: Task) -> str:
        command = task.for_shard("$SLURM_ARRAY_TASK_ID") if task.shards is not None else task.command
        # Quoted except for Slurm's own variables, which have to survive as shell syntax.
        rendered = " ".join(
            part if "$SLURM_" in part else shlex.quote(part) for part in command
        )
        lines = ["#!/bin/bash"]
        lines += [f"#SBATCH {d}" for d in self.directives(task)]
        lines += [
            "set -uo pipefail",
            "",
            f"cd {shlex.quote(str(ROOT))}",
            # Python block-buffers stdout whenever it is not a terminal, and under Slurm it never
            # is. A job killed at its walltime then leaves an empty log -- precisely the case where
            # the log is the only evidence there is, and precisely when you need to know how far it
            # got. Set before the configured environment so it can still be overridden.
            "export PYTHONUNBUFFERED=1",
        ]
        for name, value in (self.config.get("env") or {}).items():
            lines.append(f"export {name}={shlex.quote(str(value))}")
        lines += ["", rendered, ""]
        return "\n".join(lines)

    def run_many(self, tasks: list[Task]) -> None:
        """Submit several steps at once and wait for all of them.

        One thread per job, each blocking in its own `sbatch --wait`. Threads rather than a poll
        loop for the same reason `run` uses `--wait` at all: waiting is the scheduler's job and
        asking it repeatedly whether it is finished yet is load it does not need. A thread parked
        in `subprocess.run` costs nothing.

        Used for the two training heads, which have no reason to be sequential -- they read the
        same datasets, write different checkpoints, and neither looks at the other's output.
        """
        if len(tasks) < 2:
            for task in tasks:
                self.run(task)
            return

        import threading

        failures: dict[str, BaseException] = {}

        def target(task: Task) -> None:
            try:
                self.run(task)
            except BaseException as error:  # noqa: BLE001 -- re-raised on the main thread below
                failures[task.name] = error

        print(f"  submitting {len(tasks)} jobs to run side by side: "
              f"{', '.join(t.name for t in tasks)}", flush=True)
        threads = [threading.Thread(target=target, args=(task,), daemon=False) for task in tasks]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        if failures:
            raise SystemExit("\n".join(str(error) for error in failures.values()))

    def run(self, task: Task) -> None:
        self.script_dir.mkdir(parents=True, exist_ok=True)
        task.log.parent.mkdir(parents=True, exist_ok=True)
        path = self.script_dir / f"{task.name}.sbatch"
        path.write_text(self.script(task))
        path.chmod(0o755)

        if self.dry_run:
            print(f"  would submit {named(path)}:\n", flush=True)
            print("    " + self.script(task).replace("\n", "\n    "), flush=True)
            return

        self.lock_dir.mkdir(parents=True, exist_ok=True)
        lock = self.lock_dir / f"{task.name}.lock"
        lock.write_text(f"submitted {time.strftime('%Y-%m-%d %H:%M:%S')} from {path}\n")

        command = ["sbatch", "--wait", "--parsable", str(path)]
        print(f"  $ {' '.join(command)}", flush=True)
        started = time.monotonic()
        # `--wait` holds until the job ends, so this is a long block with no output of its own.
        # Progress is in the job's log, which is why the path is printed before rather than after.
        print(f"  waiting; job output goes to {named(task.log)}", flush=True)
        proc = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        code = proc.returncode
        job = (proc.stdout or "").strip().splitlines()
        if job:
            # Recording the id is bookkeeping, and bookkeeping must not be able to destroy the
            # result. The lock can be gone for reasons that have nothing to do with the job -- a
            # cleanup that took the run directory with it, someone clearing a stale lock by hand --
            # and in every one of those cases the job still ran and its outcome is still the thing
            # worth reporting. Losing the note is survivable; losing the verdict is not.
            try:
                lock.write_text(f"{lock.read_text().strip()}\njob {job[0]}\n")
            except OSError as error:
                print(f"  (could not record job {job[0]} in {named(lock)}: {error})", flush=True)
        if proc.stderr.strip():
            print(f"  {proc.stderr.strip()}", flush=True)

        # Released before the verdict, not after. The lock guards against resubmitting a job that
        # may still be *running*, and `--wait` having returned means this one is not: it has
        # terminated, well or badly, and nothing is still writing to the run directory. Keeping it
        # on a failure would leave a lock behind for a job that is definitely finished, and the next
        # run would stop and ask about it for no reason.
        lock.unlink(missing_ok=True)
        if task.ok is not None and code not in task.ok:
            raise SystemExit(
                f"\n  {task.name} failed ({code}); job {job[0] if job else '?'}.\n"
                f"  Its output is in {named(task.log)}."
            )
        print(f"\n  ✓ {duration(time.monotonic() - started)}   log: {named(task.log)}", flush=True)


def make_runner(config: dict, run_dir: Path, dry_run: bool):
    kind = ((config.get("runner") or {}).get("kind") or "local").lower()
    if kind == "local":
        return LocalRunner(config, run_dir, dry_run)
    if kind == "slurm":
        return SlurmRunner(config, run_dir, dry_run)
    raise SystemExit(f"  runner.kind must be 'local' or 'slurm', not {kind!r}")


class Loop:
    def __init__(self, config: dict, config_path: Path, dry_run: bool = False):
        self.config = config
        # `ROOT / x` is `x` when `x` is already absolute, so this takes both: an absolute path is
        # used as given, a relative one is still anchored to the repo rather than to whatever
        # directory the loop happened to be started from.
        self.run_dir = (ROOT / Path(config["run"]["dir"]).expanduser()).resolve()
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.run_dir / "state.json"
        self.dry_run = dry_run
        self.runner = make_runner(config, self.run_dir, dry_run)
        if hasattr(self.runner, "check_no_live_jobs") and not dry_run:
            self.runner.check_no_live_jobs()
        self.state = self._load_state(config_path)

    def workers(self, step: str, cfg: dict) -> list[str]:
        """`--workers` for a step, which must not be left to the default under Slurm.

        `defaultWorkers()` reads `availableParallelism()`, which reports the machine rather than the
        cgroup the job was given. On a shared node that oversubscribes badly -- 128 workers inside an
        allocation of 8 cores. An explicit value from the config wins; otherwise a Slurm job asks
        Slurm, and a local run keeps the existing behaviour of taking the box.
        """
        if cfg.get("workers"):
            return ["--workers", str(cfg["workers"])]
        if self.runner.kind == "slurm":
            # From Slurm rather than from `cpus_per_node`, so that a job which was given less than
            # it asked for uses what it actually got.
            return ["--workers", "$SLURM_CPUS_ON_NODE"]
        return []

    @property
    def shards(self) -> int:
        """How many pieces a generation of self-play is cut into: one per node.

        `runner.slurm.selfplay.nodes` is both the number of machines and the width of the job
        array, because each node runs one generator over its own slice.

        It governs the Slurm backend only. Locally there is one machine, and honouring a node count
        meant for a cluster would turn a laptop run into 128 sequential generators of 195 games
        each -- the same total work, dressed up as a hundred-odd steps. So a local run is one shard
        and behaves exactly as it always did, and switching backends needs no second edit.
        """
        if self.runner.kind != "slurm":
            return 1
        cfg = ((self.config.get("runner") or {}).get("slurm") or {}).get("selfplay") or {}
        return max(1, int(cfg.get("nodes", 1)))

    def _load_state(self, config_path: Path) -> dict:
        if self.state_path.exists():
            state = json.loads(self.state_path.read_text())
            print(f"  resuming from {named(self.state_path)} "
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
        """Written to a temporary file and renamed over the real one.

        `rename` within a directory is atomic, so a reader sees the old state or the new one and
        never a half-written file. Under Slurm the orchestrator can be killed at any moment --
        walltime, preemption, a dropped connection -- and the state file is the one artefact whose
        loss cannot be recovered from the others.
        """
        if self.dry_run:
            return
        temporary = self.state_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self.state, indent=2) + "\n")
        os.replace(temporary, self.state_path)

    # -- steps ------------------------------------------------------------------------------

    def datasets(self, generation: int) -> list[Path]:
        """Where a generation's data lives: one directory per shard.

        Always `gen{G}/shard{i}`, even when there is a single shard, so there is one layout to
        reason about rather than one for laptops and another for clusters.
        """
        return [self.run_dir / f"gen{generation}" / f"shard{i}" for i in range(self.shards)]

    def written(self, generation: int) -> tuple[int, int]:
        """(games, rows) that actually reached the disk for a generation, summed over its shards.

        `games`, never `seeds`. The seed list is the *plan* and the generator writes it whole before
        playing anything, so it reads full from the first millisecond -- a run that died on its
        first move leaves `seeds` at 25,000 and the blobs at zero bytes. Older datasets predate the
        field, so fall back to the plan, but only where rows were actually written.
        """
        games = rows = 0
        for directory in self.existing(generation):
            meta = json.loads((directory / "dataset.json").read_text())
            done = meta.get("games")
            if done is None:
                done = len(meta["seeds"]) if meta["rows"] else 0
            games += done
            rows += meta["rows"]
        return games, rows

    def existing(self, generation: int) -> list[Path]:
        """The generation's datasets that are actually on disk, shard layout or not.

        `gen{G}` itself is included when it holds a dataset, so a run started before sharding
        existed still trains and still resumes.
        """
        base = self.run_dir / f"gen{generation}"
        found = [d for d in self.datasets(generation) if (d / "dataset.json").exists()]
        found += [d for d in sorted(base.glob("shard*")) if (d / "dataset.json").exists()
                  and d not in found]
        if (base / "dataset.json").exists():
            found.insert(0, base)
        return found

    def selfplay(self, generation: int) -> None:
        cfg = self.config["selfplay"]
        wanted = int(cfg["games"])
        done, rows = self.written(generation)
        if done >= wanted:
            print(f"  already done: {rows:,} rows from {done:,} games")
            return
        if done:
            # A partial dataset is readable by design, but it is not what was asked for, and quietly
            # training on a third of a generation is worse than saying so and doing it again.
            print(f"  incomplete ({done:,} of {wanted:,} games) -- regenerating")

        out = self.run_dir / f"gen{generation}" / f"shard{SHARD}"
        command = [NODE, "tools/selfplay/generate.mjs",
                   "--games", str(wanted),
                   "--num-shards", str(self.shards),
                   "--shard-id", SHARD,
                   "--iterations", str(cfg["iterations"]),
                   "--out", named(out),
                   # So each generation draws deals no other generation has played. Without it the
                   # index alone seeds everything, and the index restarts at zero every round.
                   "--seed-prefix", f"gen{generation}",
                   "--temperature", str(cfg.get("temperature", 0)),
                   "--temperature-moves", str(cfg.get("temperature_moves", 15))]
        command += self.workers("selfplay", cfg)
        if cfg.get("search"):
            command += ["--search", json.dumps(cfg["search"])]
        if self.state["best"]["value"]:
            command += ["--net", self.state["best"]["value"]]
            # Generation zero has no policy net, and needs none: PUCT without priors falls back to
            # UCB1's expansion phase on its own, so `selection: puct` can be set from the start and
            # simply becomes true once there is something to consult.
            if cfg.get("use_policy") and self.state["best"]["policy"]:
                command += ["--policy", self.state["best"]["policy"]]

        self.runner.run(Task(
            name=f"gen{generation}-selfplay",
            command=command,
            log=self.run_dir / "logs" / f"gen{generation}-selfplay.log",
            # Any exit code. A sharded generation is judged by how many games landed, not by whether
            # every task returned zero -- one preempted node should not discard the other hundred.
            ok=None,
            resources="selfplay",
            shards=self.shards,
        ))
        if self.dry_run:
            return

        done, rows = self.written(generation)
        quorum = float(((self.config.get("runner") or {}).get("slurm") or {})
                       .get("selfplay", {}).get("quorum", 1.0))
        if done < wanted * quorum:
            raise SystemExit(
                f"\n  self-play produced {done:,} of {wanted:,} games "
                f"({done / max(1, wanted):.0%}), below the {quorum:.0%} quorum.\n"
                f"  Check the shard logs in {named(self.run_dir / 'logs')} before re-running."
            )
        if done < wanted:
            print(f"\n  {done:,} of {wanted:,} games ({done / wanted:.0%}) -- above the "
                  f"{quorum:.0%} quorum, carrying on with a short generation")

    def window(self, generation: int) -> list[str]:
        """The datasets to train on: this generation and the previous few.

        A window rather than the newest alone, because the value head's effective sample size is the
        number of *games*, and more games is the only lever measurement has consistently supported.
        Older generations come from weaker play, which is the cost. `window: 1` turns it off.

        Every shard of every generation in the window is passed separately. `load_window` offsets
        game ids per directory, so shards need no merging first -- and it is the same mechanism the
        window itself uses, which is why sharding cost the Python side nothing.
        """
        span = max(1, int(self.config["training"].get("window", 1)))
        first = max(0, generation - span + 1)
        dirs: list[Path] = []
        for g in range(first, generation + 1):
            found = self.existing(g)
            # Under --dry-run no self-play has actually happened, so fall back to the directories
            # the real run would have written. Otherwise the rendered trainer command would carry
            # no datasets at all, which is the one argument most worth seeing before submitting.
            dirs.extend(found or (self.datasets(g) if self.dry_run else []))
        return [named(d) for d in dirs]

    def train(self, generation: int, head: str, datasets: list[str]) -> tuple[Path, Task | None]:
        """Where one head's checkpoint goes, and the task that would produce it.

        Returns `None` for the task when the checkpoint is already there, which is how a resumed
        run skips a head that finished before the orchestrator was killed.

        The trainers use their exit code to carry a *verdict* -- 1 means the model did not beat the
        heuristic -- which is right for a script run by hand and wrong here. A generation that fails
        to clear that bar is a result to record and carry on from, not a crash. So the code is
        accepted and the artefact is checked instead: decide from what was written, never from what
        was printed or signalled.
        """
        cfg = self.config["training"][head]
        out = self.run_dir / "models" / f"gen{generation}-{head}"
        if (out / "model.json").exists():
            print(f"  already trained: {named(out)}")
            return out, None

        command = [sys.executable, f"tools/selfplay/train_{head}.py", *datasets,
                   "--save", named(out),
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
        # Warm start from the reigning checkpoint rather than random weights.
        #
        # The incumbent, not the previous generation, and the difference matters after a rejection:
        # generation 2 lost its gate, so generation 3 should carry on from generation 1 -- the best
        # weights anyone has -- rather than from a candidate already judged worse. It is the same
        # model self-play is using, which keeps one notion of "where we are" instead of two.
        #
        # Safe when the architecture changes: the loader compares layer shapes and declines, saying
        # so, rather than half-loading. And safe at generation zero, which has no incumbent.
        if self.config["training"].get("warm_start") and self.state["best"][head]:
            command += ["--init", self.state["best"][head]]
        return out, Task(
            name=f"gen{generation}-train-{head}",
            command=command,
            log=self.run_dir / "logs" / f"gen{generation}-train-{head}.log",
            ok=(0, 1),
            resources="train",
        )

    def train_both(self, generation: int, datasets: list[str]) -> dict:
        """Both heads, submitted together.

        They read the same datasets, write different checkpoints, and neither reads the other's
        output, so there is nothing to sequence. Under Slurm they go as two jobs and the step takes
        as long as the slower one; locally they still run one after another, since sharing one
        machine between them saves nothing. Either way the loop asks for both and waits for both.
        """
        wanted = {}
        pending = []
        for head in ("value", "policy"):
            out, task = self.train(generation, head, datasets)
            wanted[head] = out
            if task is not None:
                pending.append(task)
        self.runner.run_many(pending)
        if self.dry_run:
            return {head: named(out) for head, out in wanted.items()}
        for head, out in wanted.items():
            if not (out / "model.json").exists():
                raise SystemExit(f"\n  {head} training wrote no checkpoint to {out}")
        return {head: named(out) for head, out in wanted.items()}

    def play_task(self, name: str, generation: int, a: dict, b: dict,
                  cfg: dict) -> tuple[Path, Task | None]:
        """Where an arena's report goes, and the task that would produce it.

        `None` for the task when the report is already there, which is how a resumed run skips an
        arena it has already played. `a` and `b` are `{spec, net, policy}`.
        """
        report_path = self.run_dir / "reports" / f"gen{generation}-{name}.json"
        if report_path.exists():
            print(f"  already played: {named(report_path)}")
            return report_path, None
        report_path.parent.mkdir(parents=True, exist_ok=True)

        command = [NODE, "tools/selfplay/arena.mjs",
                   "--a", a["spec"], "--b", b["spec"],
                   "--pairs", str(max(1, int(cfg["games"]) // 2)),
                   "--iterations", str(cfg["iterations"]),
                   "--label-a", a["label"], "--label-b", b["label"],
                   "--report", named(report_path)]
        for side, player in (("a", a), ("b", b)):
            if player.get("net"):
                command += [f"--{side}-net", player["net"]]
            if player.get("policy"):
                command += [f"--{side}-policy", player["policy"]]
        command += self.workers("arena", cfg)
        return report_path, Task(
            name=f"gen{generation}-{name}",
            command=command,
            log=self.run_dir / "logs" / f"gen{generation}-{name}.log",
            resources="arena",
        )

    def report(self, path: Path) -> dict:
        if path.exists():
            return json.loads(path.read_text())
        if self.dry_run:
            # Nothing was played, so there is nothing to decide from. A neutral score keeps the
            # rehearsal walking through the remaining steps instead of stopping at the gate.
            return {"score": 0.5, "winsA": 0, "winsB": 0, "draws": 0, "ci": [0.0, 1.0], "elo": 0.0}
        raise SystemExit(f"\n  the arena wrote no report to {named(path)}")

    def play(self, name: str, generation: int, a: dict, b: dict, cfg: dict) -> dict:
        """One arena. What the gate uses, having only ever one to run."""
        path, task = self.play_task(name, generation, a, b, cfg)
        if task is not None:
            self.runner.run(task)
        return self.report(path)

    def gate(self, generation: int, candidate: dict) -> dict | None:
        """Candidate against incumbent. A measurement first and a veto second.

        The score it returns is the loop's only relative number and is recorded whatever it says.
        The caller promotes on it unless the interval rules out a tie, so this runs every generation
        even when the verdict is a foregone conclusion -- the series is the point.
        """
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

    def anchors(self) -> list[dict]:
        """The fixed opponents, as `{name, spec, net, report}`.

        Several rather than one, for two reasons. They saturate at different times -- `random` is
        pinned at 100% before the first generation is trained and measures nothing thereafter, while
        the heuristic search keeps resolving for a long while -- so a set spans a range and at least
        one of them is always still saying something. And playing strength is not a total order: a
        loop can drift into beating one opponent's particular weaknesses while going nowhere in
        general, which is precisely what a baseline exists to catch and precisely what a single
        opponent cannot see.

        The older single-`opponent` form still works and keeps its report name, so an existing run
        resumes without replaying anything.
        """
        cfg = self.config.get("baseline")
        if not cfg or not cfg.get("enabled", True):
            return []
        entries = cfg.get("opponents")
        if not entries:
            return [{"name": cfg.get("opponent", "random"), "spec": cfg.get("opponent", "random"),
                     "net": cfg.get("opponent_net"), "report": "baseline"}]
        out = []
        for entry in entries:
            if isinstance(entry, str):
                entry = {"name": entry, "spec": entry}
            name = entry["name"]
            out.append({"name": name, "spec": entry.get("spec", name),
                        "net": entry.get("opponent_net"), "report": f"baseline-{name}"})
        return out

    def baseline(self, generation: int) -> dict:
        """The reigning model against opponents that never change. `{name: report}`.

        The gate only ever compares neighbours, so a loop can clear it every time and still be going
        nowhere -- 56% against something 56% better than the thing before it is not the same as
        getting stronger, and the gate cannot tell the difference. This can.

        An anchor is only an anchor while it holds still. Pin the opponent's iteration count inside
        its own spec rather than leaving it to `baseline.iterations`, which the loop's operating
        point may drag along with it -- the spec wins over the flag in `arena.mjs`, so an anchor
        written that way survives a change of mind about the search.

        Submitted together, like the two training heads: the anchors share no state, read nothing
        of each other's, and the step costs as long as the slowest rather than their sum.
        """
        cfg = self.config.get("baseline") or {}
        paths, pending = {}, []
        for anchor in self.anchors():
            path, task = self.play_task(
                anchor["report"], generation,
                # Our side must search the way the loop actually searches, priors included. Leaving
                # the policy out here while the gate uses it would quietly measure a configuration
                # nobody ships -- a weaker one -- and the anchor series would understate the thing
                # it exists to track. Note that turning this on mid-run puts a one-off step in the
                # series, worth about the elo the priors are worth; the anchors themselves do not
                # move, so it stays readable, but it is a step and not progress.
                {"spec": json.dumps(cfg.get("search", {})), "label": f"gen{generation} best",
                 "net": self.state["best"]["value"],
                 "policy": self.state["best"]["policy"] if cfg.get("use_policy") else None},
                {"spec": anchor["spec"], "label": anchor["name"], "net": anchor.get("net")},
                cfg,
            )
            paths[anchor["name"]] = path
            if task is not None:
                pending.append(task)
        self.runner.run_many(pending)
        return {name: self.report(path) for name, path in paths.items()}

    def progress_table(self) -> None:
        """One row per generation, one column per anchor.

        Columns are collected from the history rather than from the config, so a run whose anchors
        changed part way through still prints every series it has, and a history written before
        there were several -- when `baseline` was a single number -- still prints too.
        """
        rows = [h for h in self.state["history"]]
        if not rows:
            return

        names: list[str] = []
        for h in rows:
            recorded = h.get("baseline")
            if isinstance(recorded, dict):
                names += [n for n in recorded if n not in names]
            elif recorded is not None and "baseline" not in names:
                names.append("baseline")

        def cells(h: dict) -> str:
            recorded = h.get("baseline")
            out = ""
            for name in names:
                if isinstance(recorded, dict):
                    score = recorded.get(name)
                else:
                    score = recorded if name == "baseline" else None
                out += f"{(f'{score:.1%}' if score is not None else '—'):>14}"
            return out

        print(f"\n{RULE}\n  progress so far\n{RULE}")
        print("  gen   arena       verdict  "
              + "".join(f"{('vs ' + n):>14}" for n in names) + "      model")
        for h in rows:
            gate = f"{h['score']:.1%}" if h.get("score") is not None else "unopposed"
            mark = "promoted" if h["accepted"] else "refused"
            print(f"  {h['generation']:>3}   {gate:>10}   {mark:<9}{cells(h)}      "
                  f"{Path(h['candidate']['value']).name}")
        print(flush=True)

    # -- the crank --------------------------------------------------------------------------

    def run(self) -> int:
        total = int(self.config["run"]["generations"])
        first = int(self.state["generation"])
        # Both heads train as one step, in parallel where the backend allows it.
        steps = 4 if self.config.get("baseline", {}).get("enabled", True) else 3

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
            step(2, steps, f"train value and policy heads — window of {len(datasets)}: "
                           f"{', '.join(datasets)}")
            candidate = self.train_both(generation, datasets)

            step(3, steps, f"arena — candidate vs incumbent, {self.config['arena']['games']} games, "
                           f"promote unless measurably worse")
            report = self.gate(generation, candidate)
            if report is None:
                accepted, score = True, None
            else:
                score = report["score"]
                low, high = report["ci"]
                # The interval decides, not the point estimate. `high < 0.5` is the only way to be
                # refused: the candidate has to be worse than even across the whole interval, so a
                # tie, a small loss and a loss the arena cannot resolve all promote. Reading `score`
                # against a threshold instead is what let 0.49 and 0.54 -- statistically the same
                # measurement -- reach opposite verdicts.
                accepted = high >= 0.5
                tally = f"{report['winsA']}-{report['winsB']}"
                if report["draws"]:
                    tally += f"-{report['draws']}"
                print(f"\n  {tally}   score {score:.1%}   95% CI [{low:.1%}, {high:.1%}]   "
                      f"elo {report['elo']:+.0f}")
                print(f"  → {'PROMOTED' if accepted else 'REFUSED'} "
                      + (f"(the interval reaches even; {score:.1%} is not measurably worse)"
                         if accepted else
                         f"(regression: the whole interval is below even, {high:.1%} < 50%)"))

            if accepted:
                self.state["best"] = candidate
            else:
                # The rejected candidate stays on disk. A generation that lost is data about the
                # loop, and deleting it is how you end up unable to answer why it stalled.
                print(f"  keeping incumbent: {self.state['best']['value']}")

            baseline_score = {}
            if steps == 4:
                anchors = self.anchors()
                step(4, steps, f"baseline — reigning model vs {len(anchors)} fixed "
                               f"opponent{'s' if len(anchors) != 1 else ''} "
                               f"({', '.join(a['name'] for a in anchors)}) — absolute progress")
                for name, base in self.baseline(generation).items():
                    baseline_score[name] = base["score"]
                    low, high = base["ci"]
                    print(f"\n  vs {name}: {base['winsA']}-{base['winsB']}   "
                          f"score {base['score']:.1%}   95% CI [{low:.1%}, {high:.1%}]   "
                          f"elo {base['elo']:+.0f}")

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
    parser.add_argument(
        "--dry-run", action="store_true",
        help="print what each step would run -- the job scripts, under the slurm runner -- and "
             "submit nothing. The cheap way to check a cluster config before it costs an allocation.",
    )
    args = parser.parse_args()
    config_path = Path(args.config)
    config = yaml.safe_load(config_path.read_text())
    kind = ((config.get("runner") or {}).get("kind") or "local")
    banner(f"self-play loop   ·   config: {config_path}   ·   runner: {kind}"
           + ("   ·   DRY RUN" if args.dry_run else ""), "═")
    return Loop(config, config_path, dry_run=args.dry_run).run()


if __name__ == "__main__":
    raise SystemExit(main())
