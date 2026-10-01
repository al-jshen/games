import { RandomCursor } from '@games/engine';
import { LEVELS, redactFor, setup, type SplendorView } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { determinizeBga } from '../src/determinizeBga.js';
import { emptyMemory, remember, type Memory } from '../src/memory.js';
import { toView } from '../src/toView.js';
import { canonical } from './support/canonical.js';
import { walk } from './support/play.js';
import { snap, unrefilled } from './support/synth.js';

/**
 * BGA refills the table at the end of the turn; our engine at once. So mid-turn, a BGA view has an
 * empty slot over a non-empty deck, which never happens in our engine, and a search run on it as it
 * stands would plan every future one card short. `determinizeBga` deals that slot the card BGA will
 * deal it -- one the seat has not seen -- and the result has to be our engine's own position, up to
 * which unseen card that is.
 */

const plain = (view: unknown): SplendorView => JSON.parse(JSON.stringify(view)) as SplendorView;

describe('determinizeBga', () => {
  it('turns every mid-turn BGA view back into the position our engine would be in', () => {
    let checked = 0;
    let refilled = 0;
    for (const seed of ['dbga-a', 'dbga-b', 'dbga-c']) {
      const memory: [Memory, Memory] = [emptyMemory(), emptyMemory()];
      walk(seed, 400, (state, before) => {
        if (state.stage === 'over') return;
        for (const viewer of [0, 1] as const) {
          const snapshot = snap(state, viewer, before);
          memory[viewer] = remember(memory[viewer], snapshot);
          if (state.turn !== viewer || state.pending === null) continue;

          const result = toView(snapshot, memory[viewer]);
          if (!result.ok) throw new Error(result.refusal.detail);
          const world = determinizeBga(result.view, viewer, new RandomCursor(`${seed}:${checked}`, 0));
          const got = plain(redactFor(viewer, world));
          const want = plain(redactFor(viewer, state));

          for (const level of LEVELS) {
            if (world.decks[level].length > 0) expect(got.pyramid[level]).not.toContain(null);
          }
          expect(got.decks).toEqual(want.decks);

          // Everything but the identity of the card dealt into each slot BGA had left empty.
          const slots = unrefilled(state, before);
          for (const { level, slot } of slots) {
            expect(got.pyramid[level][slot]).not.toBeNull();
            got.pyramid[level][slot] = 'dealt';
            want.pyramid[level][slot] = 'dealt';
          }
          expect(canonical(got)).toEqual(canonical(want));
          if (slots.length > 0) refilled += 1;
          checked += 1;
        }
      });
    }
    expect(checked).toBeGreaterThan(30);
    expect(refilled).toBeGreaterThan(5);
  });

  it('deals into an empty slot over a non-empty deck, and leaves one empty whose deck ran out', () => {
    const state = setup({ seed: 'dbga-unit', seats: [0, 1], options: {} });
    const seat = state.turn as 0 | 1;
    const view = plain(redactFor(seat, state));
    // Level 1, as BGA shows it mid-turn: the slot empty, its card back on top of the deck, unseen.
    view.pyramid[1][2] = null;
    view.decks[1] += 1;
    // Level 3 with its deck spent: every card of it is somewhere the seat can see. Filed as our own
    // colourless cards, which nothing here reads beyond "seen".
    view.players[seat].colorless.push(view.pyramid[3][0] as string, ...state.decks[3]);
    view.pyramid[3][0] = null;
    view.decks[3] = 0;

    const world = determinizeBga(view, seat, new RandomCursor('dbga-unit', 0));
    expect(world.pyramid[1][2]).not.toBeNull();
    expect(world.decks[1]).toHaveLength(view.decks[1] - 1);
    expect(world.pyramid[3][0]).toBeNull();
    expect(world.decks[3]).toHaveLength(0);
  });
});
