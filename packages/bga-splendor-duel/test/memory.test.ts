import { apply, legalActions, setup, type SplendorAction, type SplendorState } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { emptyMemory, remember } from '../src/memory.js';
import { bgaCardId, snap } from './support/synth.js';
import { walk } from './support/play.js';

/**
 * Three things a snapshot does not carry, and the adapter needs.
 *
 * Each is tested through the engine rather than with hand-built snapshots: the question is always
 * "after this real sequence of moves, does memory say the true thing", and a hand-built snapshot
 * would only show that memory agrees with whoever built it.
 */

function must(state: SplendorState, action: SplendorAction): SplendorState {
  const result = apply(state, state.turn, action);
  if (!result.ok) throw new Error(result.error.message);
  return result.state;
}

/** Every position of a game, in order, with the position its turn's mandatory action was taken from. */
function positions(seed: string, moves: number): [SplendorState, SplendorState | undefined][] {
  const out: [SplendorState, SplendorState | undefined][] = [];
  walk(seed, moves, (state, before) => out.push([state, before]));
  return out;
}

describe('cards seen face-up', () => {
  it('knows an opponent reservation that was taken from the table, and not one taken from a deck', () => {
    const opening = setup({ seed: 'memory-reserve', seats: [0, 1], options: {} });
    const opponent = opening.turn as 0 | 1;
    const viewer = (1 - opponent) as 0 | 1;
    const reserves = legalActions(opening, opponent).actions.filter(
      (a): a is Extract<SplendorAction, { t: 'reserve' }> => a.t === 'reserve',
    );
    const fromTable = reserves.find((a) => a.from.t === 'pyramid');
    const fromDeck = reserves.find((a) => a.from.t === 'deck');
    if (!fromTable || !fromDeck || fromTable.from.t !== 'pyramid') throw new Error('the opening always offers both');

    const taken = opening.pyramid[fromTable.from.level][fromTable.from.slot] as string;
    let memory = remember(emptyMemory(), snap(opening, viewer));
    memory = remember(memory, snap(must(opening, fromTable), viewer));
    expect(memory.seen[String(bgaCardId(taken))]).toBe(taken);

    const blind = must(opening, fromDeck);
    const hidden = blind.players[opponent].reserved[0]?.cardId as string;
    const fresh = remember(remember(emptyMemory(), snap(opening, viewer)), snap(blind, viewer));
    expect(fresh.seen[String(bgaCardId(hidden))]).toBeUndefined();
  });
});

describe('the turn baseline', () => {
  it('holds what we owned before this turn’s purchase, through every decision the purchase causes', () => {
    let memory = emptyMemory();
    let checked = 0;
    const all = positions('memory-baseline', 400);
    all.forEach(([state, turnStart], i) => {
      if (state.stage === 'over') return;
      const viewer = 0;
      memory = remember(memory, snap(state, viewer, turnStart));
      if (state.turn !== viewer || state.pending === null) return;
      // Walk back to the start of this turn: the last position where it was our optional stage.
      let start = i;
      while (start > 0 && !(all[start]![0].turn === viewer && all[start]![0].stage === 'optional')) start -= 1;
      const before = all[start]![0].players[viewer];
      const owned = [...before.stacks.flatMap((s) => s.cardIds), ...before.colorless].sort();
      expect([...(memory.baseline?.cards ?? [])].sort()).toEqual(owned);
      expect([...(memory.baseline?.royals ?? [])].sort()).toEqual([...before.royals].sort());
      checked += 1;
    });
    expect(checked).toBeGreaterThan(5);
  });
});

describe('our own replenish', () => {
  it('is recognised when it happens, and only then', () => {
    let seen = 0;
    for (const viewer of [0, 1] as const) {
      let memory = emptyMemory();
      walk('memory-replenish', 500, (state, before) => {
        if (state.stage === 'over') return;
        memory = remember(memory, snap(state, viewer, before));
        if (state.turn !== viewer) return;
        expect(memory.replenished, `turn ${state.turn}, stage ${state.stage}`).toBe(state.replenishedThisTurn);
        if (state.replenishedThisTurn) seen += 1;
      });
    }
    // The property is vacuous if the game never replenished.
    expect(seen).toBeGreaterThan(0);
  });

  it('is not forgotten when the same position is looked at twice', () => {
    let memory = emptyMemory();
    let repeated = 0;
    walk('memory-replenish', 500, (state, before) => {
      if (state.stage === 'over') return;
      memory = remember(memory, snap(state, 0, before));
      if (state.turn === 0 && state.replenishedThisTurn) {
        // A page reload, or the adapter restarting its loop, shows the identical snapshot again.
        memory = remember(memory, snap(state, 0, before));
        expect(memory.replenished).toBe(true);
        repeated += 1;
      }
    });
    expect(repeated).toBeGreaterThan(0);
  });
});
