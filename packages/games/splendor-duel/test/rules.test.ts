import { RandomCursor, findLeakedSecrets, isJsonRoundTrippable } from '@games/engine';
import { describe, expect, it } from 'vitest';
import { apply } from '../src/apply.js';
import { card } from '../src/cards.js';
import { legalActions, validate } from '../src/legal.js';
import { legalActionsFromView } from '../src/predict.js';
import { redactFor, secretsFor } from '../src/redact.js';
import { bonuses, tokenTotal, totalCrowns, totalPoints, victoryFor } from '../src/score.js';
import { setup } from '../src/setup.js';
import type { SplendorAction, SplendorOptions, SplendorState, TokenColor } from '../src/types.js';
import { LEVELS, PYRAMID_WIDTH, TOKEN_COLORS, TOKEN_SUPPLY, TOTAL_PRIVILEGES } from '../src/types.js';

function newGame(seed: string, options: SplendorOptions = {}): SplendorState {
  return setup({ seed, seats: [0, 1], options });
}

/* ------------------------------------------------------------------ invariants */

/**
 * Every physical component is accounted for, always. These are the checks that catch a reducer
 * that quietly duplicates or destroys a token or a card.
 */
function assertInvariants(state: SplendorState, note: string, turnJustStarted = false): void {
  // Tokens: board + bag + both players must equal the box contents exactly, as a multiset.
  const counted: Record<TokenColor, number> = {
    white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0, gold: 0,
  };
  for (const token of state.board) if (token) counted[token] += 1;
  for (const token of state.bag) counted[token] += 1;
  for (const player of state.players) {
    for (const color of TOKEN_COLORS) counted[color] += player.tokens[color];
  }
  for (const color of TOKEN_COLORS) {
    expect(counted[color], `${note}: ${color} token count`).toBe(TOKEN_SUPPLY[color]);
  }

  // Privileges are a closed economy of exactly 3.
  const privileges = state.privilegePool + state.players[0].privileges + state.players[1].privileges;
  expect(privileges, `${note}: privileges`).toBe(TOTAL_PRIVILEGES);
  expect(state.privilegePool).toBeGreaterThanOrEqual(0);
  for (const player of state.players) {
    expect(player.privileges).toBeGreaterThanOrEqual(0);
    expect(player.privileges).toBeLessThanOrEqual(TOTAL_PRIVILEGES);
    expect(player.reserved.length).toBeLessThanOrEqual(3);
    for (const color of TOKEN_COLORS) expect(player.tokens[color]).toBeGreaterThanOrEqual(0);
  }

  // Every jewel card exists in exactly one place, and every royal in exactly one.
  const seen: string[] = [];
  for (const level of LEVELS) {
    seen.push(...state.decks[level]);
    for (const id of state.pyramid[level]) if (id) seen.push(id);
  }
  for (const id of state.royals) if (id) seen.push(id);
  for (const player of state.players) {
    seen.push(...player.reserved.map((r) => r.cardId));
    seen.push(...player.stacks.flatMap((s) => s.cardIds));
    seen.push(...player.colorless);
    seen.push(...player.royals);
  }
  expect(new Set(seen).size, `${note}: duplicated card`).toBe(seen.length);
  expect(seen.length, `${note}: total cards`).toBe(71);

  // Wild cards only ever sit in a colour stack; the 3 no-bonus cards never do.
  for (const player of state.players) {
    for (const stack of player.stacks) {
      expect(stack.cardIds.length, `${note}: empty stack`).toBeGreaterThan(0);
      for (const id of stack.cardIds) {
        const def = card(id);
        expect(def.wild || def.bonusColor === stack.color, `${note}: ${id} in ${stack.color} stack`).toBe(true);
      }
    }
    for (const id of player.colorless) {
      const def = card(id);
      expect(def.wild).toBe(false);
      expect(def.bonusColor).toBeNull();
    }
    // One stack per colour.
    const colors = player.stacks.map((s) => s.color);
    expect(new Set(colors).size).toBe(colors.length);
    // Royals grant no crowns and no bonuses, so they must not be inside a stack.
    for (const id of player.royals) expect(card(id).kind).toBe('royal');
  }

  // The 10-token limit binds *between* turns only. Exceeding it mid-turn is explicitly legal: a
  // player sitting on 10 may spend privileges to take more and then buy a card in the same turn.
  // Note that `stage === 'optional'` is not "between turns" — it is "before the mandatory action",
  // which is still mid-turn and reachable with 11+ tokens.
  if (turnJustStarted) {
    for (const player of state.players) {
      expect(tokenTotal(player.tokens), `${note}: token limit at turn start`).toBeLessThanOrEqual(10);
    }
  }

  expect(state.board).toHaveLength(25);
  expect(state.royals).toHaveLength(4);
  expect(isJsonRoundTrippable(state), `${note}: state is plain JSON`).toBe(true);
}

