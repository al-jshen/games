import { gameError, type GameError, type Seat } from '@games/engine';
import { card, tryCard } from './cards.js';
import { availableTokenLines, isLegalTokenLine } from './spiral.js';
import { costTotal, effectiveCost, minimalPayment, tokenTotal } from './score.js';
import type {
  CardRef,
  GemColor,
  Level,
  PayColor,
  SplendorAction,
  SplendorState,
  TokenColor,
} from './types.js';
import { GEM_COLORS, LEVELS, MAX_RESERVED, PAY_COLORS, TOKEN_LIMIT } from './types.js';

/**
 * How many purchase variants to emit per card when gold could substitute for tokens the player
 * already holds. `isLegal` accepts *any* valid split, so a search bot can always construct its
 * own; this cap only bounds the convenience list.
 */
const PAYMENT_VARIANTS_PER_CARD = 6;

function other(seat: Seat): Seat {
  return (1 - seat) as Seat;
}

function playerAt(state: SplendorState, seat: Seat) {
  const p = state.players[seat as 0 | 1];
  if (!p) throw new Error(`no player at seat ${seat}`);
  return p;
}

function nonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/* ------------------------------------------------------------------ validation */

/**
 * The single source of truth for legality, used by both `isLegal` and `apply`.
 *
 * Everything is returned as a value rather than thrown: illegal actions are expected traffic, and
 * a probing bot should get a clean rejection rather than a stack trace.
 */
