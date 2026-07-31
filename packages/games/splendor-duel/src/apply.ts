import { RandomCursor, applyErr, applyOk, type ApplyResult, type Effect, type Seat } from '@games/engine';
import { card } from './cards.js';
import { SPIRAL, isLegalTokenLine } from './spiral.js';
import {
  bonuses,
  costTotal,
  effectiveCost,
  tokenTotal,
  totalCrowns,
  totalPoints,
  victoryFor,
} from './score.js';
import { validate } from './legal.js';
import type {
  Ability,
  CardRef,
  GemColor,
  Level,
  PayColor,
  SplendorAction,
  SplendorState,
  TokenColor,
} from './types.js';
import { CROWN_THRESHOLDS, TOKEN_LIMIT } from './types.js';

/**
 * Work on a deep copy so the reducer is pure and callers can safely hold onto the previous state.
 * A JSON round trip also enforces the "state must be plain JSON" invariant every time we run.
 */
function draft(state: SplendorState): SplendorState {
  return JSON.parse(JSON.stringify(state)) as SplendorState;
}

function other(seat: Seat): Seat {
  return (1 - seat) as Seat;
}

function playerAt(state: SplendorState, seat: Seat) {
  const p = state.players[seat as 0 | 1];
  if (!p) throw new Error(`no player at seat ${seat}`);
  return p;
}

/**
 * Grant one privilege to `seat`, following the rulebook's fallback chain: take one from above the
 * board; if there are none, take one from the opponent; if the recipient already holds all three,
 * nothing happens — and the action that triggered it stays legal.
 */
function grantPrivilege(state: SplendorState, seat: Seat, effects: Effect[]): void {
  const me = playerAt(state, seat);
  if (state.privilegePool > 0) {
    state.privilegePool -= 1;
    me.privileges += 1;
    effects.push({ k: 'privilegeGranted', seat, from: 'pool' });
    return;
  }
  const opponent = playerAt(state, other(seat));
  if (opponent.privileges > 0) {
    opponent.privileges -= 1;
    me.privileges += 1;
    effects.push({ k: 'privilegeGranted', seat, from: 'opponent' });
    return;
  }
  effects.push({ k: 'privilegeGranted', seat, from: 'none' });
}

/** Refill one pyramid slot from its deck. A slot whose deck is exhausted stays empty for good. */
function refillPyramid(state: SplendorState, level: Level, slot: number, effects: Effect[]): void {
  const deck = state.decks[level];
  const next = deck.shift() ?? null;
  const row = state.pyramid[level];
  row[slot] = next;
  effects.push({ k: 'pyramidRefilled', level, slot, cardId: next });
}

function resolveCardRef(state: SplendorState, seat: Seat, ref: CardRef): string | null {
  if (ref.t === 'pyramid') return state.pyramid[ref.level]?.[ref.slot] ?? null;
  const held = playerAt(state, seat).reserved.find((r) => r.cardId === ref.cardId);
  return held ? held.cardId : null;
}

/* ------------------------------------------------------------------ ability resolution */

function boardHasColor(state: SplendorState, color: TokenColor): boolean {
  return state.board.includes(color);
}

function opponentHasStealable(state: SplendorState, seat: Seat): boolean {
  const tokens = playerAt(state, other(seat)).tokens;
  // Gold can never be stolen.
  return (['white', 'blue', 'green', 'red', 'black', 'pearl'] as PayColor[]).some((c) => tokens[c] > 0);
}

/**
 * Resolve one ability. Abilities are mandatory rather than optional — the rulebook uses imperative
 * phrasing throughout, and the only escape clauses are for effects that are literally impossible.
 * Those are skipped, never converted into something else.
 */
