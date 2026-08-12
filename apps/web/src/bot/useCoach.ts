/**
 * Drive the coach worker from the room's state, and remember whether it is switched on.
 *
 * The worker is spawned only once somebody turns it on, so a player who never asks for help never
 * downloads 3MB of weights. Turning it off terminates it: an idle worker holding two networks is
 * ~12MB of expanded `Float64Array`, and "off" should mean off.
 */

import { useEffect, useRef, useState } from 'react';
import { BOT_BASE, coachIterations, type CoachDepthId, type FromCoach, type ToCoach } from './bot.js';

const ON_KEY = 'games:coach';
const DEPTH_KEY = 'games:coachDepth';

export interface CoachRead {
  /** The value head alone, in [-1, 1] from your seat. */
  staticValue: number;
  /** The same head averaged over the search tree. */
  searchValue: number;
  moves: { text: string; visits: number; prior: number; value: number }[];
  instinct: string | null;
  ms: number;
}

export interface CoachState {
  on: boolean;
  setOn: (on: boolean) => void;
  depth: CoachDepthId;
  setDepth: (depth: CoachDepthId) => void;
  /** The network is loaded. Before this the panel says so rather than sitting blank. */
  ready: boolean;
  /** A search is running for a position newer than `read`. */
  working: boolean;
  read: CoachRead | null;
  error: string | null;
}

export interface CoachInput {
  view: unknown;
  seat: number | null;
  yourTurn: boolean;
  /** Bumps on every confirmed move. What decides that the last read is stale. */
  version: number;
  /** Nothing to say about a finished game, and the search would have no root. */
  over: boolean;
}

/**
 * `enabled` is separate from `on` because the two mean different things: `on` is the player's
 * standing preference, remembered across rooms, and `enabled` is whether this room is one where a
 * coach makes sense at all. A bot match is not. Folding them together would mean walking into one
 * game against the bot silently switched the setting off for every game after it.
 */
export function useCoach(input: CoachInput, enabled: boolean): CoachState {
  const [on, setOn] = useState(() => localStorage.getItem(ON_KEY) === '1');
  const [depth, setDepth] = useState<CoachDepthId>(
    () => (localStorage.getItem(DEPTH_KEY) as CoachDepthId | null) ?? 'quick',
  );
  const [worker, setWorker] = useState<Worker | null>(null);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [read, setRead] = useState<CoachRead | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** The request we are waiting on. Answers to anything else are about a board that has moved. */
  const pending = useRef(0);
  /*
   * The position, held out of the effect's dependencies on purpose. `view` is a fresh object on
   * every render, so depending on it would re-search on every unrelated state change -- a hover, a
   * chat message -- while `version` is the thing that actually says the board moved.
   */
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    localStorage.setItem(ON_KEY, on ? '1' : '0');
    if (!on || !enabled) return;

    const spawned = new Worker(new URL('./coach.worker.ts', import.meta.url), { type: 'module' });
    setWorker(spawned);
    setReady(false);
    setRead(null);
    setError(null);

    spawned.onmessage = (event: MessageEvent<FromCoach>) => {
      const message = event.data;
      if (message.t === 'ready') {
        setReady(true);
        return;
      }
      if (message.t === 'error') {
        setError(message.message);
        setWorking(false);
        return;
      }
      // Late answers are dropped rather than shown: an evaluation of the position two moves ago
      // looks exactly like an evaluation of this one, and is the more dangerous for it.
      if (message.id !== pending.current) return;
      setRead({
        staticValue: message.staticValue,
        searchValue: message.searchValue,
        moves: message.moves,
        instinct: message.instinct,
        ms: message.ms,
      });
      setWorking(false);
    };
    spawned.onerror = (event) => {
      setError(event.message || 'The coach worker stopped.');
      setWorking(false);
    };
    spawned.postMessage({ t: 'load', base: BOT_BASE } satisfies ToCoach);

    return () => {
      spawned.terminate();
      setWorker(null);
      setReady(false);
      setWorking(false);
      setRead(null);
    };
  }, [on, enabled]);

  useEffect(() => {
    localStorage.setItem(DEPTH_KEY, depth);
  }, [depth]);

  useEffect(() => {
    if (!on || !enabled || !ready || !worker) return;
    const { view, seat, yourTurn, over } = latest.current;
    if (seat === null || !view || over) {
      setRead(null);
      return;
    }
    pending.current += 1;
    setWorking(true);
    worker.postMessage({
      t: 'look',
      id: pending.current,
      view,
      seat,
      yourTurn,
      iterations: coachIterations(depth),
    } satisfies ToCoach);
  }, [on, enabled, ready, worker, depth, input.version, input.seat, input.yourTurn, input.over]);

  return { on, setOn, depth, setDepth, ready, working, read, error };
}