export function validate(state: SplendorState, seat: Seat, action: SplendorAction): true | GameError {
  if (state.stage === 'over') return gameError('MATCH_OVER', 'The match is over.');
  if (seat !== state.turn) return gameError('NOT_YOUR_TURN', 'It is not your turn.');
  const me = playerAt(state, seat);

  // A pending decision blocks everything else until it is answered.
  if (state.pending) {
    const pending = state.pending;
    switch (pending.k) {
      case 'matchingToken':
        if (action.t !== 'chooseMatchingToken') {
          return gameError('ILLEGAL_ACTION', `You must first take a ${pending.color} token.`);
        }
        if (state.board[action.cell] !== pending.color) {
          return gameError('ILLEGAL_ACTION', `Cell ${action.cell} does not hold a ${pending.color} token.`);
        }
        return true;

      case 'steal': {
        if (action.t !== 'chooseSteal') {
          return gameError('ILLEGAL_ACTION', 'You must first steal a token from your opponent.');
        }
        if (!PAY_COLORS.includes(action.color)) {
          return gameError('ILLEGAL_ACTION', 'Gold cannot be stolen.');
        }
        if (playerAt(state, other(seat)).tokens[action.color] <= 0) {
          return gameError('ILLEGAL_ACTION', `Your opponent has no ${action.color} token.`);
        }
        return true;
      }

      case 'royal':
        if (action.t !== 'chooseRoyal') return gameError('ILLEGAL_ACTION', 'You must first take a royal card.');
        if (!state.royals.includes(action.royalId)) {
          return gameError('ILLEGAL_ACTION', 'That royal card is not available.');
        }
        return true;

      case 'discard': {
        if (action.t !== 'discard') {
          return gameError('ILLEGAL_ACTION', `You must discard ${pending.count} token(s).`);
        }
        let total = 0;
        for (const [colorRaw, amountRaw] of Object.entries(action.tokens)) {
          const color = colorRaw as TokenColor;
          if (!nonNegInt(amountRaw)) return gameError('BAD_ACTION', 'Discard amounts must be non-negative integers.');
          if (me.tokens[color] === undefined) return gameError('BAD_ACTION', `Unknown token colour ${color}.`);
          if (amountRaw > me.tokens[color]) {
            return gameError('ILLEGAL_ACTION', `You do not have ${amountRaw} ${color} token(s).`);
          }
          total += amountRaw;
        }
        if (total !== pending.count) {
          return gameError('ILLEGAL_ACTION', `You must discard exactly ${pending.count} token(s), not ${total}.`);
        }
        return true;
      }
    }
  }

  if (state.stage !== 'optional') {
    return gameError('ILLEGAL_ACTION', 'The engine is mid-turn; nothing to decide right now.');
  }

  switch (action.t) {
    case 'usePrivilege': {
      if (me.privileges <= 0) return gameError('ILLEGAL_ACTION', 'You have no privilege scrolls.');
      // Optional actions are strictly ordered: privileges cannot be spent after a replenish.
      if (state.replenishedThisTurn) {
        return gameError('ILLEGAL_ACTION', 'Privileges must be spent before replenishing the board.');
      }
      const token = state.board[action.cell];
      if (token === null || token === undefined) return gameError('ILLEGAL_ACTION', 'That cell is empty.');
      if (token === 'gold') return gameError('ILLEGAL_ACTION', 'A privilege cannot take a gold token.');
      return true;
    }

    case 'replenish': {
      if (state.replenishedThisTurn) return gameError('ILLEGAL_ACTION', 'You have already replenished this turn.');
      if (state.bag.length === 0) return gameError('ILLEGAL_ACTION', 'The bag is empty.');
      return true;
    }

    case 'takeTokens':
      if (!Array.isArray(action.cells)) return gameError('BAD_ACTION', 'cells must be an array.');
      if (!isLegalTokenLine(state.board, action.cells)) {
        return gameError(
          'ILLEGAL_ACTION',
          'Tokens must be 1-3 in an unbroken straight line, with no empty space or gold token between them.',
        );
      }
      return true;

    case 'reserve': {
      if (me.reserved.length >= MAX_RESERVED) {
        return gameError('ILLEGAL_ACTION', `You already have ${MAX_RESERVED} reserved cards.`);
      }
      if (state.board[action.goldCell] !== 'gold') {
        return gameError('ILLEGAL_ACTION', 'That cell does not hold a gold token.');
      }
      if (action.from.t === 'pyramid') {
        if (!isPyramidSlot(state, action.from.level, action.from.slot)) {
          return gameError('ILLEGAL_ACTION', 'That pyramid slot is empty.');
        }
      } else if ((state.decks[action.from.level]?.length ?? 0) === 0) {
        return gameError('ILLEGAL_ACTION', `The level ${action.from.level} deck is empty.`);
      }
      return true;
    }

    case 'purchase': {
      const cardId = refToCardId(state, seat, action.from);
      if (!cardId) return gameError('ILLEGAL_ACTION', 'No such card to purchase.');
      const def = card(cardId);

      if (def.wild) {
        // Hard precondition, not a skippable effect: a wild card must join an existing colour.
        if (me.stacks.length === 0) {
          return gameError('ILLEGAL_ACTION', 'A wild card needs a bonus card to attach to.');
        }
        if (!action.wildColor) return gameError('BAD_ACTION', 'A wild card purchase must name a colour.');
        if (!me.stacks.some((s) => s.color === action.wildColor)) {
          return gameError('ILLEGAL_ACTION', `You own no ${action.wildColor} bonus to attach to.`);
        }
      } else if (action.wildColor) {
        return gameError('BAD_ACTION', 'Only wild cards take a colour choice.');
      }

      return validatePayment(state, seat, cardId, action.payment);
    }

    case 'pass':
      // A last resort, not a choice: passing is legal only when the player is genuinely stuck.
      if (hasMandatoryAction(state, seat)) {
        return gameError('ILLEGAL_ACTION', 'You have a legal action, so you may not pass.');
      }
      if (!state.replenishedThisTurn && state.bag.length > 0) {
        return gameError('ILLEGAL_ACTION', 'You must replenish the board rather than pass.');
      }
      return true;

    // These only make sense while the matching decision is pending, handled above.
    case 'chooseMatchingToken':
    case 'chooseSteal':
    case 'chooseRoyal':
    case 'discard':
      return gameError('ILLEGAL_ACTION', 'There is no such decision pending.');
  }
}

