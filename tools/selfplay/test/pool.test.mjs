import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultWorkers, runJobs } from '../pool.mjs';

/**
 * The pool's failures are all quiet ones. A run that discards its results, a default that leaves
 * most of the machine idle, and a caller that never gets to write anything until the end all look
 * exactly like a slow but working generation, and the only symptom is hours of wasted CPU.
 *
 * Jobs here are random-vs-random so a game costs a fraction of a millisecond. The pool does not know
 * what a player is, so this tests everything about it that matters.
 */

const randomGame = (index) => ({
  seed: `pool-${index}`,
  game: index,
  gameIndex: index,
  record: false,
  aFirst: index % 2 === 0,
  a: { kind: 'random', seed: `a${index}` },
  b: { kind: 'random', seed: `b${index}` },
});

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'games-pool-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the self-play worker pool', () => {
  it('gives the whole machine to the workers, holding nothing back for the parent', () => {
    const cores = availableParallelism();
    expect(defaultWorkers()).toBe(Math.max(1, cores));
    /*
     * The ceiling that used to be here read `Math.min(16, ...)`, which is invisible on a laptop and
     * enormous on anything else -- on the 96-core machine this is meant to run on it left 80 cores
     * unused, which at the measured rates is the difference between 1h34m and 4h49m for 25,000
     * games.
     */
    if (cores > 32) expect(defaultWorkers()).toBeGreaterThan(cores / 2);
  });

  it('runs every job exactly once and returns them in job order', async () => {
    const jobs = Array.from({ length: 12 }, (_, i) => randomGame(i));
    const results = await runJobs(jobs, 3);
    expect(results).toHaveLength(12);
    // Workers finish out of order; a result landing in the wrong slot would mislabel a whole game.
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => typeof r.moves)).toEqual(Array(12).fill('number'));
  });

  it('stops the run when the caller cannot take a result', async () => {
    /*
     * The caller is writing to disk, so a throw means the disk is full or gone -- it will not fix
     * itself, and every game generated after it is discarded. Left to propagate out of the worker's
     * message handler this would be an unhandled rejection and the pool would carry on for hours.
     */
    const jobs = Array.from({ length: 60 }, (_, i) => randomGame(i));
    let delivered = 0;
    await expect(
      runJobs(jobs, 3, () => {
        delivered += 1;
        if (delivered === 3) throw new Error('no space left on device');
      }),
    ).rejects.toThrow('no space left on device');
    expect(delivered).toBeLessThan(jobs.length);
  });

  it('lets a single worker’s caller finish writing while the run is still going', async () => {
    /*
     * The point of the incremental writer is that an interrupted run keeps what it had. That needs
     * the pool to yield between jobs, and to yield far enough round the event loop for an I/O
     * completion -- a bare microtask checkpoint would leave every write queued until the end, which
     * looks identical right up until something kills the process.
     */
    const jobs = Array.from({ length: 6 }, (_, i) => randomGame(i));
    const written = [];
    const completedByDelivery = [];
    let chain = Promise.resolve();

    await runJobs(jobs, 1, (_result, index) => {
      completedByDelivery.push(written.length);
      chain = chain.then(async () => {
        await writeFile(join(dir, `row-${index}`), 'x');
        written.push(index);
      });
    });
    await chain;

    expect(written).toEqual([0, 1, 2, 3, 4, 5]);
    // Without a real yield every entry here would be 0: nothing written until the run was over.
    expect(completedByDelivery.at(-1)).toBeGreaterThan(0);
  });
});
