/**
 * Spawn the bot for a room, keep its seat, and tell the UI what it is doing.
 *
 * One worker per room, started when the room opens and stopped when it closes. Everything expensive
 * happens over there; this side only owns the things a worker cannot -- `localStorage` and React.
 */

import { normalizeCode } from '@games/protocol';
import { useEffect, useState } from 'react';
import { BOT_BASE, BOT_GAME, levelById, type BotLevel, type FromBot, type ToBot } from './bot.js';
import { botSeat, claimPendingBot, pendingBot, rememberBotSeat } from './seats.js';

export interface BotStatus {
  /** A bot is seated in this room. False for a match between people. */
  active: boolean;
  level: BotLevel | null;
  /** The checkpoints are loaded and the worker is on the socket. */
  ready: boolean;
  /** Inside a search. The one thing worth showing continuously. */
  thinking: boolean;
  error: string | null;
}

const IDLE: BotStatus = { active: false, level: null, ready: false, thinking: false, error: null };

function socketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

export function useBot(code: string | null, gameId: string | null): BotStatus {
  const [status, setStatus] = useState<BotStatus>(IDLE);

  useEffect(() => {
    if (!code || gameId !== BOT_GAME) return;
    const room = normalizeCode(code);

    /*
     * Claiming happens here rather than in the lobby because here is the first moment the code
     * exists. Creating a match is a round trip: the button knows the level, the server names the
     * room, and the two facts meet at this line.
     */
    const seat = claimPendingBot(room);
    if (!seat) return;

    const level = levelById(seat.level);
    setStatus({ active: true, level, ready: false, thinking: false, error: null });

    const worker = new Worker(new URL('./play.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent<FromBot>) => {
      const message = event.data;
      switch (message.t) {
        case 'ready':
          setStatus((s) => ({ ...s, ready: true }));
          return;
        case 'token':
          // The one fact worth persisting: without it a reload cannot put the bot back in its seat,
          // and the room would sit full and unplayable for ever.
          rememberBotSeat(message.code, { level: seat.level, token: message.token });
          return;
        case 'thinking':
          setStatus((s) => ({ ...s, thinking: message.on }));
          return;
        case 'rematch':
          rememberBotSeat(normalizeCode(message.code), { level: seat.level, token: message.token });
          return;
        case 'error':
          setStatus((s) => ({ ...s, error: message.message, thinking: false }));
          return;
      }
    };

    worker.onerror = (event) => {
      setStatus((s) => ({ ...s, error: event.message || 'The bot worker stopped.', thinking: false }));
    };

    const start: ToBot = {
      t: 'start',
      url: socketUrl(),
      code: room,
      name: `Bot · ${level.label}`,
      base: BOT_BASE,
      level,
      token: botSeat(room)?.token ?? null,
      // Fresh every time the worker starts, so reopening a match does not replay the same reasoning
      // move for move. The search is seeded rather than random, which is what makes a bug in it
      // reproducible; nothing wants that seed to be the same across sessions.
      seed: `bot:${room}:${Date.now().toString(36)}`,
    };
    worker.postMessage(start);

    return () => {
      /*
       * Terminated rather than asked to stop. A `stop` message would have to wait for the worker to
       * come back to its event loop, and a search does not -- it is a synchronous tree walk, so the
       * message would sit unread until the bot had finished deciding a move for a room nobody is in.
       * Terminating closes its socket for it, which is the only cleanup that was ever needed.
       */
      worker.terminate();
      setStatus(IDLE);
    };
  }, [code, gameId]);

  return status;
}

/**
 * Whether this room is a bot match, answered synchronously — before `useBot`'s effect has run.
 *
 * Needed because `active` cannot be known on the first render: the effect that claims the intent
 * runs after it. One frame of the wrong answer would be invisible for most things, but the coach
 * panel starts a worker and fetches 3MB on mount, so it would happen and then immediately be undone.
 */
export function isBotMatch(code: string | null): boolean {
  if (code === null) return false;
  return botSeat(normalizeCode(code)) !== null || pendingBot() !== null;
}
