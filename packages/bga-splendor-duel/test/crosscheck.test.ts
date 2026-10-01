import { legalActionsFromView, setup } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { crossCheck } from '../src/crosscheck.js';
import { locate } from '../src/locate.js';
import { emptyMemory, remember, type Memory } from '../src/memory.js';
import { parseSnapshot, type BgaSnapshot } from '../src/snapshot.js';
import { toView } from '../src/toView.js';
import { bgaCardId, boardTokenId, snap, synthSnapshot } from './support/synth.js';
import { walk } from './support/play.js';

/**
 * Two implementations of the same rules, asked the same question.
 *
 * BGA tells the active player what they may do — whether they can replenish, whether they can
 * reserve, exactly which cards they can afford. Our engine works the same things out from the view.
 * Where the two differ, one of them is looking at a different position, and that is the moment to
 * stop: it is the cheapest possible detector for every translation bug nobody thought to test.
 */

function translated(snapshot: BgaSnapshot, memory: Memory) {
  const result = toView(snapshot, memory);
  if (!result.ok) throw new Error(result.refusal.detail);
  return result;
}

describe('crossCheck', () => {
  it('finds nothing to object to in a whole game, except being stuck', () => {
    let checked = 0;
    const memory: [Memory, Memory] = [emptyMemory(), emptyMemory()];
    walk('crosscheck', 400, (state, before) => {
      if (state.stage === 'over') return;
      for (const viewer of [0, 1] as const) {
        const snapshot = snap(state, viewer, before);
        memory[viewer] = remember(memory[viewer], snapshot);
        if (state.turn !== viewer) continue;
        const { view, seat } = translated(snapshot, memory[viewer]);
        const problems = crossCheck(view, seat, snapshot);
        const { actions } = legalActionsFromView(view, seat);
        const stuck = actions.length === 1 && actions[0]?.t === 'pass';
        if (stuck) expect(problems.join(' ')).toMatch(/stuck/);
        else expect(problems).toEqual([]);
        checked += 1;
      }
    });
    expect(checked).toBeGreaterThan(100);
  });

  const opening = setup({ seed: 'crosscheck-opening', seats: [0, 1], options: {} });
  const mover = opening.turn as 0 | 1;
  const edited = (mutate: (snapshot: any) => void) => {
    const raw = JSON.parse(JSON.stringify(synthSnapshot(opening, mover))) as any;
    mutate(raw);
    const parsed = parseSnapshot(raw);
    if (!parsed.ok) throw new Error(parsed.refusal.detail);
    const result = toView(parsed.snapshot, remember(emptyMemory(), parsed.snapshot));
    if (!result.ok) throw new Error(result.refusal.detail);
    return crossCheck(result.view, result.seat, parsed.snapshot);
  };

  it('objects when BGA would let us replenish and we would not', () => {
    // The opening has an empty bag, so neither side should offer it.
    expect(edited(() => {})).toEqual([]);
    expect(edited((s) => (s.gamestate.args.canRefill = true)).join(' ')).toMatch(/replenish/i);
  });

  it('objects when BGA and we disagree about which cards can be bought', () => {
    const anyTableCard = bgaCardId(opening.pyramid[1][0] as string);
    const problems = edited((s) => {
      s.gamestate.args.canBuyCard = true;
      s.gamestate.args.buyableCards = { [anyTableCard]: [{}] };
    });
    expect(problems.join(' ')).toMatch(/afford/i);
    expect(problems.join(' ')).toContain(opening.pyramid[1][0] as string);
  });

  it('objects when BGA says we cannot reserve and we think we can', () => {
    expect(edited((s) => (s.gamestate.args.canReserve = false)).join(' ')).toMatch(/reserve/i);
  });

  it('stops when BGA says we are hoarding every gold and pearl, a rule our engine does not model', () => {
    const problems = edited((s) => (s.gamestate.args.playerAntiPlaying = true));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/our seat/i);
    expect(problems[0]).toMatch(/opponent may end the game/i);
    expect(problems[0]).toMatch(/not model/i);
  });

  it('stops when BGA says the opponent is hoarding every gold and pearl', () => {
    const problems = edited((s) => (s.gamestate.args.opponentAntiPlaying = true));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/opponent/i);
    expect(problems[0]).toMatch(/we may end the game/i);
    expect(problems[0]).toMatch(/not model/i);
  });
});

describe('locate', () => {
  it('finds every cell, card and deck the legal moves of a position refer to', () => {
    const opening = setup({ seed: 'locate', seats: [0, 1], options: {} });
    const mover = opening.turn as 0 | 1;
    const at = locate(snap(opening, mover));
    opening.board.forEach((color, cell) => {
      if (color !== null) expect(at.boardToken.get(cell)?.id).toBe(boardTokenId(cell));
    });
    for (const level of [1, 2, 3] as const) {
      for (const id of opening.pyramid[level]) {
        if (id) expect(at.cardBgaId.get(id)).toBe(bgaCardId(id));
        if (id) expect(at.ourCardId.get(bgaCardId(id))).toBe(id);
      }
      expect(at.deckTop[level]).toBe(bgaCardId(opening.decks[level][0] as string));
    }
    expect(at.royalBgaId.size).toBe(4);
    expect(Object.values(at.myTokens).flat()).toEqual([]);
  });
});
