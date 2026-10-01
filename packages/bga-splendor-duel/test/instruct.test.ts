import { apply, legalActions, legalActionsFromView, setup, type SplendorAction, type SplendorState } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { instruct } from '../src/instruct.js';
import { locate } from '../src/locate.js';
import { emptyMemory, remember, type Memory } from '../src/memory.js';
import { toView } from '../src/toView.js';
import { bgaCardId, boardTokenId, snap } from './support/synth.js';
import { walk } from './support/play.js';

/**
 * In `advise` mode this text is the whole interface between the bot and the table. A move the
 * operator cannot find, or finds the wrong one of, is a move the bot did not make.
 */

function advise(state: SplendorState, viewer: 0 | 1, action: SplendorAction) {
  const snapshot = snap(state, viewer);
  const result = toView(snapshot, remember(emptyMemory(), snapshot));
  if (!result.ok) throw new Error(result.refusal.detail);
  return instruct(action, result.view, locate(snapshot));
}

describe('instruct', () => {
  const opening = setup({ seed: 'instruct', seats: [0, 1], options: {} });
  const mover = opening.turn as 0 | 1;
  const legal = legalActions(opening, mover).actions;
  const first = <T extends SplendorAction['t']>(t: T, also: (a: Extract<SplendorAction, { t: T }>) => boolean = () => true) => {
    const found = legal.find((a): a is Extract<SplendorAction, { t: T }> => a.t === t && also(a as Extract<SplendorAction, { t: T }>));
    if (!found) throw new Error(`the opening offers no ${t}`);
    return found;
  };

  it('names each token to take by colour and by where it is on the BGA board, and highlights them', () => {
    const take = first('takeTokens', (a) => a.cells.length === 3);
    const said = advise(opening, mover, take);
    expect(said.highlight).toEqual(take.cells.map((cell) => `token-${boardTokenId(cell)}`));
    for (const cell of take.cells) expect(said.steps.join(' ')).toContain(opening.board[cell] as string);
    expect(said.steps.join(' ')).toMatch(/row \d, column \d/);
    expect(said.steps.at(-1)).toMatch(/confirm/i);
  });

  it('gives a table reservation as two steps: the gold, then the card', () => {
    const reserve = first('reserve', (a) => a.from.t === 'pyramid');
    if (reserve.from.t !== 'pyramid') throw new Error('unreachable');
    const cardId = opening.pyramid[reserve.from.level][reserve.from.slot] as string;
    const said = advise(opening, mover, reserve);
    expect(said.steps).toHaveLength(2);
    expect(said.steps[0]).toMatch(/gold/);
    expect(said.steps[1]).toContain(`level ${reserve.from.level}`);
    expect(said.steps[1]).toContain(`card ${reserve.from.slot + 1}`);
    expect(said.highlight).toEqual([`token-${boardTokenId(reserve.goldCell)}`, `card-${bgaCardId(cardId)}`]);
  });

  it('points at the deck itself for a blind reservation', () => {
    const reserve = first('reserve', (a) => a.from.t === 'deck' && a.from.level === 2);
    const said = advise(opening, mover, reserve);
    expect(said.highlight[1]).toBe('card-deck-2');
    expect(said.steps[1]).toMatch(/level 2 deck/);
  });

  it('has something to say for every legal move of a whole game, and never points at nothing', () => {
    let said = 0;
    const memory: [Memory, Memory] = [emptyMemory(), emptyMemory()];
    const kinds = new Set<string>();
    walk('instruct-walk', 400, (state) => {
      if (state.stage === 'over') return;
      for (const viewer of [0, 1] as const) {
        const snapshot = snap(state, viewer);
        memory[viewer] = remember(memory[viewer], snapshot);
        if (state.turn !== viewer) continue;
        const result = toView(snapshot, memory[viewer]);
        if (!result.ok) throw new Error(result.refusal.detail);
        const at = locate(snapshot);
        for (const action of legalActionsFromView(result.view, viewer).actions) {
          if (action.t === 'pass') continue;
          const instruction = instruct(action, result.view, at);
          expect(instruction.text.length).toBeGreaterThan(0);
          expect(instruction.steps.length).toBeGreaterThan(0);
          for (const id of instruction.highlight) expect(id).toMatch(/^(token|card|royal-card|card-deck)-\d+$/);
          // And the move it describes is one the engine accepts, so the words are about a real move.
          expect(apply(state, viewer, action).ok).toBe(true);
          kinds.add(action.t);
          said += 1;
        }
      }
    });
    expect(said).toBeGreaterThan(1000);
    for (const kind of ['takeTokens', 'usePrivilege', 'replenish', 'reserve', 'purchase', 'chooseRoyal', 'discard']) {
      expect(kinds.has(kind), `no ${kind} was ever legal in this game; change the seed`).toBe(true);
    }
  });

  it('refuses to describe a pass, because BGA has no such move', () => {
    const snapshot = snap(opening, mover);
    const result = toView(snapshot, remember(emptyMemory(), snapshot));
    if (!result.ok) throw new Error(result.refusal.detail);
    expect(() => instruct({ t: 'pass' }, result.view, locate(snapshot))).toThrow(/pass/);
  });
});