/** Drive a whole match by choosing uniformly among legal actions. */
function playRandomGame(
  seed: string,
  options: SplendorOptions = {},
  onStep?: (state: SplendorState, action: SplendorAction) => void,
): { state: SplendorState; turns: number; actions: { seat: number; action: SplendorAction }[] } {
  let state = newGame(seed, options);
  const rng = new RandomCursor(`${seed}:policy`, 0);
  const actions: { seat: number; action: SplendorAction }[] = [];
  let steps = 0;

  while (state.stage !== 'over' && steps < 4000) {
    const seat = state.turn;
    const { actions: legal } = legalActions(state, seat);
    expect(legal.length, `no legal action at step ${steps} (stage ${state.stage})`).toBeGreaterThan(0);

    const choice = legal[rng.int(legal.length)]!;
    const result = apply(state, seat, choice);
    if (!result.ok) {
      throw new Error(`legal action was rejected: ${result.error.code} ${result.error.message} :: ${JSON.stringify(choice)}`);
    }
    actions.push({ seat, action: choice });
    state = result.state;
    steps += 1;
    onStep?.(state, choice);
    const turnJustStarted = result.effects.some((e) => e.k === 'turnStarted');
    assertInvariants(state, `seed ${seed} step ${steps}`, turnJustStarted);
  }
  return { state, turns: steps, actions };
}

/* ------------------------------------------------------------------ setup */

describe('setup', () => {
  it('puts all 25 tokens on the board and leaves the bag empty', () => {
    const s = newGame('setup-1');
    expect(s.bag).toHaveLength(0);
    expect(s.board.filter((t) => t !== null)).toHaveLength(25);
    // Replenish is therefore impossible on turn one.
    expect(legalActions(s, s.turn).actions.some((a) => a.t === 'replenish')).toBe(false);
  });

  it('reveals a 5/4/3 pyramid and leaves 25/20/10 in the decks', () => {
    const s = newGame('setup-2');
    for (const level of LEVELS) {
      expect(s.pyramid[level]).toHaveLength(PYRAMID_WIDTH[level]);
      expect(s.pyramid[level].every((id) => typeof id === 'string')).toBe(true);
    }
    expect(s.decks[1]).toHaveLength(25);
    expect(s.decks[2]).toHaveLength(20);
    expect(s.decks[3]).toHaveLength(10);
  });

  it('gives the second player one privilege and leaves two in the pool', () => {
    const s = newGame('setup-3');
    const second = (1 - s.turn) as 0 | 1;
    expect(s.players[second].privileges).toBe(1);
    expect(s.players[s.turn as 0 | 1].privileges).toBe(0);
    expect(s.privilegePool).toBe(2);
  });

  it('is deterministic for a given seed and differs across seeds', () => {
    expect(newGame('same')).toEqual(newGame('same'));
    expect(JSON.stringify(newGame('a'))).not.toBe(JSON.stringify(newGame('b')));
  });

  it('satisfies every invariant at t=0', () => {
    for (const seed of ['s1', 's2', 's3']) assertInvariants(newGame(seed), seed);
  });
});

/* ------------------------------------------------------------------ purity */