/**
 * Can this player perform any of the three mandatory actions?
 *
 * Used both to enumerate and to gate `pass`. Kept as a short-circuiting check rather than reusing
 * `legalActions`, because it runs inside `validate` on every submitted action.
 */
export function hasMandatoryAction(state: SplendorState, seat: Seat): boolean {
  const me = playerAt(state, seat);

  // A. Any single non-gold token on the board is a legal one-token take.
  if (state.board.some((token) => token !== null && token !== 'gold')) return true;

  // B. Reserve, which needs gold on the board and a free reservation slot.
  if (me.reserved.length < MAX_RESERVED && state.board.includes('gold')) {
    const anyPyramid = LEVELS.some((level) => state.pyramid[level].some((id) => id !== null));
    const anyDeck = LEVELS.some((level) => state.decks[level].length > 0);
    if (anyPyramid || anyDeck) return true;
  }

  // C. Any affordable card, in the pyramid or already reserved.
  const refs: CardRef[] = [];
  for (const level of LEVELS) {
    state.pyramid[level].forEach((cardId, slot) => {
      if (cardId) refs.push({ t: 'pyramid', level, slot });
    });
  }
  for (const held of me.reserved) refs.push({ t: 'reserved', cardId: held.cardId });

  for (const ref of refs) {
    const cardId = refToCardId(state, seat, ref);
    if (!cardId) continue;
    const def = tryCard(cardId);
    if (!def) continue;
    // A wild card with no colour stack to join cannot be bought at any price.
    if (def.wild && me.stacks.length === 0) continue;
    if (minimalPayment(me, effectiveCost(me, cardId))) return true;
  }
  return false;
}

function isPyramidSlot(state: SplendorState, level: Level, slot: number): boolean {
  const row = state.pyramid[level];
  return Array.isArray(row) && typeof row[slot] === 'string';
}

function refToCardId(state: SplendorState, seat: Seat, ref: CardRef): string | null {
  if (ref.t === 'pyramid') {
    if (!isPyramidSlot(state, ref.level, ref.slot)) return null;
    return state.pyramid[ref.level]?.[ref.slot] ?? null;
  }
  const held = playerAt(state, seat).reserved.find((r) => r.cardId === ref.cardId);
  return held?.cardId ?? null;
}

/**
 * A payment is valid when, per colour, it spends no more than the discounted cost requires and no
 * more than the player owns, and gold covers exactly the remainder.
 *
 * Deliberately permissive about *which* split you use: substituting gold for a gem you could have
 * paid is a real tactical choice (dumping gold, or protecting a gem from the steal ability).
 */
function validatePayment(
  state: SplendorState,
  seat: Seat,
  cardId: string,
  payment: Partial<Record<TokenColor, number>>,
): true | GameError {
  const me = playerAt(state, seat);
  const cost = effectiveCost(me, cardId);
  const need = costTotal(cost);

  let paidNonGold = 0;
  for (const [colorRaw, amountRaw] of Object.entries(payment)) {
    const color = colorRaw as TokenColor;
    if (!nonNegInt(amountRaw)) return gameError('BAD_ACTION', 'Payment amounts must be non-negative integers.');
    if (amountRaw === 0) continue;
    if (me.tokens[color] === undefined) return gameError('BAD_ACTION', `Unknown token colour ${color}.`);
    if (amountRaw > me.tokens[color]) {
      return gameError('ILLEGAL_ACTION', `You do not have ${amountRaw} ${color} token(s).`);
    }
    if (color === 'gold') continue;
    const required = cost[color as PayColor] ?? 0;
    if (amountRaw > required) {
      return gameError('ILLEGAL_ACTION', `This card needs only ${required} ${color}, after your bonuses.`);
    }
    paidNonGold += amountRaw;
  }

  const gold = payment.gold ?? 0;
  if (paidNonGold + gold !== need) {
    return gameError(
      'ILLEGAL_ACTION',
      `Payment must total exactly ${need} token(s) after bonuses; you offered ${paidNonGold + gold}.`,
    );
  }
  return true;
}