function resolveAbility(
  state: SplendorState,
  seat: Seat,
  entry: { ability: Ability; cardId: string },
  effects: Effect[],
): void {
  const { ability, cardId } = entry;
  switch (ability) {
    case 'wildBonus':
      // Handled when the card is placed: it is a purchase precondition plus a permanent colour
      // choice, not a resolvable effect.
      return;

    case 'playAgain':
      state.extraTurns += 1;
      effects.push({ k: 'abilityResolved', seat, ability, cardId });
      return;

    case 'takePrivilege':
      grantPrivilege(state, seat, effects);
      effects.push({ k: 'abilityResolved', seat, ability, cardId });
      return;

    case 'takeMatchingToken': {
      const color = card(cardId).bonusColor;
      if (color && boardHasColor(state, color)) {
        // Which token is a genuine choice: removing one changes which lines are available later.
        state.pending = { k: 'matchingToken', color, cardId };
      } else {
        effects.push({ k: 'abilitySkipped', seat, ability, cardId, why: 'noMatchingToken' });
      }
      return;
    }

    case 'stealToken': {
      if (opponentHasStealable(state, seat)) {
        state.pending = { k: 'steal', source: card(cardId).kind === 'royal' ? 'royal' : 'card', cardId };
      } else {
        effects.push({ k: 'abilitySkipped', seat, ability, cardId, why: 'nothingToSteal' });
      }
      return;
    }
  }
}

/* ------------------------------------------------------------------ turn pipeline */

function startTurn(state: SplendorState, seat: Seat, effects: Effect[]): void {
  state.turn = seat;
  state.stage = 'optional';
  state.pending = null;
  state.abilityQueue = [];
  state.replenishedThisTurn = false;
  state.boughtThisTurn = false;
  effects.push({ k: 'turnStarted', seat });
}

function endMatch(state: SplendorState, winner: Seat | null, reason: string, effects: Effect[]): void {
  state.winner = winner;
  state.winReason = reason;
  state.stage = 'over';
  state.pending = null;
  state.abilityQueue = [];
  effects.push({ k: 'gameOver', winner, reason });
}

/**
 * End of turn: victory is checked here and only here — after the mandatory action, after abilities,
 * after any royal card, and after discarding to 10. There is no equalising turn for the opponent.
 *
 * Note the ordering consequence: if a purchase both wins the game and grants an extra turn, the
 * win lands first and the extra turn never happens.
 */
function finishTurn(state: SplendorState, effects: Effect[]): void {
  const seat = state.turn;
  const reason = victoryFor(playerAt(state, seat));
  if (reason) {
    endMatch(state, seat, reason, effects);
    return;
  }

  state.turnsWithoutPurchase = state.boughtThisTurn ? 0 : state.turnsWithoutPurchase + 1;
  const limit = state.options.maxTurnsWithoutPurchase ?? 0;
  if (limit > 0 && state.turnsWithoutPurchase >= limit) {
    // Non-official tie-break: the official rules deliberately contain no draw or turn limit, so
    // this only fires when the host opted in (self-play runs, mainly).
    const [a, b] = state.players;
    const byPoints = totalPoints(a) - totalPoints(b);
    const byCrowns = totalCrowns(a) - totalCrowns(b);
    const lead = byPoints !== 0 ? byPoints : byCrowns;
    endMatch(state, lead === 0 ? null : ((lead > 0 ? 0 : 1) as Seat), 'stalled', effects);
    return;
  }

  if (state.extraTurns > 0) {
    state.extraTurns -= 1;
    effects.push({ k: 'extraTurn', seat });
    startTurn(state, seat, effects);
    return;
  }
  startTurn(state, other(seat), effects);
}

/**
 * Drive the turn forward until either a player decision is required or the turn ends.
 *
 * The ability queue is drained before any stage transition, which is what makes a royal card's
 * steal resolve before the discard rather than after it.
 */
