/**
 * One self-play game per message.
 *
 * Worth the thread rather than a process: the engine is pure with no I/O and nothing is shared, so
 * the only cost of parallelism is the structured clone of a job description and a result. No locks,
 * no coordination, and no way for one game to affect another.
 */
import { parentPort } from 'node:worker_threads';
import { playGame } from './game.mjs';

parentPort.on('message', (job) => {
  try {
    parentPort.postMessage({ ok: true, ...playGame(job) });
  } catch (error) {
    parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
