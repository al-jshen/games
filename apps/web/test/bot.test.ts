import { readFileSync } from 'node:fs';
import { GameClient } from '@games/client-sdk';
import { legalActionsFromView, type SplendorView } from '@games/splendor-duel';
import { startServer, type RunningServer } from '../../server/src/server.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/bot/engine.js';
import { startBot } from '../src/bot/player.js';
import { PUBLISHED, publishedEngine } from './published-engine.js';

/**
 * The bot opponent, against the real server.
 *
 * A search test would tell you the network picks reasonable moves and nothing about whether a bot
 * can *play a game* — and the parts most likely to break are the ones either side of the search: the
 * join handshake that gets it a seat, the turn detection that has to survive a turn made of several
 * actions, and putting a seat back after a reload. All three are here, and none of them needs a
 * browser: `player.ts` is separated from its worker precisely so this file can exist.
 *
 * It also loads the checkpoints that `apps/web/public` actually ships, so a bad publish is caught
 * here rather than by a player watching a blank sidebar.
 */

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(25);
  }
}

describe('the bot opponent', () => {
  let server: RunningServer;
  let engine: Engine;
  let url: string;

  beforeAll(async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', storeKind: 'memory', quiet: true });
    url = `${server.url.replace('http', 'ws')}/ws`;
    engine = publishedEngine();
  });

  afterAll(async () => {
    await server?.close();
  });

  it('loads the published checkpoints, and the manifest describes what actually shipped', () => {
    expect(engine.value.kind).toBe('value');
    expect(engine.policy.kind).toBe('policy');
    expect(engine.deps.priors).toBeDefined();

    /*
     * Checked against `bot.json` rather than against literal parameter counts.
     *
     * Literals were the first version and they were the wrong test: they pin the *architecture*,
     * which is a thing the loop is allowed to change, so publishing a generation with a wider trunk
     * would fail here for no reason anyone should have to think about. What must hold is that the
     * manifest and the weights agree -- the panel reads `bot.json` to say which generation you are
     * playing, so a manifest describing a different checkout from the one being served is exactly
     * the failure that would go unnoticed.
     *
     * `makeNet` has already refused a blob whose length disagrees with its own sidecar, which is the
     * other half: a truncated file otherwise reads as a network whose last layer is full of whatever
     * followed it, and plays on regardless.
     */
    const manifest = JSON.parse(readFileSync(`${PUBLISHED}/bot.json`, 'utf8')) as {
      generation: number;
      value: { parameters: number };
      policy: { parameters: number };
    };
    expect(engine.value.sidecar.parameters).toBe(manifest.value.parameters);
    expect(engine.policy.sidecar.parameters).toBe(manifest.policy.parameters);
    expect(manifest.generation).toBeGreaterThanOrEqual(0);
  });

  it('takes a seat and plays a game out against a random opponent', async () => {
    let code: string | null = null;
    let finished: { winners: number[] } | null = null;
    let searches = 0;
    let humanActions = 0;

    const human = new GameClient({
      url,
      storage: memoryStorage(),
      onChange: (state) => {
        if (state.code) code ??= state.code;
        if (!state.confirmed || state.seat === null) return;
        const outcome = state.confirmed.outcome;
        if (outcome?.status === 'over') {
          finished ??= { winners: outcome.winners };
          return;
        }
        if (!state.actors.includes(state.seat) || state.pending) return;
        const { actions } = legalActionsFromView(state.view as SplendorView, state.seat);
        if (actions.length === 0) return;
        humanActions += 1;
        human.submit(actions[Math.floor(Math.random() * actions.length)]);
      },
    });
    human.connect();
    human.createMatch('splendor-duel', 'Human');
    await until(() => code !== null, 5000, 'the match to be created');

    const bot = startBot({
      engine,
      url,
      code: code as unknown as string,
      name: 'Bot',
      iterations: 60,
      explore: { temperature: 0, moves: 0 },
      minThinkMs: 0,
      token: null,
      seed: 'test',
      onThinking: (on) => {
        if (on) searches += 1;
      },
      onError: (message) => {
        throw new Error(message);
      },
    });

    await until(() => finished !== null, 50_000, 'the game to finish');
    expect(bot.client.state.seat).toBe(1);
    expect(searches).toBeGreaterThan(10);
    expect(humanActions).toBeGreaterThan(10);
    /*
     * 60 simulations is well below the weakest level the app offers, and the opponent is uniformly
     * random. Asserting the bot wins would be asserting a probability; asserting the game *resolved*
     * is what this test is actually about, and it is deterministic.
     */
    expect(finished).not.toBeNull();

    bot.stop();
    human.close();
  });

  it('puts the bot back in its own seat when it restarts with its token', async () => {
    let code: string | null = null;
    let token: string | null = null;
    let humanTurns = false;

    const human = new GameClient({
      url,
      storage: memoryStorage(),
      onChange: (state) => {
        if (state.code) code ??= state.code;
        if (!humanTurns || !state.confirmed || state.seat === null) return;
        if (state.confirmed.outcome?.status === 'over') return;
        if (!state.actors.includes(state.seat) || state.pending) return;
        const { actions } = legalActionsFromView(state.view as SplendorView, state.seat);
        if (actions.length) human.submit(actions[0]);
      },
    });
    human.connect();
    human.createMatch('splendor-duel', 'Human');
    await until(() => code !== null, 5000, 'the match to be created');

    const spawn = (seed: string, held: string | null) =>
      startBot({
        engine,
        url,
        code: code as unknown as string,
        name: 'Bot',
        iterations: 40,
        explore: { temperature: 0, moves: 0 },
        minThinkMs: 0,
        token: held,
        seed,
        onToken: (_code, issued) => {
          token = issued;
        },
        onError: (message) => {
          throw new Error(message);
        },
      });

    const first = spawn('one', null);
    humanTurns = true;
    await until(() => human.state.version >= 4, 30_000, 'a few moves to be played');
    expect(token).not.toBeNull();
    const seat = first.client.state.seat;
    expect(seat).toBe(1);

    // The reload: a brand new bot holding only what the page kept in `localStorage`.
    first.stop();
    await wait(200);
    const second = spawn('two', token);
    await until(() => second.client.state.seat !== null, 10_000, 'the bot to reclaim its seat');
    expect(second.client.state.seat).toBe(seat);
    // Both seats still filled by the people who held them: the restart reclaimed rather than added.
    expect(human.state.players).toHaveLength(2);

    const before = human.state.version;
    await until(() => human.state.version > before, 30_000, 'play to continue after the restart');

    second.stop();
    human.close();
  });
});