function advance(state: SplendorState, effects: Effect[]): void {
  // Bounded to make an accidental infinite loop a test failure rather than a hung server.
  for (let guard = 0; guard < 200; guard++) {
    if (state.stage === 'over' || state.pending) return;

    const nextAbility = state.abilityQueue.shift();
    if (nextAbility) {
      resolveAbility(state, state.turn, nextAbility, effects);
      continue;
    }

    switch (state.stage) {
      case 'optional':
        // Waiting for the player's mandatory action.
        return;

      case 'abilities':
        state.stage = 'crowns';
        continue;

      case 'crowns': {
        const me = playerAt(state, state.turn);
        const crowns = totalCrowns(me);
        const earned = CROWN_THRESHOLDS.filter((t) => crowns >= t).length;
        if (earned > me.royalsTaken) {
          if (state.royals.some((r) => r !== null)) {
            state.pending = { k: 'royal' };
            return;
          }
          // No royals left: consume the threshold so we do not loop forever.
          me.royalsTaken = earned;
        }
        state.stage = 'cleanup';
        continue;
      }

      case 'cleanup': {
        const me = playerAt(state, state.turn);
        const excess = tokenTotal(me.tokens) - TOKEN_LIMIT;
        if (excess > 0) {
          state.pending = { k: 'discard', count: excess };
          return;
        }
        finishTurn(state, effects);
        continue;
      }
    }
  }
  throw new Error('splendor-duel: turn pipeline failed to settle');
}

/* ------------------------------------------------------------------ the reducer */

