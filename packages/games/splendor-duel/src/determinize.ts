import type { RandomCursor, Seat } from '@games/engine';
import { jewelDeck } from './cards.js';
import { UNKNOWN_CARD, viewToState } from './predict.js';
import type { SplendorState, SplendorView, TokenColor } from './types.js';
import { LEVELS, TOKEN_COLORS, TOKEN_SUPPLY } from './types.js';

/**
 * Turn a player's view into one concrete state consistent with it.
 *
 * This is what a search needs in order to plan under imperfect information: sample a world you might
 * be in, search it, repeat. Everything the viewer can see is copied across unchanged; everything they
 * cannot is sampled from the exact set of possibilities.
 *
 * The sampling is *unbiased*, which is unusual and worth knowing. The only hidden cards are ones the
 * opponent reserved off the top of a face-down deck — so they did not choose them either, and there
 * is no selection effect to model. Conditioned on what is public, every unseen card of that level is
 * equally likely, by exchangeability from the initial shuffle.
 *
 * Three things get sampled, and they are not sampled the same way, because the reducer does not
 * consume them the same way:
 *
 *  - **Deck order matters.** `apply` draws with `decks[level].shift()`, so a deck is a sequence and
 *    gets a real permutation.
 *  - **Bag order does not.** `apply` draws with `rng.take(bag)`, a random index, so only the multiset
 *    matters — and that is derivable exactly, by subtracting the board and both players from the
 *    fixed 25-token supply.
 *  - **The seed does.** Future bag draws follow from `seed` and `rngCounter`, so each determinization
 *    gets a fresh one. Reusing a seed across samples would quietly collapse the chance nodes and make
 *    every sampled world draw the same tokens.
 */
export function determinize(view: SplendorView, viewer: Seat, rng: RandomCursor): SplendorState {
  const state = viewToState(view);

  /*
   * Which level each hidden reserve is, recovered by counting rather than by being told.
   *
   * The view does not record it -- a hidden reservation is just `{hidden: true}`. But the unseen
   * cards of a level are exactly the ones still in that deck plus the ones hidden in reserves, and
   * the deck count is public, so the difference is the number of hidden reserves of that level. No
   * guessing, and nothing extra had to be published to make it work.
   */
  const seen = seenCards(view);
  const hidden: string[] = [];
  for (const level of LEVELS) {
    const unseen = rng.shuffle(jewelDeck(level).filter((id) => !seen.has(id)));
    const deckCount = view.decks[level];
    const hiddenCount = unseen.length - deckCount;
    if (hiddenCount < 0) {
      throw new Error(
        `determinize: level ${level} has ${unseen.length} unseen cards but claims ${deckCount} in the deck`,
      );
    }
    hidden.push(...unseen.slice(0, hiddenCount));
    state.decks[level] = unseen.slice(hiddenCount);
  }

  // Fill the placeholder reservations. Which sampled card lands in which slot does not matter --
  // reserved cards are referenced by id, never by position.
  let next = 0;
  for (const player of state.players) {
    for (const held of player.reserved) {
      if (held.cardId !== UNKNOWN_CARD) continue;
      const cardId = hidden[next++];
      if (cardId === undefined) throw new Error('determinize: more hidden reservations than unseen cards');
      held.cardId = cardId;
      held.publiclyKnown = false;
    }
  }
  if (next !== hidden.length) {
    throw new Error(`determinize: ${hidden.length} unseen cards for ${next} hidden reservations`);
  }

  state.bag = remainingTokens(view);
  if (state.bag.length !== view.bag.total) {
    throw new Error(`determinize: bag holds ${state.bag.length} tokens but the view says ${view.bag.total}`);
  }

  // A fresh stream per sample, so the futures differ.
  state.seed = `d${rng.u32().toString(36)}${rng.u32().toString(36)}`;
  state.rngCounter = 0;
  void viewer;
  return state;
}

/** Every jewel card the viewer can account for: on the board, bought, or in a reservation they see. */
function seenCards(view: SplendorView): Set<string> {
  const seen = new Set<string>();
  const note = (id: string | null) => {
    if (id && id !== UNKNOWN_CARD) seen.add(id);
  };
  for (const level of LEVELS) for (const id of view.pyramid[level]) note(id);
  for (const player of view.players) {
    for (const stack of player.stacks) for (const id of stack.cardIds) note(id);
    for (const id of player.colorless) note(id);
    for (const held of player.reserved) if ('cardId' in held) note(held.cardId);
  }
  return seen;
}

/**
 * What must be in the bag: the fixed supply, less everything visible.
 *
 * Exact rather than sampled. The bag's composition was always derivable this way — which is why the
 * view stopped publishing it, and why hiding it costs a searcher nothing.
 */
function remainingTokens(view: SplendorView): TokenColor[] {
  const counts: Record<TokenColor, number> = { ...TOKEN_SUPPLY };
  for (const token of view.board) if (token) counts[token] -= 1;
  for (const player of view.players) {
    for (const color of TOKEN_COLORS) counts[color] -= player.tokens[color];
  }

  const bag: TokenColor[] = [];
  for (const color of TOKEN_COLORS) {
    if (counts[color] < 0) throw new Error(`determinize: ${counts[color]} ${color} tokens left over`);
    for (let i = 0; i < counts[color]; i++) bag.push(color);
  }
  return bag;
}
