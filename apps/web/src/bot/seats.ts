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

import type { BotLevelId } from './bot.js';

const SEAT_PREFIX = 'bot:';
const PENDING_KEY = 'bot:pending';

export interface BotSeat {
  level: BotLevelId;
  /** Issued by the server when the bot took its seat. Absent until it has. */
  token?: string;
}

export interface PendingBot {
  level: BotLevelId;
  /** Set by "play again", which navigates to the lobby and wants it to start a match on arrival. */
  autoStart?: boolean;
}

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

/** The bot seated in this match, or null when this is a match between people. */
export function botSeat(code: string): BotSeat | null {
  return read<BotSeat>(localStorage, `${SEAT_PREFIX}${code}`);
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
  return read<PendingBot>(sessionStorage, PENDING_KEY);
}

export function setPendingBot(pending: PendingBot): void {
  write(sessionStorage, PENDING_KEY, pending);
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
  const seat: BotSeat = { level: pending.level };
  rememberBotSeat(code, seat);
  return seat;
}
