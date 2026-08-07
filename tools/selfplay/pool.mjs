/**
 * A fixed pool of workers pulling jobs off a queue.
 *
 * Deliberately pull-based rather than dealing the jobs out up front: games vary enormously in length
 * -- a decisive one can be a third of a stalled one -- so a worker handed a fixed share would sit
 * idle while another finished a long tail.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { playGame } from './game.mjs';

export function defaultWorkers() {
  // Leave one core for the parent and whatever else the machine is doing.
  return Math.max(1, Math.min(16, availableParallelism() - 1));
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
    jobs.forEach((job, index) => deliver({ ok: true, ...playGame(job) }, index));
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
                deliver(result, index);
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