/* ------------------------------------------------------------------ enumeration */

/**
 * Every legal action for `seat`. A convenience for bots and for highlighting affordances in the
 * UI; `validate` remains the authority, and the two are property-tested to agree.
 */
export function legalActions(
  state: SplendorState,
  seat: Seat,
): { actions: SplendorAction[]; truncated: boolean } {
  if (state.stage === 'over' || seat !== state.turn) return { actions: [], truncated: false };
  const me = playerAt(state, seat);
  const actions: SplendorAction[] = [];
  let truncated = false;

  if (state.pending) {
    const pending = state.pending;
    switch (pending.k) {
      case 'matchingToken':
        state.board.forEach((token, cell) => {
          if (token === pending.color) actions.push({ t: 'chooseMatchingToken', cell });
        });
        return { actions, truncated };

      case 'steal': {
        const victim = playerAt(state, other(seat));
        for (const color of PAY_COLORS) {
          if (victim.tokens[color] > 0) actions.push({ t: 'chooseSteal', color });
        }
        return { actions, truncated };
      }

      case 'royal':
        for (const royalId of state.royals) {
          if (royalId) actions.push({ t: 'chooseRoyal', royalId });
        }
        return { actions, truncated };

      case 'discard': {
        const combos = discardCombos(me.tokens, pending.count);
        for (const tokens of combos.list) actions.push({ t: 'discard', tokens });
        return { actions, truncated: combos.truncated };
      }
    }
  }

  // Optional action 1: spend a privilege on any single non-gold token.
  if (me.privileges > 0 && !state.replenishedThisTurn) {
    state.board.forEach((token, cell) => {
      if (token !== null && token !== 'gold') actions.push({ t: 'usePrivilege', cell });
    });
  }

  // Optional action 2: replenish.
  if (!state.replenishedThisTurn && state.bag.length > 0) {
    actions.push({ t: 'replenish' });
  }

  // Mandatory A.
  for (const line of availableTokenLines(state.board)) {
    actions.push({ t: 'takeTokens', cells: [...line] });
  }

  // Mandatory B.
  if (me.reserved.length < MAX_RESERVED) {
    const goldCells: number[] = [];
    state.board.forEach((token, cell) => {
      if (token === 'gold') goldCells.push(cell);
    });
    for (const goldCell of goldCells) {
      for (const level of LEVELS) {
        state.pyramid[level].forEach((cardId, slot) => {
          if (cardId) actions.push({ t: 'reserve', goldCell, from: { t: 'pyramid', level, slot } });
        });
        if (state.decks[level].length > 0) {
          actions.push({ t: 'reserve', goldCell, from: { t: 'deck', level } });
        }
      }
    }
  }

  // Mandatory C.
  const refs: CardRef[] = [];
  for (const level of LEVELS) {
    state.pyramid[level].forEach((cardId, slot) => {
      if (cardId) refs.push({ t: 'pyramid', level, slot });
    });
  }
  for (const held of me.reserved) refs.push({ t: 'reserved', cardId: held.cardId });

  for (const ref of refs) {
    const cardId = refToCardId(state, seat, ref);
    if (!cardId) continue;
    // A client enumerating over a *predicted* view may see a placeholder for a card the server has
    // not revealed yet. It cannot be bought, so skip it rather than throwing.
    const def = tryCard(cardId);
    if (!def) continue;
    const cost = effectiveCost(me, cardId);
    const base = minimalPayment(me, cost);
    if (!base) continue;

    const wildColors: (GemColor | undefined)[] = def.wild
      ? me.stacks.map((s) => s.color)
      : [undefined];
    if (def.wild && wildColors.length === 0) continue;

    const payments = paymentVariants(me.tokens, cost, base);
    if (payments.truncated) truncated = true;
    for (const wildColor of wildColors) {
      for (const payment of payments.list) {
        actions.push(
          wildColor === undefined
            ? { t: 'purchase', from: ref, payment }
            : { t: 'purchase', from: ref, payment, wildColor },
        );
      }
    }
  }

  const hasMandatory = actions.some(
    (a) => a.t === 'takeTokens' || a.t === 'reserve' || a.t === 'purchase',
  );
  if (!hasMandatory) {
    // The rulebook makes replenish compulsory rather than optional in this situation.
    const replenish = actions.filter((a) => a.t === 'replenish');
    if (replenish.length > 0) return { actions: replenish, truncated: false };
    // Genuinely stuck. Reachable, and the official rules do not cover it — see `pass`.
    return { actions: [{ t: 'pass' }], truncated: false };
  }

  return { actions, truncated };
}