export function apply(
  state: SplendorState,
  seat: Seat,
  action: SplendorAction,
): ApplyResult<SplendorState> {
  const problem = validate(state, seat, action);
  if (problem !== true) return applyErr(problem.code, problem.message);

  const s = draft(state);
  const me = playerAt(s, seat);
  const effects: Effect[] = [];
  let unresolved = false;

  switch (action.t) {
    case 'usePrivilege': {
      const color = s.board[action.cell] as TokenColor;
      s.board[action.cell] = null;
      me.tokens[color] += 1;
      me.privileges -= 1;
      s.privilegePool += 1;
      effects.push({ k: 'privilegeUsed', seat, cell: action.cell, color });
      break;
    }

    case 'replenish': {
      const rng = new RandomCursor(s.seed, s.rngCounter);
      const placed: { cell: number; color: TokenColor }[] = [];
      // Fill empty cells from the centre outward, drawing blind, until the bag runs dry. Since
      // there are exactly as many cells as tokens, the bag always empties completely.
      for (const cell of SPIRAL) {
        if (s.bag.length === 0) break;
        if (s.board[cell] !== null) continue;
        const token = rng.take(s.bag);
        s.board[cell] = token;
        placed.push({ cell, color: token });
      }
      s.rngCounter = rng.counter;
      s.replenishedThisTurn = true;
      effects.push({ k: 'replenished', seat, placed });
      grantPrivilege(s, other(seat), effects);
      // The bag's order is secret, so a client running this reducer locally cannot predict it.
      unresolved = true;
      break;
    }

    case 'takeTokens': {
      const taken: TokenColor[] = [];
      for (const cell of action.cells) {
        const color = s.board[cell] as TokenColor;
        s.board[cell] = null;
        me.tokens[color] += 1;
        taken.push(color);
      }
      effects.push({ k: 'tookTokens', seat, cells: [...action.cells], colors: taken });

      // Only the mandatory take action can award the opponent a privilege, and only for three of
      // one colour or for both pearls. Two of the same colour awards nothing.
      const threeAlike = taken.length === 3 && taken.every((c) => c === taken[0]);
      const bothPearls = taken.filter((c) => c === 'pearl').length === 2;
      if (threeAlike || bothPearls) {
        grantPrivilege(s, other(seat), effects);
      }
      s.stage = 'abilities';
      break;
    }

    case 'reserve': {
      s.board[action.goldCell] = null;
      me.tokens.gold += 1;

      if (action.from.t === 'pyramid') {
        const { level, slot } = action.from;
        const cardId = s.pyramid[level]?.[slot] as string;
        // Taken from the face-up pyramid, so the opponent legitimately saw it.
        me.reserved.push({ cardId, publiclyKnown: true });
        effects.push({ k: 'reserved', seat, source: 'pyramid', level, cardId, publiclyKnown: true });
        refillPyramid(s, level, slot, effects);
      } else {
        const { level } = action.from;
        const cardId = s.decks[level].shift() as string;
        me.reserved.push({ cardId, publiclyKnown: false });
        effects.push({ k: 'reserved', seat, source: 'deck', level, cardId, publiclyKnown: false });
      }
      // Either branch reveals a card the client could not have known.
      unresolved = true;
      s.stage = 'abilities';
      break;
    }

    case 'purchase': {
      const cardId = resolveCardRef(s, seat, action.from) as string;
      const def = card(cardId);

      for (const [colorRaw, amountRaw] of Object.entries(action.payment)) {
        const color = colorRaw as TokenColor;
        const amount = amountRaw ?? 0;
        if (amount <= 0) continue;
        me.tokens[color] -= amount;
        // Spent tokens go to the bag, which is what makes replenish possible later.
        for (let i = 0; i < amount; i++) s.bag.push(color);
      }

      if (def.wild) {
        // The colour was validated to be one the player already owns; wild cards can never open a
        // new stack, which is why they cannot be bought with an empty tableau.
        const stack = me.stacks.find((st) => st.color === action.wildColor);
        if (!stack) return applyErr('ILLEGAL_ACTION', 'wild card needs an existing colour stack');
        stack.cardIds.push(cardId);
      } else if (def.bonusColor) {
        const existing = me.stacks.find((st) => st.color === def.bonusColor);
        if (existing) existing.cardIds.push(cardId);
        else me.stacks.push({ color: def.bonusColor, cardIds: [cardId] });
      } else {
        // The three high-prestige cards with no bonus: they score toward 20 only, and can never
        // host a wild card.
        me.colorless.push(cardId);
      }

      if (action.from.t === 'pyramid') {
        effects.push({ k: 'purchased', seat, cardId, from: 'pyramid', payment: { ...action.payment }, wildColor: action.wildColor ?? null });
        refillPyramid(s, action.from.level, action.from.slot, effects);
        unresolved = true;
      } else {
        me.reserved = me.reserved.filter((r) => r.cardId !== cardId);
        effects.push({ k: 'purchased', seat, cardId, from: 'reserved', payment: { ...action.payment }, wildColor: action.wildColor ?? null });
      }

      s.abilityQueue = def.abilities.map((ability) => ({ ability, cardId }));
      s.boughtThisTurn = true;
      s.stage = 'abilities';
      break;
    }

    case 'chooseMatchingToken': {
      const color = s.board[action.cell] as TokenColor;
      s.board[action.cell] = null;
      me.tokens[color] += 1;
      s.pending = null;
      effects.push({ k: 'matchingTokenTaken', seat, cell: action.cell, color });
      break;
    }

    case 'chooseSteal': {
      const victim = playerAt(s, other(seat));
      victim.tokens[action.color] -= 1;
      me.tokens[action.color] += 1;
      s.pending = null;
      effects.push({ k: 'stolen', seat, color: action.color });
      break;
    }

    case 'chooseRoyal': {
      const slot = s.royals.indexOf(action.royalId);
      s.royals[slot] = null;
      me.royals.push(action.royalId);
      me.royalsTaken = CROWN_THRESHOLDS.filter((t) => totalCrowns(me) >= t).length;
      s.pending = null;
      effects.push({ k: 'royalTaken', seat, royalId: action.royalId });
      // A royal's ability resolves immediately, before the discard and the victory check.
      s.abilityQueue.push(
        ...card(action.royalId).abilities.map((ability) => ({ ability, cardId: action.royalId })),
      );
      break;
    }

    case 'pass': {
      // Nothing changes except that the turn ends -- which is the point. The cleanup stage returns
      // any tokens above 10 to the bag, and that is what makes the next replenish possible and
      // breaks the deadlock. See the note in `docs/splendor-duel-rules.md`.
      effects.push({ k: 'passed', seat, why: 'noLegalAction' });
      s.stage = 'abilities';
      break;
    }

    case 'discard': {
      for (const [colorRaw, amountRaw] of Object.entries(action.tokens)) {
        const color = colorRaw as TokenColor;
        const amount = amountRaw ?? 0;
        if (amount <= 0) continue;
        me.tokens[color] -= amount;
        for (let i = 0; i < amount; i++) s.bag.push(color);
      }
      s.pending = null;
      effects.push({ k: 'discarded', seat, tokens: { ...action.tokens } });
      break;
    }
  }

  advance(s, effects);
  return applyOk(s, effects, unresolved);
}

/* ------------------------------------------------------------------ shared helpers */

export { effectiveCost, bonuses, costTotal, isLegalTokenLine };
export type { GemColor };
