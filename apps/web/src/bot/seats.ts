/**
 * Which matches have a bot in them, and the seat token that lets it back in.
 *
 * Two stores, for two lifetimes.
 *
 * `localStorage` under `bot:<CODE>` outlives the tab, because the bot's seat has to. A reload is the
 * ordinary case -- refresh mid-game and the room is still there, both seats still filled -- and
 * without the token the worker would ask to join a full room and be refused, leaving a match nobody
 * can finish. Deliberately not the `match:<CODE>` prefix the human's seats use: `heldCodes()` walks
 * that one to build "your games in progress", and a bot's seat has no business in that list.
 *
 * `sessionStorage` under `bot:pending` holds an intent that has not got a code yet. Starting a bot
 * match means creating a match first and learning its code from the server afterwards, so the choice
 * of level has to survive the gap -- and, for "play again", a full page load.
 */

import { clampIterations, DEFAULT_ITERATIONS } from './bot.js';

const SEAT_PREFIX = 'bot:';
const PENDING_KEY = 'bot:pending';

export interface BotSeat {
  /** Simulations per move. See `MIN_ITERATIONS`. */
  iterations: number;
  /** Issued by the server when the bot took its seat. Absent until it has. */
  token?: string;
}

export interface PendingBot {
  iterations: number;
  /** Set by "play again", which navigates to the lobby and wants it to start a match on arrival. */
  autoStart?: boolean;
  /** When it was parked. See `STALE_MS`. */
  at?: number;
}

/**
 * How long a parked intent stays good.
 *
 * The gap it is meant to bridge is one round trip -- click "Play the bot", the server names the
 * room, the room opens -- and that is under a second. Anything older is an intent that never got
 * used, and the failure it prevents is the bad one: `createMatch` fails, the intent sits in session
 * storage, the player joins a friend's game by code half an hour later, and a bot walks into it.
 * The Lobby also clears it on any other way into a room; this is the backstop for the ways that do
 * not go through the Lobby, like a deep link.
 */
const STALE_MS = 60_000;

function read<T>(store: Storage, key: string): T | null {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Private browsing, a full quota, or something else's data under our key. Either way there is no
    // bot here, which is a perfectly good answer.
    return null;
  }
}

function write(store: Storage, key: string, value: unknown): void {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // The bot still plays this session; it just will not survive a reload.
  }
}

/**
 * Named levels, from before the dial was continuous.
 *
 * A seat token in storage outlives the release that wrote it, and a match resumed after this change
 * would otherwise come back with `iterations: undefined` and a bot that never moves. Reading the old
 * shape costs three lines; discovering it as a stuck game does not.
 */
const LEGACY_LEVELS: Record<string, number> = { easy: 100, normal: 300, hard: 1000 };

function withIterations<T extends { iterations?: number; level?: string }>(stored: T | null): (T & { iterations: number }) | null {
  if (!stored) return null;
  const legacy = stored.level === undefined ? undefined : LEGACY_LEVELS[stored.level];
  return { ...stored, iterations: clampIterations(stored.iterations ?? legacy ?? DEFAULT_ITERATIONS) };
}

/** The bot seated in this match, or null when this is a match between people. */
export function botSeat(code: string): BotSeat | null {
  return withIterations(read<BotSeat & { level?: string }>(localStorage, `${SEAT_PREFIX}${code}`));
}

export function rememberBotSeat(code: string, seat: BotSeat): void {
  write(localStorage, `${SEAT_PREFIX}${code}`, seat);
}

export function forgetBotSeat(code: string): void {
  try {
    localStorage.removeItem(`${SEAT_PREFIX}${code}`);
  } catch {
    // Unreadable storage; nothing to clean up.
  }
}

export function pendingBot(): PendingBot | null {
  const pending = withIterations(read<PendingBot & { level?: string }>(sessionStorage, PENDING_KEY));
  if (!pending) return null;
  if (typeof pending.at === 'number' && Date.now() - pending.at > STALE_MS) {
    clearPendingBot();
    return null;
  }
  return pending;
}

export function setPendingBot(pending: PendingBot): void {
  write(sessionStorage, PENDING_KEY, { ...pending, at: Date.now() });
}

export function clearPendingBot(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to do.
  }
}

/**
 * Claim the pending intent for a code, exactly once.
 *
 * Called as the room opens. The intent is consumed rather than read, so a second match created in
 * the same tab does not inherit a bot nobody asked for.
 */
export function claimPendingBot(code: string): BotSeat | null {
  const existing = botSeat(code);
  if (existing) return existing;
  const pending = pendingBot();
  if (!pending) return null;
  clearPendingBot();
  const seat: BotSeat = { iterations: pending.iterations };
  rememberBotSeat(code, seat);
  return seat;
}
