import { emptyMemory } from '@games/bga-splendor-duel';
import { RandomCursor } from '@games/engine';
import { legalActionsFromView, redactFor } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { FakeTable } from '../../../packages/bga-splendor-duel/test/support/fakeTable.ts';
import { pick } from '../../../packages/bga-splendor-duel/test/support/play.ts';
import { makeAdvise } from '../advise.mjs';
import { runTable } from '../loop.mjs';
import { resultOf } from '../results.mjs';

/**
 * The loop, against a table made of our own engine.
 *
 * What is under test is everything either side of the search: noticing that it is our turn,
 * surviving a turn made of several decisions, waiting out the opponent, taking a fresh snapshot
 * each time, stopping cleanly, and knowing when the game is over. The brain here is random, on
 * purpose -- it is fast, and it reaches odd positions a good player would not.
 */

const randomBrain = (seed) => {
  const rng = new RandomCursor(`${seed}:brain`, 0);
  return (view, seat) => ({ action: pick(legalActionsFromView(view, seat).actions, rng), value: 0 });
};

const quiet = { say: () => {}, sleep: async () => {} };

/** A game either finishes, or reaches the one position our rules and BGA's handle differently. */
function endedProperly(result) {
  if (result.outcome === 'finished') return true;
  return result.refusal.reason === 'disagreement' && /stuck/.test(result.refusal.detail);
}

describe('runTable, advising', () => {
  it('advises every one of our decisions through a whole game, from either seat', async () => {
    for (const [seed, viewer] of [['loop-a', 0], ['loop-b', 1]]) {
      const table = new FakeTable(seed, viewer);
      const advised = [];
      const act = makeAdvise({
        present: async ({ instruction, action }) => {
          advised.push(instruction.text);
          table.play(action);
        },
      });
      const result = await runTable({ table, brain: randomBrain(seed), act, memory: emptyMemory(), ...quiet });

      expect(endedProperly(result), JSON.stringify(result.refusal)).toBe(true);
      expect(result.moves).toBeGreaterThan(10);
      expect(advised).toHaveLength(result.moves);
      if (result.outcome === 'finished') {
        expect(table.state.stage).toBe('over');
        expect(resultOf(result.snapshot).result).toBe(table.state.winner === viewer ? 'win' : 'loss');
      }
    }
  });

  it('does not mind the operator playing something other than the advice', async () => {
    const table = new FakeTable('loop-contrary', 0);
    const contrary = new RandomCursor('contrary', 0);
    const act = makeAdvise({
      present: async () => {
        // Ignore the advice entirely and play any legal move.
        const view = JSON.parse(JSON.stringify(redactFor(table.viewer, table.state)));
        table.play(pick(legalActionsFromView(view, table.viewer).actions, contrary));
      },
    });
    const result = await runTable({ table, brain: randomBrain('loop-contrary'), act, memory: emptyMemory(), ...quiet });
    expect(endedProperly(result), JSON.stringify(result.refusal)).toBe(true);
  });

  it('hands memory out after every snapshot, so a restart can pick the seen cards back up', async () => {
    const table = new FakeTable('loop-memory', 0);
    const saved = [];
    const act = makeAdvise({ present: async ({ action }) => table.play(action) });
    await runTable({ table, brain: randomBrain('loop-memory'), act, memory: emptyMemory(), onMemory: (m) => saved.push(m), ...quiet });
    expect(saved.length).toBeGreaterThan(10);
    expect(Object.keys(saved.at(-1).seen).length).toBeGreaterThan(12);
  });
});

describe('runTable, stopping', () => {
  it('stops on a snapshot it cannot read, and keeps that snapshot', async () => {
    const table = new FakeTable('loop-garbled', 0);
    table.snapshot = async () => ({ not: 'a game' });
    const result = await runTable({ table, brain: randomBrain('x'), act: async () => ({ ok: true }), memory: emptyMemory(), ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('bad-snapshot');
    expect(result.raw).toEqual({ not: 'a game' });
    expect(result.moves).toBe(0);
  });

  it('stops when the table sits in a state it has no translation for', async () => {
    const table = new FakeTable('loop-unknown', 0);
    // Our turn (viewer 0 is player 1000 in the fake), in a state from the expansion.
    table.pulse = async () => ({ name: 'beforeEndTurn', active: 1000, args: 'null' });
    const result = await runTable({ table, brain: randomBrain('x'), act: async () => ({ ok: true }), memory: emptyMemory(), patienceMs: 2000, pollMs: 500, ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('unknown-state');
    expect(result.refusal.detail).toContain('beforeEndTurn');
  });

  it('stops when the strategy says it could not act, with the strategy’s reason', async () => {
    const table = new FakeTable('loop-refused', 0);
    const refusal = { reason: 'refused', detail: 'BGA said no.' };
    // Our seat may not be first to move; the opponent plays until it is, then the strategy refuses.
    const result = await runTable({ table, brain: randomBrain('loop-refused'), act: async () => ({ ok: false, refusal }), memory: emptyMemory(), ...quiet });
    expect(result).toMatchObject({ outcome: 'stopped', refusal, moves: 1 });
  });
});
