import { unseal, type ApplyResult, type Seat } from '@games/engine';
import { apply } from './apply.js';
import { legalActions } from './legal.js';
import { redactFor } from './redact.js';
import type {
  PlayerState,
  SplendorAction,
  SplendorState,
  SplendorView,
  TokenColor,
} from './types.js';
import { LEVELS } from './types.js';

/**
 * Client-side prediction: run the real rules against a *redacted view* so the acting player's own
 * move renders at 0 ms instead of after a round trip.
 *
 * The rule that keeps this honest is: never invent a value you would have to guess. Two actions
 * hinge entirely on hidden information and are therefore not predicted at all —
 *
 *   - `replenish`, whose result is determined by the secret order of the bag;
 *   - `reserve` from a deck, which reveals a face-down card.
 *
 * Everything else is predicted. Where a prediction is exact the result carries no flag; where the
 * server still has something to reveal — a pyramid slot refilling from a deck — the slot is left
 * *empty* rather than filled with a plausible fake, and `unresolved: true` tells the client to
 * render it as pending and animate the real card in when the server answers. A momentarily empty
 * slot is honest; a card that appears and then changes into a different card looks like a bug and
 * teaches players that the client sometimes knows things it should not.
 */

/**
 * Stands in for a card whose identity this client cannot know yet.
 *
 * Exported so a UI can render it as a face-down "incoming" card. Never pass it to `card()`; the
 * lookup helpers treat it as unknown and skip it.
 */
export const UNKNOWN_CARD = '__unknown__';

/**
 * Fills the client's synthetic bag. Any colour would do -- the point is that the count is right and
 * the contents are not knowable from here, which is exactly the client's real position.
 */
const BAG_PLACEHOLDER: TokenColor = 'gold';

function synthPlayer(view: SplendorView['players'][number]): PlayerState {
  return {
    tokens: { ...view.tokens },
    privileges: view.privileges,
    reserved: view.reserved.map((held) =>
      'cardId' in held
        ? { cardId: held.cardId, publiclyKnown: true }
        // The opponent's secret reservations. The reducer never inspects these during our own move;
        // they exist only to keep the slot count right.
        : { cardId: UNKNOWN_CARD, publiclyKnown: false },
    ),
    stacks: view.stacks.map((s) => ({ color: s.color, cardIds: [...s.cardIds] })),
    colorless: [...view.colorless],
    royals: [...view.royals],
    royalsTaken: view.royalsTaken,
  };
}

/**
 * Build a state the reducer can run on from what the client actually knows.
 *
 * Decks are stocked with the right *number* of placeholder cards, so deck counts stay accurate and
 * a refill yields an explicit "unknown card" the UI can render face-down. The bag gets the right
 * number of placeholder tokens and nothing more: the client is not told what is in it, and does not
 * need to be, because the only action whose outcome depends on the contents is `replenish` and that
 * one is refused outright. Everything else either adds to the bag or ignores it.
 */
function viewToState(view: SplendorView): SplendorState {
  // Stand-ins. Their colour is never read: `replenish` is the only reader and it is refused.
  const bag: TokenColor[] = new Array<TokenColor>(view.bag.total).fill(BAG_PLACEHOLDER);
  const decks = {} as Record<1 | 2 | 3, string[]>;
  for (const level of LEVELS) {
    decks[level] = new Array<string>(view.decks[level]).fill(UNKNOWN_CARD);
  }

  return {
    v: 1,
    // Never the real seed — the client has never seen it, and does not need it.
    seed: '',
    rngCounter: 0,
    options: { ...view.options },
    bag,
    board: [...view.board],
    decks,
    pyramid: {
      1: [...view.pyramid[1]],
      2: [...view.pyramid[2]],
      3: [...view.pyramid[3]],
    },
    royals: [...view.royals],
    privilegePool: view.privilegePool,
    players: [synthPlayer(view.players[0]), synthPlayer(view.players[1])],
    turn: view.turn,
    stage: view.stage,
    pending: view.pending ? { ...view.pending } : null,
    abilityQueue: view.abilityQueue.map((e) => ({ ...e })),
    replenishedThisTurn: view.replenishedThisTurn,
    extraTurns: view.extraTurns,
    turnsWithoutPurchase: view.turnsWithoutPurchase,
    boughtThisTurn: view.boughtThisTurn,
    winner: view.winner,
    winReason: view.winReason,
  };
}

/** Would this action's outcome depend on information the client does not hold? */
function dependsOnHiddenInput(action: SplendorAction): boolean {
  if (action.t === 'replenish') return true;
  if (action.t === 'reserve' && action.from.t === 'deck') return true;
  return false;
}

export function applyToView(
  view: SplendorView,
  seat: Seat,
  action: SplendorAction,
): ApplyResult<SplendorView> {
  if (dependsOnHiddenInput(action)) {
    return { ok: false, error: { code: 'UNPREDICTABLE', message: 'Waiting for the server to reveal this.' } };
  }

  const result = apply(viewToState(view), seat, action);
  if (!result.ok) return result;

  const next = unseal(redactFor(seat, result.state));
  // A slot refilled from a deck holds a placeholder, so the server still has something to reveal.
  const awaitingReveal = LEVELS.some((level) => next.pyramid[level].includes(UNKNOWN_CARD));
  return {
    ok: true,
    state: next,
    effects: result.effects,
    ...(awaitingReveal ? { unresolved: true } : {}),
  };
}

/**
 * Legal actions computed from a view rather than from truth state.
 *
 * This is the biggest affordance the platform can offer a TypeScript bot: a search-based bot needs
 * thousands of positions per second and cannot get them over a network. Note that simulating past a
 * hidden zone is approximate — that is an honest property of the game, not a defect, since a human
 * player faces the same uncertainty.
 */
export function legalActionsFromView(
  view: SplendorView,
  seat: Seat,
): { actions: SplendorAction[]; truncated: boolean } {
  // Deck counts and bag composition are faithfully reconstructed, so deck reservations and
  // replenish are offered naturally without any special-casing here.
  return legalActions(viewToState(view), seat);
}