describe('apply is pure', () => {
  it('does not mutate the state it is given', () => {
    const s = newGame('purity');
    const before = JSON.stringify(s);
    const action = legalActions(s, s.turn).actions[0]!;
    apply(s, s.turn, action);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('is deterministic: applying the same action twice gives identical results', () => {
    const s = newGame('purity-2');
    const action = legalActions(s, s.turn).actions.find((a) => a.t === 'takeTokens')!;
    const a = apply(s, s.turn, action);
    const b = apply(s, s.turn, action);
    expect(a).toEqual(b);
  });

  it('rejects rather than throws on nonsense actions', () => {
    const s = newGame('purity-3');
    const bad: SplendorAction[] = [
      { t: 'takeTokens', cells: [0, 1, 2, 3] as number[] },
      { t: 'usePrivilege', cell: 99 },
      { t: 'chooseRoyal', royalId: 'nope' },
      { t: 'discard', tokens: { white: 5 } },
      { t: 'purchase', from: { t: 'reserved', cardId: 'nope' }, payment: {} },
    ];
    for (const action of bad) {
      const r = apply(s, s.turn, action);
      expect(r.ok, JSON.stringify(action)).toBe(false);
    }
  });

  it('refuses actions from the seat that is not to move', () => {
    const s = newGame('purity-4');
    const action = legalActions(s, s.turn).actions[0]!;
    const r = apply(s, (1 - s.turn) as 0 | 1, action);
    expect(r.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ random playthroughs */

describe('random playthroughs', () => {
  const seeds = Array.from({ length: 25 }, (_, i) => `game-${i}`);

  it('hold every invariant and always offer a legal action', () => {
    for (const seed of seeds) {
      const { state } = playRandomGame(seed, { maxTurnsWithoutPurchase: 60 });
      assertInvariants(state, `${seed} final`);
    }
  });

  it('reach a terminal state, and the winner really meets a victory condition', () => {
    let naturalWins = 0;
    for (const seed of seeds) {
      const { state } = playRandomGame(seed, { maxTurnsWithoutPurchase: 60 });
      expect(state.stage).toBe('over');
      if (state.winReason === 'stalled') continue;
      naturalWins += 1;
      expect(state.winner).not.toBeNull();
      const winner = state.players[state.winner as 0 | 1];
      expect(victoryFor(winner)).toBe(state.winReason);
      // Only the player who just moved can win; the opponent never gets an equalising turn.
      const loser = state.players[(1 - (state.winner as number)) as 0 | 1];
      expect(victoryFor(loser)).toBeNull();
    }
    // Random play should reach real victories most of the time, not just hit the stall guard.
    expect(naturalWins).toBeGreaterThan(seeds.length / 2);
  });

  it('exercise all three victory conditions across many seeds', () => {
    const reasons = new Set<string>();
    for (let i = 0; i < 120; i++) {
      const { state } = playRandomGame(`victory-${i}`, { maxTurnsWithoutPurchase: 200 });
      if (state.winReason) reasons.add(state.winReason);
    }
    // If a condition never fires under random play it is almost certainly unimplemented.
    expect(reasons).toContain('prestige');
    expect(reasons).toContain('crowns');
    expect(reasons).toContain('color');
  });

  it('keep stored score in step with the tableau', () => {
    playRandomGame('score-sync', { maxTurnsWithoutPurchase: 60 }, (state) => {
      for (const player of state.players) {
        const view = redactFor(0, state).players[player === state.players[0] ? 0 : 1];
        expect(view.points).toBe(totalPoints(player));
        expect(view.crowns).toBe(totalCrowns(player));
        expect(view.bonuses).toEqual(bonuses(player));
      }
    });
  });
});

/* ------------------------------------------------------------------ legality agreement */

describe('legalActions and isLegal agree', () => {
  it('accepts everything legalActions offers', () => {
    for (const seed of ['agree-1', 'agree-2', 'agree-3']) {
      let state = newGame(seed);
      const rng = new RandomCursor(`${seed}:pol`, 0);
      for (let step = 0; step < 220 && state.stage !== 'over'; step++) {
        const seat = state.turn;
        const { actions } = legalActions(state, seat);
        for (const action of actions) {
          expect(validate(state, seat, action), JSON.stringify(action)).toBe(true);
        }
        const result = apply(state, seat, actions[rng.int(actions.length)]!);
        if (!result.ok) throw new Error(result.error.message);
        state = result.state;
      }
    }
  });

  it('offers nothing to the seat that is not to move, or once the match is over', () => {
    const s = newGame('agree-4');
    expect(legalActions(s, (1 - s.turn) as 0 | 1).actions).toHaveLength(0);
    const over: SplendorState = { ...s, stage: 'over' };
    expect(legalActions(over, over.turn).actions).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ the stuck position */

describe('the position the official rules do not cover', () => {
  /**
   * A player can legally exceed 10 tokens mid-turn by spending privileges, so the usual argument
   * that "board + bag >= 5, therefore a one-token take is always available" does not hold. Push it
   * far enough and a player has no mandatory action at all: the board holds nothing but gold, the
   * bag is empty, three cards are already reserved, and nothing is affordable.
   *
   * Random play finds this in well under a hundred moves, so it is not a curiosity. The rulebook
   * offers no resolution, so `pass` exists — narrowly legal, and self-unsticking.
   */
  /**
   * Built from a real setup so the whole 71-card census and the token and privilege economies stay
   * intact — otherwise the invariants would (correctly) reject the fixture itself.
   */
  function stuckState(): SplendorState {
    const s: SplendorState = JSON.parse(JSON.stringify(newGame('stuck')));

    // Board holds nothing but gold; bag empty. Only 3 of the 25 tokens are outside players' hands.
    s.bag = [];
    s.board = new Array(25).fill(null);
    for (const cell of [7, 11, 12]) s.board[cell] = 'gold';

    s.turn = 0;
    s.stage = 'optional';
    s.pending = null;
    s.replenishedThisTurn = false;
    // All three scrolls sit above the board: the economy still sums to 3, but neither player holds
    // one, so nobody can spend a privilege to take a token.
    s.privilegePool = 3;
    s.players[0].privileges = 0;
    s.players[1].privileges = 0;

    // 22 tokens between them (10 and 12), which is what being stuck implies. Neither hand can pay
    // for a level-3 card, and neither player has any bonus to discount one.
    s.players[0].tokens = { white: 2, blue: 0, green: 4, red: 2, black: 0, pearl: 2, gold: 0 };
    s.players[1].tokens = { white: 2, blue: 4, green: 0, red: 2, black: 4, pearl: 0, gold: 0 };

    // Both players hold the maximum 3 reservations, which is what blocks the reserve action. The
    // pyramid is emptied into the decks, so there is nothing face-up to buy either.
    const reserved = [
      ['l3-01', 'l3-03', 'l3-05'],
      ['l3-07', 'l3-09', 'l3-02'],
    ];
    const parked = new Set(reserved.flat());
    const remaining: Record<1 | 2 | 3, string[]> = { 1: [], 2: [], 3: [] };
    for (const level of LEVELS) {
      const pool = [...s.decks[level], ...s.pyramid[level].filter((id): id is string => id !== null)];
      remaining[level] = pool.filter((id) => !parked.has(id));
      s.pyramid[level] = s.pyramid[level].map(() => null);
    }
    for (const level of LEVELS) s.decks[level] = remaining[level];
    s.players[0].reserved = reserved[0]!.map((cardId) => ({ cardId, publiclyKnown: true }));
    s.players[1].reserved = reserved[1]!.map((cardId) => ({ cardId, publiclyKnown: true }));

    return s;
  }

  it('offers exactly one action - pass - when the player is genuinely stuck', () => {
    const s = stuckState();
    const { actions } = legalActions(s, 0);
    expect(actions).toEqual([{ t: 'pass' }]);
  });

  it('refuses a pass whenever any real action exists', () => {
    const fresh = newGame('no-passing');
    expect(validate(fresh, fresh.turn, { t: 'pass' })).not.toBe(true);
    expect(legalActions(fresh, fresh.turn).actions.some((a) => a.t === 'pass')).toBe(false);
  });

  it('refuses a pass when replenishing is still possible', () => {
    const s = stuckState();
    s.bag = ['white'];
    expect(validate(s, 0, { t: 'pass' })).not.toBe(true);
    expect(legalActions(s, 0).actions).toEqual([{ t: 'replenish' }]);
  });

  /**
   * Passing cannot loop forever, and the reason is a counting argument rather than a turn cap.
   *
   * Being stuck means the board holds only gold and the bag is empty, so at most 3 of the 25 tokens
   * are outside the players' hands — the two of them therefore hold at least 22. Both cannot be at
   * or under 10, so at least one is over the limit and *their* end-of-turn discard is forced. That
   * discard goes to the bag, which makes the next replenish legal and refills the board.
   *
   * Here it is the opponent who is over, so it takes one pass each: the worst case.
   */
  it('unsticks itself within one pass each, because someone must be over the token limit', () => {
    let state = stuckState();
    expect(tokenTotal(state.players[0].tokens)).toBe(10);
    expect(tokenTotal(state.players[1].tokens)).toBe(12);

    // Seat 0 is exactly at the limit, so its pass discards nothing and the bag stays empty.
    const first = apply(state, 0, { t: 'pass' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.state;
    expect(state.pending).toBeNull();
    expect(state.bag).toHaveLength(0);
    expect(state.turn).toBe(1);

    // Seat 1 is stuck too, but it is over the limit, so its pass forces a discard.
    expect(legalActions(state, 1).actions).toEqual([{ t: 'pass' }]);
    const second = apply(state, 1, { t: 'pass' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.pending).toEqual({ k: 'discard', count: 2 });

    const discarded = apply(second.state, 1, { t: 'discard', tokens: { blue: 2 } });
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;

    // Those tokens are now in the bag, so the board can be refilled and play resumes.
    expect(discarded.state.bag).toEqual(['blue', 'blue']);
    expect(legalActions(discarded.state, discarded.state.turn).actions).toEqual([{ t: 'replenish' }]);
    assertInvariants(discarded.state, 'after unsticking', true);
  });
});

/* ------------------------------------------------------------------ redaction */

describe('reserving a card and then buying it', () => {
  /**
   * The whole point of reserving is to buy the card later, so the round trip deserves its own test
   * rather than being left to random playthroughs to stumble across.
   */
  it('moves a reserved card into your tableau and frees the reservation slot', () => {
    let state = newGame('reserve-then-buy');
    const seat = state.turn;

    // A level-1 pyramid card specifically: cheap enough that the board holds the price.
    const reserve = legalActions(state, seat).actions.find(
      (a): a is Extract<SplendorAction, { t: 'reserve' }> =>
        a.t === 'reserve' && a.from.t === 'pyramid' && a.from.level === 1,
    );
    expect(reserve, 'a reserve should be available on the opening turn').toBeDefined();
    const first = apply(state, seat, reserve!);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.state;

    const held = state.players[seat].reserved[0]!;
    expect(state.players[seat].reserved).toHaveLength(1);
    // Reserving is the only way to get gold, and gold is what makes the card affordable later.
    expect(state.players[seat].tokens.gold).toBe(1);

    /*
     * Sweep the board into this player's hand so they can afford the card, by *moving* tokens
     * rather than inventing them -- conservation still has to hold at the end, or the invariant
     * check below would be measuring a state the game could never reach.
     */
    const swept = { ...state.players[seat].tokens };
    for (const token of state.board) if (token) swept[token] += 1;
    const players = [...state.players] as SplendorState['players'];
    players[seat] = { ...players[seat], tokens: swept };
    const rich: SplendorState = {
      ...state,
      board: state.board.map(() => null),
      players,
      turn: seat,
      stage: 'optional',
    };

    const buy = legalActions(rich, seat).actions.find(
      (a) => a.t === 'purchase' && a.from.t === 'reserved' && a.from.cardId === held.cardId,
    );
    expect(buy, 'the reserved card should be purchasable once affordable').toBeDefined();

    /*
     * And the same offer has to be visible from the redacted view, because that -- not the truth
     * state -- is what the board renders its affordances from. A purchase the server would accept
     * but the view does not surface is a card the player can never click.
     */
    const fromView = legalActionsFromView(redactFor(seat, rich), seat).actions;
    expect(
      fromView.some((a) => a.t === 'purchase' && a.from.t === 'reserved' && a.from.cardId === held.cardId),
      'the view must offer the reserved-card purchase too',
    ).toBe(true);

    const bought = apply(rich, seat, buy!);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const after = bought.state.players[seat];
    expect(after.reserved, 'the reservation slot is freed').toHaveLength(0);
    const owned = [...after.stacks.flatMap((st) => st.cardIds), ...after.colorless];
    expect(owned, 'the card is now in the tableau').toContain(held.cardId);
    assertInvariants(bought.state, 'after buying a reserved card');
  });
});

describe('redaction', () => {
  it('never leaks the seed, deck order, or a secretly reserved card', () => {
    playRandomGame('leak', { maxTurnsWithoutPurchase: 60 }, (state) => {
      for (const viewer of [0, 1, null] as const) {
        const view = redactFor(viewer, state);
        const leaked = findLeakedSecrets(view, secretsFor(viewer, state));
        expect(leaked, `viewer ${viewer} leaked ${leaked.join(',')}`).toEqual([]);
      }
    });
  });

  it('reveals how many tokens are in the bag, and nothing about which', () => {
    const state = newGame('bag');
    const withBag: SplendorState = { ...state, bag: ['white', 'blue', 'pearl'] };
    const view = redactFor(0, withBag);
    expect(view.bag.total).toBe(3);

    /*
     * Replenish draws blind from the bag, so its composition is worth real money. A player at a
     * table has to earn that by tracking every token spent; the view must not do it for them.
     *
     * Swapping the contents for three of something else has to leave the view identical -- which
     * also rules out any per-colour field creeping back in under another name.
     */
    const different: SplendorState = { ...state, bag: ['black', 'black', 'gold'] };
    expect(JSON.stringify(redactFor(0, different))).toBe(JSON.stringify(view));
  });

  it('is view-stable: permuting hidden information changes nothing an opponent can see', () => {
    // This is the check that closes leaks by array length, key order and payload size — an
    // observer must not be able to infer hidden state from the shape of what they receive.
    const base = newGame('stability');
    const rng = new RandomCursor('stability:perm', 0);
    const permuted: SplendorState = {
      ...base,
      seed: 'a-completely-different-seed',
      rngCounter: base.rngCounter + 999,
      bag: rng.shuffle(['white', 'white', 'blue', 'gold']),
      decks: {
        1: rng.shuffle(base.decks[1]),
        2: rng.shuffle(base.decks[2]),
        3: rng.shuffle(base.decks[3]),
      },
    };
    const withBag: SplendorState = { ...base, bag: rng.shuffle(['blue', 'white', 'gold', 'white']) };

    expect(JSON.stringify(redactFor(1, permuted))).toBe(JSON.stringify(redactFor(1, withBag)));
    expect(JSON.stringify(redactFor(null, permuted))).toBe(JSON.stringify(redactFor(null, withBag)));
  });

  it('hides a deck-drawn reservation from the opponent but keeps the slot visible', () => {
    const state = newGame('reserve-secrecy');
    const hidden: SplendorState = JSON.parse(JSON.stringify(state));
    hidden.players[0].reserved = [
      { cardId: 'l1-01', publiclyKnown: true },
      { cardId: 'l3-02', publiclyKnown: false },
    ];

    const own = redactFor(0, hidden).players[0].reserved;
    expect(own).toEqual([{ cardId: 'l1-01' }, { cardId: 'l3-02' }]);

    const theirs = redactFor(1, hidden).players[0].reserved;
    // Count is preserved (3 reservations blocks further ones, which is public), identity is not.
    expect(theirs).toEqual([{ cardId: 'l1-01' }, { hidden: true }]);
    expect(JSON.stringify(theirs)).not.toContain('l3-02');
  });
});
