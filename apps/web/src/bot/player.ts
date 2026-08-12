/**
 * The bot's actual behaviour: take a seat, and when it is your turn, move.
 *
 * Separated from `play.worker.ts` so that it can be run without a browser. Everything here needs is
 * a `WebSocket` and a `setTimeout`, both of which node has had as globals since 22 — so a test can
 * boot the real server, seat a real bot, and play a real game to its end. That is worth the extra
 * file: the parts most likely to be wrong are the seating handshake and the turn detection, and
 * neither is visible from a unit test of the search.
 *
 * **The server does not know this is a bot, and nothing in `apps/server` or `packages/protocol` was
 * changed to support it.** It opens an ordinary socket, sends an ordinary `join`, is given an
 * ordinary seat, and submits ordinary actions. Everything the room already does — presence, the move
 * log, undo, persistence, the replay you can step through afterwards — works on a bot match because
 * there is nothing special about it to break.
 *
 * That is possible because of one deliberate affordance in the game module: `determinize` and
 * `encodeView` take a *view*, not a state. A seated player only ever receives their own redacted
 * view, so a bot that could search only from truth would have to run somewhere with access it should
 * not have. Searching from the view is also simply correct — it is the same uncertainty the human
 * across the table is playing under.
 */

import { GameClient, seatTokenKey, type MatchState } from '@games/client-sdk';
import { RandomCursor } from '@games/engine';
import { pickAction } from '@games/bot-splendor-duel';
import type { SplendorView } from '@games/splendor-duel';
import { think, type Engine } from './engine.js';

/**
 * How many times to re-search at the same version before giving up.
 *
 * A rejected action does not advance the version, so without a cap a bot whose move the server keeps
 * refusing would search, submit, be refused, and search again for ever — a hot loop the player
 * cannot see and cannot stop. Three rides out a genuine race with the other seat, and is short
 * enough that a real disagreement about the rules surfaces as a message rather than as a fan.
 */
const MAX_ATTEMPTS = 3;

export interface BotOptions {
  engine: Engine;
  url: string;
  code: string;
  name: string;
  iterations: number;
  explore: { temperature: number; moves: number };
  /** Floor on how long a move appears to take. Presentation; the search has already finished. */
  minThinkMs: number;
  /** The bot's own seat token, when it has played here before. Null takes a fresh seat. */
  token: string | null;
  seed: string;
  /** A token worth persisting, as the server issues it. The caller owns storage; a worker has none. */
  onToken?: (code: string, token: string) => void;
  /** Between `true` and `false` the bot is inside a search and answering nothing. */
  onThinking?: (on: boolean) => void;
  onError?: (message: string) => void;
}

export interface RunningBot {
  /** The underlying client, for tests that want to watch the same state the bot sees. */
  client: GameClient;
  stop: () => void;
}

export function startBot(options: BotOptions): RunningBot {
  let stopped = false;
  let ourMove = 0;
  const exploreRng = new RandomCursor(`explore:${options.seed}`, 0);
  /** The version we last searched at, and how many times. See `MAX_ATTEMPTS`. */
  let attemptedAt = -1;
  let attempts = 0;
  let busy = false;

  /*
   * Storage that lives and dies with this bot.
   *
   * A worker has no `localStorage`, and that turns out to be the right shape anyway: the bot's seat
   * token must not land under the key the *human's* seat for this same room uses, and it must not
   * appear in "your games in progress" — nobody wants to resume as the bot. So it is held here and
   * handed outward as it is issued, for the caller to put wherever it belongs.
   */
  const held = new Map<string, string>();
  if (options.token) held.set(seatTokenKey(options.code), options.token);
  const storage = {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => {
      held.set(key, value);
      options.onToken?.(key.slice(key.indexOf(':') + 1), value);
    },
    removeItem: (key: string) => void held.delete(key),
  };

  const client = new GameClient({
    url: options.url,
    storage,
    onChange: (state) => void react(state),
  });

  async function react(state: MatchState): Promise<void> {
    if (stopped || busy) return;

    /*
     * Agree to any undo, without needing to be asked twice.
     *
     * Undo is mutual because taking a move back after seeing what it revealed is a way to cheat a
     * *person*. There is nobody here to cheat: a bot has no feelings about a takeback and no
     * information it is being deprived of. Refusing would only mean the button never works.
     */
    if (state.undo && state.undo.by !== state.seat) {
      client.respondUndo(true);
      return;
    }

    const seat = state.seat;
    if (seat === null || !state.confirmed) return;
    if (state.confirmed.outcome?.status === 'over') return;
    if (!state.actors.includes(seat)) return;

    if (state.version === attemptedAt) {
      // The same position we already answered. Either the server has not applied it yet — nothing to
      // do — or it refused, and `error` is set. Only the refusal is worth another try, and only a
      // few.
      if (!state.error || attempts >= MAX_ATTEMPTS) return;
    } else {
      attemptedAt = state.version;
      attempts = 0;
    }
    attempts += 1;

    busy = true;
    options.onThinking?.(true);
    try {
      await move(state, seat);
    } catch (error) {
      options.onError?.(`The bot failed to move: ${(error as Error).message}`);
    } finally {
      busy = false;
      options.onThinking?.(false);
    }
  }

  async function move(state: MatchState, seat: number): Promise<void> {
    /*
     * A copy, because the search hands this view to `determinize` a thousand times and sharing one
     * object across a tree walk is the kind of aliasing that produces a bug nobody can reproduce.
     * `state.view` is the server's confirmed snapshot — no prediction adapter is registered on this
     * client, deliberately, so there is never a locally-guessed position to search from.
     */
    const view = structuredClone(state.view) as SplendorView;
    const started = Date.now();
    const result = think(options.engine, view, seat, options.iterations, `${options.seed}:${ourMove}`);
    const action = pickAction(result.ranking, ourMove, options.explore, exploreRng);
    ourMove += 1;

    const remaining = options.minThinkMs - (Date.now() - started);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    if (stopped) return;
    client.submit(action);
  }

  /*
   * With a token, `connect` resumes the seat through the handshake and no `join` is wanted — asking
   * to join a room we already hold a seat in would be answered with "that match is full". Without
   * one, connect first and join when the handshake lands, which is what the app itself does.
   */
  if (options.token) {
    client.connect(options.code);
  } else {
    client.connect();
    client.joinMatch(options.code, options.name);
  }

  return {
    client,
    stop: () => {
      stopped = true;
      client.close();
    },
  };
}
