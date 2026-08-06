import type { RandomCursor, Seat } from '@games/engine';
import { tryCard } from './cards.js';
import { legalActions, validate } from './legal.js';
import { effectiveCost, minimalPayment } from './score.js';
import { isLegalTokenLine } from './spiral.js';
import type { CardRef, PayColor, SplendorAction, SplendorState } from './types.js';
import { LEVELS, MAX_RESERVED } from './types.js';

/**
 * Pick one legal action without enumerating them all.
 *
 * `legalActions` is the wrong tool inside a rollout. It builds every legal move — up to 156 of them,
 * including the payment variants for every affordable card — and the rollout then throws all but one
 * away. Measured at 5.9µs a call against 302,000 calls per sixty moves, that enumeration was 39% of
 * self-play, nearly all of it discarded.
 *
 * So this proposes a candidate and checks it, rather than deriving the whole set. `validate` is the
 * same arbiter `apply` uses, so a proposal that survives it is genuinely legal — this is a shortcut
 * in *cost*, not in correctness. If a few proposals in a row are refused, it falls back to full
 * enumeration, which means a rollout can never stall no matter how strange the position.
 *
 * The distribution is deliberately not uniform over legal moves. It leans toward buying, for the same
 * reason the biased rollout policy does: two players moving uniformly at random never build an
 * engine, so the advantage being evaluated never gets to cash out and the rollout says nothing about
 * the position. Rollouts are a heuristic device; the honesty that matters is in `validate`.
 */
export function sampleAction(state: SplendorState, seat: Seat, rng: RandomCursor): SplendorAction | null {
  /*
   * A queued decision is a small closed set -- discard, claim a royal, steal a token -- and
   * enumerating it is already cheap. Proposing into it would mostly generate rejects.
   */
  if (state.pending) return anyLegal(state, seat, rng);

  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = propose(state, seat, rng);
    if (candidate && validate(state, seat, candidate) === true) return candidate;
  }
  return anyLegal(state, seat, rng);
}

function anyLegal(state: SplendorState, seat: Seat, rng: RandomCursor): SplendorAction | null {
  const { actions } = legalActions(state, seat);
  return actions.length === 0 ? null : (actions[rng.int(actions.length)] as SplendorAction);
}

function propose(state: SplendorState, seat: Seat, rng: RandomCursor): SplendorAction | null {
  const roll = rng.int(100);
  if (roll < 40) return proposePurchase(state, seat, rng) ?? proposeTake(state, rng);
  if (roll < 85) return proposeTake(state, rng);
  if (roll < 93) return proposeReserve(state, seat, rng);
  if (roll < 97) return { t: 'replenish' };
  return proposePrivilege(state, rng);
}

/**
 * A purchase, chosen from the cards actually affordable right now.
 *
 * Scans all fifteen candidates rather than picking one and hoping. An earlier version took a single
 * random card and checked it, which sounded equivalent and was not: most cards are unaffordable at
 * any given moment, so nearly every attempt fell through to taking tokens. Measured, it proposed
 * purchases 2.2% of the time where enumeration managed 28.7% — the enumerating path finds the needle,
 * and picking at random misses it.
 *
 * Scanning is still far cheaper than `legalActions`, because it skips the part that actually costs:
 * enumerating up to 145 token lines and expanding every affordable card into its payment variants.
 */
