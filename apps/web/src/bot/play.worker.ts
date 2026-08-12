/// <reference lib="webworker" />

/**
 * The worker shell around `player.ts`: fetch the checkpoints, start the bot, relay what it says.
 *
 * There is nothing else here on purpose. A search is a synchronous tree walk with a matrix multiply
 * at every leaf, and at full strength that is most of a second with no yield in it — on the main
 * thread the board would freeze, the animations would stall and the browser would offer to kill the
 * tab. So the network never enters the main bundle at all: the 3MB of policy weights are fetched by
 * a worker, in a worker, and the page above it stays a page.
 *
 * The behaviour lives next door because it does not need a browser and is worth testing without one.
 */

import type { FromBot, ToBot } from './bot.js';
import { loadEngine } from './engine.js';
import { startBot, type RunningBot } from './player.js';

declare const self: DedicatedWorkerGlobalScope;

const post = (message: FromBot): void => self.postMessage(message);

let bot: RunningBot | null = null;
let stopped = false;

self.onmessage = (event: MessageEvent<ToBot>) => {
  const message = event.data;
  if (message.t === 'stop') {
    stopped = true;
    bot?.stop();
    bot = null;
    return;
  }
  void start(message);
};

async function start(message: Extract<ToBot, { t: 'start' }>): Promise<void> {
  if (bot) return; // A second `start` is a bug in the caller, not a request to double-seat.

  let engine;
  try {
    engine = await loadEngine(message.base);
  } catch (error) {
    post({ t: 'error', message: `Could not load the bot's network: ${(error as Error).message}` });
    return;
  }
  if (stopped) return;

  post({ t: 'ready' });
  bot = startBot({
    engine,
    url: message.url,
    code: message.code,
    name: message.name,
    iterations: message.level.iterations,
    explore: message.level.explore,
    minThinkMs: message.level.minThinkMs,
    token: message.token,
    seed: message.seed,
    // A token issued under a different code means the room moved -- a rematch -- and the caller
    // stores the two under different keys, so the distinction is made here rather than there.
    onToken: (code, token) =>
      post(code === message.code ? { t: 'token', code, token } : { t: 'rematch', code, token }),
    onThinking: (on) => post({ t: 'thinking', on }),
    onError: (text) => post({ t: 'error', message: text }),
  });
}
