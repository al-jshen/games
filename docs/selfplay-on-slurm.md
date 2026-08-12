# The self-play loop on Slurm

`tools/selfplay/loop.py` turns the crank on one machine: self-play, train, gate, promote, repeat. It
is the right shape and the wrong scale. Self-play is embarrassingly parallel and pinned to one box's
cores, and training wants a GPU the box may not have.

`loop.py` is now the orchestrator for both cases, choosing a backend from config: run every step as
a local subprocess, or submit each one to Slurm and wait. The loop's structure, its state file, and
its decisions do not change.

**Status: implemented.** What follows describes what is there, and §7 is what remains.

Nothing here has been submitted. Every `sbatch` below is illustrative; submission is manual.

---

## 1. Shape: one seam, two backends

Every step `loop.py` runs goes through a single function:

```python
def sh(command: list[str], log: Path, ok: tuple[int, ...] = (0,)) -> None:
```

It builds a command, runs it with `cwd=ROOT`, streams the output to the terminal and a log file, and
raises on an unexpected exit code. Self-play, both trainers, and both arenas all go through it. That
function is the entire integration point.

The Slurm backend wraps the same command in `sbatch --wait` instead of running it directly. `--wait`
blocks until the job finishes and propagates its exit status, so `sh`'s contract is unchanged: run
this, tell me when it is done, tell me if it failed. Everything built on top — the resumability, the
artefact checks, the gate, the promotion, the progress table — is untouched.

```
loop.py  ──►  sh(command, log, ok)
                    │
        ┌───────────┴────────────┐
        │                        │
   runner: local           runner: slurm
        │                        │
  subprocess.Popen        sbatch --wait --array=... wrapper.sh
   (as today)              (streams the job's log back)
```

**Use `sbatch --wait`, not a polling loop.** The tempting implementation is submit-then-poll
`squeue` every few seconds. Do not: the scheduler is shared by hundreds of users and a poll loop per
step, times a run of days, is real load on it. `--wait` is the supported mechanism and costs the
scheduler nothing extra.

### Where the orchestrator lives

`loop.py` becomes a small, long-lived process: it sleeps inside `sbatch --wait` and does nothing
else. Run it in `tmux` on a workstation, or as a 1-core job with a long walltime.

It is not precious. If it dies, the submitted job keeps running — it is detached — and re-running
`loop.py` picks up from `state.json` and the artefacts on disk, which is exactly what it already does
after a local kill. The one new hazard is *resubmitting a step that is still running*; see §4.

### What each step becomes

| step | backend | resources |
|---|---|---|
| self-play | job **array**, one node per shard | CPU, `nodes` machines |
| train value | one job, submitted alongside policy | GPU |
| train policy | one job, submitted alongside value | GPU |
| gate arena | one job | CPU, one node |
| baseline arena | one job | CPU, one node |

`nodes` and `cpus_per_node` are the only scaling knobs. For self-play, `nodes` is both the machine
count and the array width, because each task is a one-node job playing its own slice: 25,000 games
over 10 nodes is `--array=0-9`, `--cpus-per-task=64`, 2,500 games each.

The arenas stay single jobs. At 300 games against 25,000 they are not where the time goes, and
sharding them would mean a report-merge step and a second sharding implementation for no measured
benefit.

The two trainers are submitted together and waited on together. They read the same datasets, write
different checkpoints, and neither reads the other's output, so there is nothing to sequence — the
step takes as long as the slower head. This also halves peak GPU memory per job, since the value job
never materialises `pi`. Locally they still run one after another; sharing one machine between them
would save nothing. There is no toggle: the backend decides.

---

## 2. What already works

- **Self-play sharding.** `--num-shards` / `--shard-id`, committed in `84f4658`, verified to
  reproduce a single-process run bit for bit. This is what the array maps onto.
- **Multi-directory training.** `load_window()` offsets game ids per directory and `train_*.py` take
  `nargs="+"`, so `gen{G}/shard*` needs no merge before training.
- **Idempotent steps.** Every step already skips when its artefact exists. That is what makes a
  killed orchestrator, a requeued job, and a resumed run all cheap.
- **Decisions from artefacts.** The dataset sidecar, `model.json` and the arena `--report` are what
  the loop reads. No step parses another's stdout, which matters more when stdout is arriving via a
  batch system.

---

## 3. What has to be built

| # | Item | Where | Size |
|---|------|-------|------|
| 1 | `runner` config group | `loop.yaml` | small |
| 2 | Backend dispatch in `sh()` | `loop.py` | small — the seam already exists |
| 3 | Job-script rendering | `loop.py` or `tools/selfplay/slurm.py` | moderate — resources per step, env, log paths |
| 4 | Array support for self-play | `loop.py` | moderate — the one step whose command differs per task |
| 5 | Submitted-job bookkeeping | `state.json` | small, and see §4 |
| 6 | Quorum check before training | `loop.py` | small — count `games`, not `seeds` |
| 7 | `--dry-run` | `loop.py` | small, and the only cheap way to test this |

Item 4 is the only structurally new thing: for self-play the command is a function of
`$SLURM_ARRAY_TASK_ID` rather than fixed, so `sh()` needs to take either a command or a command
template. Everything else is configuration and plumbing.

### Config sketch

```yaml
runner:
  kind: local              # local | slurm
  slurm:
    account: null          # --account, when the cluster wants one
    env: {}                # exported at the top of every job script

    # One generate.mjs per node, each playing its own slice into gen{N}/shard{i}/.
    selfplay:
      nodes: 128
      cpus_per_node: 64    # --cpus-per-task, and --workers
      partition: ccm
      time: "04:00:00"
      quorum: 1.0          # carry on anyway if this fraction of games landed

    train:
      nodes: 1
      cpus_per_node: 8
      gres: "gpu:1"
      partition: gpu
      time: "02:00:00"

    arena:
      nodes: 1
      cpus_per_node: 64
      partition: ccm
      time: "01:00:00"
```