function proposePurchase(state: SplendorState, seat: Seat, rng: RandomCursor): SplendorAction | null {
  const me = state.players[seat as 0 | 1];
  const refs: CardRef[] = [];
  for (const level of LEVELS) {
    state.pyramid[level].forEach((cardId, slot) => {
      if (cardId) refs.push({ t: 'pyramid', level, slot });
    });
  }
  for (const held of me.reserved) refs.push({ t: 'reserved', cardId: held.cardId });

  const affordable: { ref: CardRef; payment: Partial<Record<PayColor, number>>; wild: boolean }[] = [];
  for (const ref of refs) {
    const cardId = ref.t === 'reserved' ? ref.cardId : state.pyramid[ref.level][ref.slot];
    if (!cardId) continue;
    const def = tryCard(cardId);
    if (!def) continue;
    // A wild card cannot be bought at all with no bonus card to join.
    if (def.wild && me.stacks.length === 0) continue;
    const payment = minimalPayment(me, effectiveCost(me, cardId));
    if (!payment) continue;
    affordable.push({ ref, payment, wild: def.wild });
  }
  if (affordable.length === 0) return null;

  const pick = affordable[rng.int(affordable.length)];
  if (!pick) return null;
  if (pick.wild) {
    const stack = me.stacks[rng.int(me.stacks.length)];
    if (!stack) return null;
    return { t: 'purchase', from: pick.ref, payment: pick.payment, wildColor: stack.color };
  }
  return { t: 'purchase', from: pick.ref, payment: pick.payment };
}

/**
 * A short run of tokens. Taking a single non-gold token is legal whenever one is on the board, which
 * makes this the reliable fallback that keeps the rejection loop short.
 */
function proposeTake(state: SplendorState, rng: RandomCursor): SplendorAction | null {
  const cells: number[] = [];
  state.board.forEach((token, cell) => {
    if (token !== null && token !== 'gold') cells.push(cell);
  });
  if (cells.length === 0) return null;

  const start = cells[rng.int(cells.length)] as number;
  /*
   * Try for the longest run first and step down, rather than committing to a length and giving up.
   * Committing meant most attempts collapsed to a single token -- 69% singles against enumeration's
   * 47% -- and a rollout that takes one token at a time accumulates far too slowly to ever buy
   * anything, which is precisely the signal the rollout is supposed to produce.
   */
  const want = 1 + rng.int(3);
  for (let length = want; length > 1; length--) {
    for (const step of shuffledSteps(rng)) {
      const run = [start];
      for (let i = 1; i < length; i++) {
        const next = neighbour(run[run.length - 1] as number, step);
        if (next === null) break;
        run.push(next);
      }
      if (run.length === length && isLegalTokenLine(state.board, run)) {
        return { t: 'takeTokens', cells: run };
      }
    }
  }
  return { t: 'takeTokens', cells: [start] };
}

function proposeReserve(state: SplendorState, seat: Seat, rng: RandomCursor): SplendorAction | null {
  const me = state.players[seat as 0 | 1];
  if (me.reserved.length >= MAX_RESERVED) return null;
  const goldCells: number[] = [];
  state.board.forEach((token, cell) => {
    if (token === 'gold') goldCells.push(cell);
  });
  if (goldCells.length === 0) return null;
  const goldCell = goldCells[rng.int(goldCells.length)] as number;

  const level = LEVELS[rng.int(LEVELS.length)] as 1 | 2 | 3;
  if (rng.int(2) === 0 && state.decks[level].length > 0) {
    return { t: 'reserve', goldCell, from: { t: 'deck', level } };
  }
  const slots = state.pyramid[level].map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  if (slots.length === 0) return null;
  return { t: 'reserve', goldCell, from: { t: 'pyramid', level, slot: slots[rng.int(slots.length)] as number } };
}

function proposePrivilege(state: SplendorState, rng: RandomCursor): SplendorAction | null {
  const cells: number[] = [];
  state.board.forEach((token, cell) => {
    if (token !== null && token !== 'gold') cells.push(cell);
  });
  if (cells.length === 0) return null;
  return { t: 'usePrivilege', cell: cells[rng.int(cells.length)] as number };
}

/** The four directions a token line can run in, in random order. */
function shuffledSteps(rng: RandomCursor): [number, number][] {
  const steps: [number, number][] = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (let i = steps.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = steps[i] as [number, number];
    steps[i] = steps[j] as [number, number];
    steps[j] = a;
  }
  return steps;
}

/** The next cell in a direction, or `null` at the edge of the 5x5 board. */
function neighbour(cell: number, [dx, dy]: [number, number]): number | null {
  const x = (cell % 5) + dx;
  const y = Math.floor(cell / 5) + dy;
  if (x < 0 || x > 4 || y < 0 || y > 4) return null;
  return y * 5 + x;
}
