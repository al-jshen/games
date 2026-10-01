import type { RandomCursor, Seat } from '@games/engine';
import { LEVELS, determinize, type SplendorState, type SplendorView } from '@games/splendor-duel';

/**
 * `determinize`, for a view read from BGA: a sampled world, with the table refilled.
 *
 * BGA refills the table in `NextPlayer`, at the end of the turn; our engine refills a slot the
 * moment its card is bought or reserved. So at every decision after a purchase or reservation from
 * the table in the same turn, a BGA view has that slot empty and its deck one card larger. Searched
 * as it stands, every future would be planned with one card fewer on the table, because our engine
 * never refills an empty slot.
 *
 * In our engine an empty slot over a non-empty deck never occurs, so in a view it means exactly "BGA
 * has not refilled yet". Dealing the slot the next card of the sampled deck is what BGA will do
 * before anyone acts on the table again, with a card the seat has not seen -- which is what our
 * engine's own position is, up to which unseen card. A slot that is empty because its deck ran out
 * stays empty, as it does on both sides.
 */
export function determinizeBga(view: SplendorView, viewer: Seat, rng: RandomCursor): SplendorState {
  const state = determinize(view, viewer, rng);
  for (const level of LEVELS) {
    const row = state.pyramid[level];
    const deck = state.decks[level];
    for (let slot = 0; slot < row.length && deck.length > 0; slot++) {
      if (row[slot] === null) row[slot] = deck.shift() as string;
    }
  }
  return state;
}