`kind: local` reproduces today's behaviour exactly, and the rest of `loop.yaml` keeps its current
meaning under both backends.

---

## 4. The things that will bite

### A restarted orchestrator must not resubmit a running step

This is the one genuinely new failure mode. Kill `loop.py` while a four-hour self-play array is
running, restart it, and the artefact does not exist yet — so it happily submits a second array
writing to the same directories. Two writers, interleaved appends, a corrupt dataset.

A lock file per step, written under `<run>/slurm/locks/` at submission and removed on completion,
closes the window without asking the scheduler anything at all. On startup the loop refuses to
proceed while any lock is present, and prints the `squeue` invocation to check with.

Deliberately not self-healing. The obvious refinement is to query `sacct -j <id>` once and clear the
lock if the job is long dead, but deciding on your behalf that a job has died is exactly the
judgement that should not be automated: guess wrong and two writers interleave into the same blobs.
Removing a stale lock is one `rm` and the message says so.

### `sbatch --wait` returns non-zero if any array task failed

Which is right, and is also the wrong thing to abort on. One preempted node in a 128-task array
should not throw away 127 shards of work — a short dataset is *valid*, which is the whole point of
the append-and-republish format.

So self-play should pass `ok=` accepting any exit code and then decide from the artefacts: sum the
`games` field across `gen{G}/shard*` and refuse only if the total is below `quorum`. This is exactly
the pattern `train()` already uses for the trainers' verdict exit codes.

### Atomicity is not load-bearing here, but it is one step away

Because steps are serialised behind `--wait`, no job reads a dataset another job is writing, and the
non-atomic `writeFile(dataset.json)` and `checkpoint.save()` never race.

That stops being true the moment anything overlaps: accepting a quorum while stragglers still run,
or the concurrent generate-while-training variant. Both are plausible enough that the
tmp-file + `rename` fix is worth doing before it manifests as an intermittent `JSONDecodeError` at
hour nine. The checkpoint case is the nastier one — `save()` writes `weights.f32` then `model.json`,
so a reader catching it mid-write can get an old sidecar over a half-overwritten blob *of the same
size*, passing the `parameters` check and producing a network that is part one generation and part
another. Publish to a fresh directory and flip a symlink; never overwrite a checkpoint path.

### GPU memory

A window of two generations at 25,000 games is ~3.2M rows. `x` alone is
`3.2e6 × 719 × 4 B ≈ 9.2 GB`; `pi` is another ~3 GB. `resident()` moves the split onto the device and
falls back to CPU on OOM — quietly, and the fallback is slow enough to make a GPU job pointless.

Measure this before the first full-size run, not after. Splitting the heads into separate jobs helps,
since the value job never materialises `pi`. If it still does not fit: a smaller window, `float16`
features, or batching from host memory — the last being a real change to `resident()`.

### Inodes

128 shards × 7 files is ~900 files per generation, which is fine. 2,000 shards is 14,000 per
generation and 280,000 over a 20-generation run, against a GPFS inode quota that is not enormous.
Prefer fewer, larger shards; failing that, consolidate a generation's shards after training.

Size shards by wall clock rather than by core count. ~30–60 minutes per task backfills well and
requeues cheaply.

### The rest

- **`/dev/shm` cannot be the run directory.** Node-local tmpfs; shards would scatter and vanish. The
  run directory must be GPFS or Ceph. At ~8 GB per generation with a window keeping the previous
  ones, Ceph is the right home. `run.dir` already accepts an absolute path.
- **`--workers` must be `$SLURM_CPUS_ON_NODE`.** `defaultWorkers()` reads `availableParallelism()`,
  which sees the machine rather than the cgroup, and will oversubscribe a shared node.
- **`requireFreshBuild()`** runs in every task. Build `dist/` once on the shared filesystem before
  submitting, or 128 tasks each discover the same staleness.
- **`node` and `uv` must resolve on compute nodes.** Both currently come from the interactive
  environment; the job script should set them explicitly, hence `runner.slurm.node` / `.python`.
- **Log streaming.** Local `sh()` streams output live, which matters for the carriage-return progress
  lines. Under Slurm the output goes to the job's file; the wrapper should point `--output` at the
  same log path `sh()` would have written, and tail it while waiting so the terminal still shows
  progress.

---

## 5. Testing it without burning an allocation

- `runner.kind: local` at 10 games — the existing smoke path, and it stays the fastest way to
  exercise the state machine, the gate and the promotion logic end to end.
- `--dry-run` under `runner.kind: slurm` — render and print every job script and the submission
  order, submit nothing. Catches the majority of path, environment and resource mistakes.
- One small real generation — a 4-shard array and a short arena — before committing to full size.

---

## 6. Order of work

1. `runner` config group and the `sh()` dispatch (items 1, 2, 3) with `--dry-run` (item 7). No
   cluster needed to develop or test this.
2. Array support for self-play (item 4). The only new structure.
3. Job bookkeeping in `state.json` (item 5). Small, and prevents the one corruption this design
   introduces.
4. One small real generation. Fix the environment and path problems that only appear on a compute
   node.
5. Quorum handling (item 6), once there is evidence about how often tasks actually fail.
6. Measure GPU memory against a real window before the first full-size run.
7. Atomic sidecar and checkpoint publish, before anything overlapping is attempted.
