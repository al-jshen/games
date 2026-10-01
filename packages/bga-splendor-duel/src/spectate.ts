import type { BgaSnapshot } from './snapshot.js';

/**
 * Looking at a table without sitting at it.
 *
 * A snapshot is what BGA shows the logged-in account. When that account is not one of the players,
 * what it is shown is the public position: neither player's face-down reservations. That is a
 * position either player can be said to be in *as far as an onlooker knows*, and so it can be
 * translated from either seat -- which is all "what would the bot play here" needs.
 *
 * The same is not true of a player's own snapshot. It carries that player's hidden cards face-up,
 * and relabelling it as the opponent's would turn them into cards the opponent knows.
 */

/** Is the logged-in account one of the players at this table? */
export function isSeated(snapshot: BgaSnapshot): boolean {
  return Object.values(snapshot.gamedatas.players).some((player) => player.id === snapshot.me);
}

/**
 * The same snapshot, taken from `playerId`'s seat.
 *
 * Only a spectator's snapshot can be moved to a seat. For a seated account this is the identity on
 * its own seat and an error on the other: there is no honest way to see the opponent's side of a
 * snapshot that shows our own hand.
 */
export function asSeat(snapshot: BgaSnapshot, playerId: number): BgaSnapshot {
  if (snapshot.me === playerId) return snapshot;
  if (!Object.values(snapshot.gamedatas.players).some((player) => player.id === playerId)) {
    throw new Error(`asSeat: player ${playerId} is not at this table`);
  }
  if (isSeated(snapshot)) {
    throw new Error('asSeat: the logged-in account is seated at this table, and its snapshot cannot be read from the other seat');
  }
  return { ...snapshot, me: playerId };
}
