import { seal, type Effect, type Redacted, type Seat, type Viewer } from '@games/engine';
import {
  bonuses,
  colorPoints,
  emptyTokens,
  tokenTotal,
  totalCrowns,
  totalPoints,
} from './score.js';
import type {
  PlayerState,
  PlayerView,
  ReservedView,
  SplendorState,
  SplendorView,
  TokenColor,
} from './types.js';
import { LEVELS, TOKEN_COLORS } from './types.js';

/**
 * The bag's *composition* is public — both players can see what has been spent and legitimately
 * compute draw odds — while its *order* is secret. So it is redacted to a multiset of counts, not
 * to a bare total. Under-revealing here would be a UX bug; revealing the order would be a cheat.
 */
function bagCounts(bag: readonly TokenColor[]): { counts: Record<TokenColor, number>; total: number } {
  const counts = emptyTokens();
  for (const token of bag) counts[token] += 1;
  return { counts, total: bag.length };
}

function playerView(player: PlayerState, seat: Seat, viewer: Viewer): PlayerView {
  const mine = viewer === seat;
  const reserved: ReservedView[] = player.reserved.map((held) =>
    // Per-card knowledge rather than a blanket secret bucket: a card taken from the face-up
    // pyramid was seen by the opponent, one drawn off a deck was not. The array length is always
    // preserved, because holding 3 reservations blocks further ones and that is public.
    mine || held.publiclyKnown ? { cardId: held.cardId } : { hidden: true },
  );

  return {
    seat,
    tokens: { ...player.tokens },
    tokenTotal: tokenTotal(player.tokens),
    privileges: player.privileges,
    reserved,
    stacks: player.stacks.map((s) => ({ color: s.color, cardIds: [...s.cardIds] })),
    colorless: [...player.colorless],
    royals: [...player.royals],
    royalsTaken: player.royalsTaken,
    points: totalPoints(player),
    crowns: totalCrowns(player),
    bonuses: bonuses(player),
    colorPoints: colorPoints(player),
  };
}

/**
 * The only function permitted to produce a wire view.
 *
 * Built up field by field from scratch rather than by deleting keys off the truth state — that way
 * a newly added secret field cannot leak by being forgotten, it simply never appears.
 *
 * Two properties are tested rather than assumed: no secret atom (the seed, hidden card ids, bag
 * order) appears in the serialised output; and *view stability* — two truth states that differ only
 * in what this viewer cannot see must serialise byte-identically, which is what closes leaks via
 * array length, key order, and payload size.
 */
export function redactFor(viewer: Viewer, state: SplendorState): Redacted<SplendorView> {
  const decks = {} as Record<1 | 2 | 3, number>;
  for (const level of LEVELS) decks[level] = state.decks[level].length;

  const view: SplendorView = {
    v: 1,
    you: viewer,
    // `seed` and `rngCounter` are deliberately absent: whoever holds them can compute every future
    // shuffle, so they are as sensitive as the deck order itself.
    bag: bagCounts(state.bag),
    board: [...state.board],
    decks,
    pyramid: {
      1: [...state.pyramid[1]],
      2: [...state.pyramid[2]],
      3: [...state.pyramid[3]],
    },
    royals: [...state.royals],
    privilegePool: state.privilegePool,
    players: [
      playerView(state.players[0], 0, viewer),
      playerView(state.players[1], 1, viewer),
    ],
    turn: state.turn,
    stage: state.stage,
    pending: state.pending ? { ...state.pending } : null,
    extraTurns: state.extraTurns,
    replenishedThisTurn: state.replenishedThisTurn,
    abilityQueue: state.abilityQueue.map((e) => ({ ...e })),
    turnsWithoutPurchase: state.turnsWithoutPurchase,
    boughtThisTurn: state.boughtThisTurn,
    options: { ...state.options },
    winner: state.winner,
    winReason: state.winReason,
  };
  return seal(view);
}

/**
 * Effects must be redacted too, and separately from state: a snapshot says what *is*, an effect
 * says what *happened*, and the latter can name a card the viewer is not entitled to see.
 */
export function redactEffect(viewer: Viewer, effect: Effect, _state: SplendorState): Effect | null {
  if (effect.k === 'reserved' && effect.publiclyKnown === false && viewer !== effect.seat) {
    // The opponent learns that a card was reserved from a deck, and its level, but not which card.
    return { ...effect, cardId: null };
  }
  if (effect.k === 'pyramidRefilled') return { ...effect };
  return effect;
}

/**
 * Every string that must never appear in a view, for the leak test. Includes the seed and the id
 * of every card whose location is hidden from `viewer`.
 */
export function secretsFor(viewer: Viewer, state: SplendorState): string[] {
  const secrets = [state.seed];
  for (const level of LEVELS) secrets.push(...state.decks[level]);
  state.players.forEach((player, seat) => {
    if (viewer === seat) return;
    for (const held of player.reserved) {
      if (!held.publiclyKnown) secrets.push(held.cardId);
    }
  });
  return secrets;
}

export { TOKEN_COLORS };
