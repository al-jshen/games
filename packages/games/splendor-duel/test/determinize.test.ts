import { RandomCursor } from '@games/engine';
import { describe, expect, it } from 'vitest';
import { apply } from '../src/apply.js';
import { jewelDeck } from '../src/cards.js';
import { determinize } from '../src/determinize.js';
import { legalActions } from '../src/legal.js';
import { redactFor } from '../src/redact.js';
import { setup } from '../src/setup.js';
import type { Seat, SplendorState, SplendorView, TokenColor } from '../src/types.js';
import { LEVELS, TOKEN_COLORS, TOKEN_SUPPLY } from '../src/types.js';

/**
 * Sampling a world you might be in.
 *
 * A search under imperfect information is only as good as this: if a sampled world is not consistent
 * with what the player actually knows, every value computed from it is about a game nobody is
 * playing. So the property that matters is not "it looks plausible" but a round trip — redacting a
 * determinization has to give back the exact view it came from, byte for byte.
 */

function positions(seed: string, moves: number): SplendorState[] {
  let state = setup({ seed, seats: [0, 1], options: {} });
  const rng = new RandomCursor(`${seed}:play`, 0);
  const out: SplendorState[] = [state];
  for (let i = 0; i < moves; i++) {
    const seat = state.turn;
    const { actions } = legalActions(state, seat);
    if (actions.length === 0) break;
    const result = apply(state, seat, actions[rng.int(actions.length)]!);
    if (!result.ok) break;
    state = result.state;
    out.push(state);
  }
  return out;
}

const viewOf = (state: SplendorState, seat: Seat): SplendorView =>
  JSON.parse(JSON.stringify(redactFor(seat, state))) as SplendorView;

describe('determinize', () => {
  it('produces a world that redacts back to exactly the view it came from', () => {
    /*
     * The whole contract in one assertion. Anything the viewer can see must survive untouched, and
     * anything they cannot must be filled in a way they could not tell apart from the truth.
     */
    let checked = 0;
    for (const [i, state] of positions('determinize-roundtrip', 60).entries()) {
      for (const seat of [0, 1] as const) {
        const view = viewOf(state, seat);
        for (let sample = 0; sample < 3; sample++) {
          const world = determinize(view, seat, new RandomCursor(`d${i}:${seat}:${sample}`, 0));
          expect(JSON.stringify(redactFor(seat, world)), `move ${i}, seat ${seat}, sample ${sample}`).toBe(
            JSON.stringify(view),
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('conserves every card and every token, like a real position', () => {
    // A sampled world the rules could not have produced would let the search find moves that do not
    // exist, or value positions that cannot occur.
    for (const [i, state] of positions('determinize-invariants', 40).entries()) {
      for (const seat of [0, 1] as const) {
        const world = determinize(viewOf(state, seat), seat, new RandomCursor(`inv${i}:${seat}`, 0));

        const tokens: Record<TokenColor, number> = { white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0, gold: 0 };
        for (const token of world.board) if (token) tokens[token] += 1;
        for (const token of world.bag) tokens[token] += 1;
        for (const player of world.players) for (const c of TOKEN_COLORS) tokens[c] += player.tokens[c];
        for (const color of TOKEN_COLORS) {
          expect(tokens[color], `${color} at move ${i}`).toBe(TOKEN_SUPPLY[color]);
        }

        const placed: string[] = [];
        for (const level of LEVELS) {
          placed.push(...world.decks[level]);
          for (const id of world.pyramid[level]) if (id) placed.push(id);
        }
        for (const player of world.players) {
          for (const held of player.reserved) placed.push(held.cardId);
          for (const stack of player.stacks) placed.push(...stack.cardIds);
          placed.push(...player.colorless);
        }
        // Every jewel card in exactly one place, none invented, none lost.
        expect(new Set(placed).size, `duplicate cards at move ${i}`).toBe(placed.length);
        expect(placed.length).toBe(LEVELS.reduce((n, l) => n + jewelDeck(l).length, 0));
      }
    }
  });

  it('samples different worlds, and only in the parts that are hidden', () => {
    const state = positions('determinize-varies', 30).at(-1)!;
    const seat: Seat = 0;
    const view = viewOf(state, seat);
    const worlds = [0, 1, 2, 3, 4, 5].map((n) => determinize(view, seat, new RandomCursor(`vary${n}`, 0)));

    // Different hidden information...
    const decks = new Set(worlds.map((w) => JSON.stringify(w.decks)));
    expect(decks.size, 'every sample drew the same deck order').toBeGreaterThan(1);
    // ...and different futures, or the chance nodes would be collapsed to one outcome.
    const seeds = new Set(worlds.map((w) => w.seed));
    expect(seeds.size).toBe(worlds.length);

    // ...but identical in everything public.
    for (const world of worlds) {
      expect(world.board).toEqual(state.board);
      expect(world.turn).toBe(state.turn);
      expect(world.stage).toBe(state.stage);
      expect(world.players[seat].tokens).toEqual(state.players[seat].tokens);
    }
  });

  it('offers the searcher the same moves the real position would', () => {
    /*
     * The point of a determinization is to be searchable. If the legal moves differed from the truth,
     * the search would be planning in a game the player is not in — and for the acting player they
     * cannot differ, because every input to legality is either public or their own.
     */
    for (const [i, state] of positions('determinize-legal', 40).entries()) {
      const seat = state.turn;
      const world = determinize(viewOf(state, seat), seat, new RandomCursor(`legal${i}`, 0));
      const real = legalActions(state, seat).actions;
      const sampled = legalActions(world, seat).actions;
      expect(JSON.stringify(sampled), `move ${i}`).toBe(JSON.stringify(real));
    }
  });

  it('keeps the opponent honest: their hidden card is one that is really unaccounted for', () => {
    const state = positions('determinize-hidden', 50).at(-1)!;
    const seat: Seat = 0;
    const view = viewOf(state, seat);
    const world = determinize(view, seat, new RandomCursor('hidden', 0));

    const theirs = world.players[1].reserved.filter((r) => !r.publiclyKnown).map((r) => r.cardId);
    for (const cardId of theirs) {
      // Not a card the viewer can already see somewhere else.
      const visible = [
        ...LEVELS.flatMap((l) => view.pyramid[l]),
        ...view.players.flatMap((p) => [...p.stacks.flatMap((s) => s.cardIds), ...p.colorless]),
        ...view.players.flatMap((p) => p.reserved.flatMap((r) => ('cardId' in r ? [r.cardId] : []))),
      ];
      expect(visible).not.toContain(cardId);
    }
  });
});
