/// <reference lib="webworker" />

/**
 * The worker shell around `analyse.ts`: load the checkpoints, answer the newest question, repeat.
 *
 * No socket and no seat. It is handed a view, it says what it thinks, and it never touches the
 * board -- which is the whole difference between this and `play.worker.ts`, and why they are
 * separate files despite sharing an engine.
 *
 * Stale requests are dropped rather than queued. The position moves on while a search runs, and an
 * answer about a board two moves old looks exactly like an answer about this one -- which is the
 * more dangerous for it. The `id` carries that: the main thread ignores anything it is not waiting
 * for, and this side never starts a search it already knows is obsolete.
 */

import type { FromCoach, ToCoach } from './bot.js';
import { analyse } from './analyse.js';
import { loadEngine, type Engine } from './engine.js';
import type { SplendorView } from '@games/splendor-duel';

declare const self: DedicatedWorkerGlobalScope;

const post = (message: FromCoach): void => self.postMessage(message);

let engine: Engine | null = null;
/** At most one pending request, and it is always the newest. */
let queued: Extract<ToCoach, { t: 'look' }> | null = null;
let scheduled = false;

self.onmessage = (event: MessageEvent<ToCoach>) => {
  const message = event.data;
  if (message.t === 'load') {
    void load(message.base);
    return;
  }
  queued = message;
  schedule();
};

async function load(base: string): Promise<void> {
  try {
    engine = await loadEngine(base);
    post({ t: 'ready' });
    schedule();
  } catch (error) {
    post({ t: 'error', message: `Could not load the coach's network: ${(error as Error).message}` });
  }
}

/**
 * Run the pending request on a fresh task rather than inline.
 *
 * The search is synchronous and blocks this thread outright, so anything that arrives while it runs
 * waits in the event queue and lands here afterwards. Going through a timer means those messages get
 * to overwrite `queued` first -- so after a long search the coach looks at where the game *is*,
 * rather than working through where it has been.
 */
function schedule(): void {
  if (scheduled || !engine || !queued) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    const request = queued;
    const loaded = engine;
    queued = null;
    if (!request || !loaded) return;
    try {
      const reading = analyse(loaded, {
        view: request.view as SplendorView,
        seat: request.seat,
        yourTurn: request.yourTurn,
        iterations: request.iterations,
        seed: `coach:${request.id}`,
      });
      post({ t: 'read', id: request.id, ...reading });
    } catch (error) {
      post({ t: 'error', message: `The coach failed: ${(error as Error).message}` });
    }
    schedule();
  }, 0);
}
