/**
 * A fixed pool of workers pulling jobs off a queue.
 *
 * Deliberately pull-based rather than dealing the jobs out up front: games vary enormously in length
 * -- a decisive one can be a third of a stalled one -- so a worker handed a fixed share would sit
 * idle while another finished a long tail.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { setImmediate } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { playGame } from './game.mjs';

export function defaultWorkers() {
  /*
   * One core for the parent, the rest for work.
   *
   * There used to be a ceiling of 16 here, from when this only ever ran on a laptop, and it is a
   * real cost on anything bigger: measured over 1,000 games on 96 cores, lifting it took generation
   * from 1.44 games/s to 4.41.
   *
   * One core and no more, because the parent turns out to need almost nothing. It looks like it
   * should -- it packs ~340KB of Float32Array per game and appends six files -- but measured mid-run
   * it sits at 1.2% of a core, the work being rare and mostly I/O. An earlier version of this
   * reserved a sixteenth of the machine on that bad intuition and left ~5.6 cores idle.
   */
  return Math.max(1, availableParallelism() - 1);
}

/**
 * Run every job, optionally handing each result to `onResult` as it lands.
 *
 * With a callback the results are not retained, which is the point of having one: a long generation
 * run holds a few hundred thousand rows of training data and there is no reason for the parent to
 * keep any of it once it has been written. Results arrive in completion order, not job order --
 * a caller that needs the original order should say so with the index it is given.
 */
export async function runJobs(jobs, workerCount, onResult) {
  const results = new Array(onResult ? 0 : jobs.length);
  const deliver = (result, index) => {
    if (onResult) onResult(result, index);
    else results[index] = result;
  };

  if (workerCount <= 1) {
    for (const [index, job] of jobs.entries()) {
      deliver({ ok: true, ...playGame(job) }, index);
      /*
       * Yield, so a caller writing results to disk actually gets to. Without this the whole run
       * completes before anything else does, and an interrupted one writes nothing -- the single
       * thing the incremental writer exists to prevent.
       *
       * `setImmediate` rather than `await null`: the latter drains microtasks only, and a file write
       * finishes on an I/O callback, so the writes would queue up and still land in a heap at the
       * end. This yields the event loop far enough round to run them.
       */
      await new Promise(setImmediate);
    }
    return results;
  }

  const url = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  let next = 0;

  const workers = Array.from({ length: Math.min(workerCount, jobs.length) }, () => new Worker(url));
  try {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise((resolve, reject) => {
            const take = () => {
              if (next >= jobs.length) return resolve();
              const index = next++;
              worker.once('message', (result) => {
                if (!result.ok) return reject(new Error(result.message));
                // A throwing `onResult` stops the run. Left to propagate out of the message handler
                // it would be an unhandled rejection and the pool would keep going for hours,
                // discarding every game, so the caller's failure has to become the pool's.
                try {
                  deliver(result, index);
                } catch (error) {
                  return reject(error);
                }
                take();
              });
              worker.postMessage(jobs[index]);
            };
            worker.once('error', reject);
            take();
          }),
      ),
    );
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  return results;
}
