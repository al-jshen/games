/**
 * A suggestion, in words, and who it is for.
 *
 * Shared by every mode that puts a move in front of a person, so that `watch` and `advise` say the
 * same thing about the same position in the same way.
 */

import { instruct } from '@games/bga-splendor-duel';

/**
 * The suggestion, in words.
 *
 * `instruct` does the work, with one exception. The search plans in sampled worlds, where a mover's
 * face-down reservations that we cannot see have been dealt a card each; a suggestion to buy one of
 * those names a guess, and saying the guess aloud would read as knowledge nobody watching has. From
 * our own seat every reservation is known and the exception never arises.
 */
export function describeSuggestion(action, view, seat, at) {
  if (action.t === 'purchase' && action.from.t === 'reserved') {
    const known = view.players[seat].reserved.some((held) => 'cardId' in held && held.cardId === action.from.cardId);
    if (!known) {
      return {
        text: 'Buy one of their face-down reserved cards',
        steps: ['Which card that is cannot be seen from the stands; the search only knows it would be worth buying.'],
        highlight: [],
      };
    }
  }
  return instruct(action, view, at);
}

/** Who is to move, as a person watching would say it: by the name on the table, or failing that BGA's number. */
export function whoIs({ name, playerId, seat }) {
  const shown = typeof name === 'string' && name.trim() !== '' ? name.trim() : `player ${playerId}`;
  return `${shown} (seat ${seat + 1})`;
}
