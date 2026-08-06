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

export async function runJobs(jobs, workerCount) {
  if (workerCount <= 1) return jobs.map((job) => ({ ok: true, ...playGame(job) }));

  const url = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const results = new Array(jobs.length);
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
                results[index] = result;
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