/**
 * The minimal-gold payment plus a bounded set of single-gold substitutions.
 *
 * Enumerating every split is exponential and almost never useful, so the list is capped and
 * `truncated` is reported honestly rather than silently trimmed.
 */
function paymentVariants(
  tokens: Record<TokenColor, number>,
  cost: Partial<Record<PayColor, number>>,
  base: Partial<Record<TokenColor, number>>,
): { list: Partial<Record<TokenColor, number>>[]; truncated: boolean } {
  const list: Partial<Record<TokenColor, number>>[] = [base];
  const goldUsed = base.gold ?? 0;
  const goldSpare = tokens.gold - goldUsed;
  if (goldSpare <= 0) return { list, truncated: false };

  let truncated = false;
  for (const colorRaw of Object.keys(cost)) {
    const color = colorRaw as PayColor;
    const paid = base[color] ?? 0;
    if (paid <= 0) continue;
    if (list.length >= PAYMENT_VARIANTS_PER_CARD) {
      truncated = true;
      break;
    }
    const variant: Partial<Record<TokenColor, number>> = { ...base };
    if (paid - 1 === 0) delete variant[color];
    else variant[color] = paid - 1;
    variant.gold = goldUsed + 1;
    list.push(variant);
  }
  return { list, truncated };
}

/**
 * Ways to discard exactly `count` tokens. Capped, because holding many colours makes the
 * combination count blow up and a bot can always construct a specific discard itself.
 */
function discardCombos(
  tokens: Record<TokenColor, number>,
  count: number,
): { list: Partial<Record<TokenColor, number>>[]; truncated: boolean } {
  const colors = (['gold', ...PAY_COLORS] as TokenColor[]).filter((c) => tokens[c] > 0);
  const list: Partial<Record<TokenColor, number>>[] = [];
  const LIMIT = 60;
  let truncated = false;

  const walk = (index: number, left: number, acc: Partial<Record<TokenColor, number>>): void => {
    if (list.length >= LIMIT) {
      truncated = true;
      return;
    }
    if (left === 0) {
      list.push({ ...acc });
      return;
    }
    if (index >= colors.length) return;
    const color = colors[index] as TokenColor;
    const max = Math.min(tokens[color], left);
    for (let take = max; take >= 0; take--) {
      if (take > 0) acc[color] = take;
      else delete acc[color];
      walk(index + 1, left - take, acc);
      if (list.length >= LIMIT) break;
    }
    delete acc[color];
  };
  walk(0, count, {});
  return { list, truncated };
}

/** Convenience for UI and bots: is this player over the token limit right now? */
export function overTokenLimit(state: SplendorState, seat: Seat): number {
  return Math.max(0, tokenTotal(playerAt(state, seat).tokens) - TOKEN_LIMIT);
}

export { GEM_COLORS };
