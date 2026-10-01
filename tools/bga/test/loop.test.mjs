import { emptyMemory, toBgaCalls } from '@games/bga-splendor-duel';
import { RandomCursor } from '@games/engine';
import { legalActionsFromView, redactFor } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { FakeTable } from '../../../packages/bga-splendor-duel/test/support/fakeTable.ts';
import { pick } from '../../../packages/bga-splendor-duel/test/support/play.ts';
import { makeAdvise } from '../advise.mjs';
import { runTable } from '../loop.mjs';
import { makePlay } from '../play.mjs';
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

      // Each seeded game here is known to run to the end; a stop of any kind is a failure.
      expect(result.outcome, JSON.stringify(result.refusal)).toBe('finished');
      expect(result.moves).toBeGreaterThan(10);
      expect(advised).toHaveLength(result.moves);
      expect(table.state.stage).toBe('over');
      expect(resultOf(result.snapshot).result).toBe(table.state.winner === viewer ? 'win' : 'loss');
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
    expect(result.outcome, JSON.stringify(result.refusal)).toBe('finished');
    expect(result.moves).toBeGreaterThan(10);
  });

  it('hands memory out after every snapshot, so a restart can pick the seen cards back up', async () => {
    const table = new FakeTable('loop-memory', 0);
    const saved = [];
    const act = makeAdvise({ present: async ({ action }) => table.play(action) });
    const result = await runTable({ table, brain: randomBrain('loop-memory'), act, memory: emptyMemory(), onMemory: (m) => saved.push(m), ...quiet });
    expect(result.outcome, JSON.stringify(result.refusal)).toBe('finished');
    expect(result.moves).toBeGreaterThan(10);
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

describe('runTable, when the page fails', () => {
  const advising = (table) => makeAdvise({ present: async ({ action }) => table.play(action) });

  it('stops, with the error and the last snapshot, when a reload throws mid-game', async () => {
    const table = new FakeTable('loop-a', 0);
    const real = table.snapshot.bind(table);
    let calls = 0;
    let last = null;
    table.snapshot = async () => {
      calls += 1;
      if (calls === 3) throw new Error('This page did not become a Splendor Duel game within a minute.');
      last = await real();
      return last;
    };
    const result = await runTable({ table, brain: randomBrain('loop-a'), act: advising(table), memory: emptyMemory(), ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('page-error');
    expect(result.refusal.detail).toContain('did not become a Splendor Duel game');
    expect(result.raw).toEqual(last);
    // And nothing more was tried at the table after the failure.
    expect(calls).toBe(3);
  });

  it('stops the same way when a poll throws mid-game', async () => {
    const table = new FakeTable('loop-a', 0);
    const real = table.pulse.bind(table);
    table.pulse = async () => {
      if (table.pulses >= 40) throw new Error('The browser is no longer on table 1: it is on table 2.');
      return real();
    };
    const result = await runTable({ table, brain: randomBrain('loop-a'), act: advising(table), memory: emptyMemory(), ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('page-error');
    expect(result.refusal.detail).toContain('no longer on table 1');
    expect(result.raw).not.toBeNull();
    expect(result.moves).toBeGreaterThan(0);
  });

  it('names a programming error for what it is, rather than passing it off as something BGA did', async () => {
    const table = new FakeTable('loop-a', 0);
    const brain = () => {
      throw new TypeError("Cannot read properties of undefined (reading 't')");
    };
    const result = await runTable({ table, brain, act: advising(table), memory: emptyMemory(), ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('page-error');
    expect(result.refusal.detail).toContain("TypeError: Cannot read properties of undefined (reading 't')");
    expect(result.moves).toBe(0);
  });
});

describe('runTable, playing', () => {
  it('plays a whole game through BGA’s own calls, from either seat', async () => {
    for (const [seed, viewer] of [['play-a', 0], ['play-b', 1]]) {
      const table = new FakeTable(seed, viewer);
      const said = [];
      const act = makePlay({ perform: (call) => table.perform(call), say: (line) => said.push(line) });
      const result = await runTable({ table, brain: randomBrain(seed), act, memory: emptyMemory(), ...quiet });

      expect(result.outcome, JSON.stringify(result.refusal)).toBe('finished');
      expect(result.moves).toBeGreaterThan(10);
      expect(said).toHaveLength(result.moves);
      expect(table.state.stage).toBe('over');
    }
  });

  it('stops, and says what BGA said, when a call is refused', async () => {
    const table = new FakeTable('play-refused', 0);
    const act = makePlay({
      perform: async () => {
        throw new Error('This move is not authorized now');
      },
      say: () => {},
    });
    const result = await runTable({ table, brain: randomBrain('play-refused'), act, memory: emptyMemory(), ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('refused');
    expect(result.refusal.detail).toContain('This move is not authorized now');
    expect(result.moves).toBe(1);
  });

  const reserveFirst = (view, seat) => {
    const { actions } = legalActionsFromView(view, seat);
    return { action: actions.find((a) => a.t === 'reserve') ?? actions[0], value: 0 };
  };

  it('stops, instead of waiting for ever, when the table rests in the middle of one of our actions', async () => {
    const table = new FakeTable('play-stuck', 0);
    // A strategy whose first call lands and whose second never happens -- the page swallowed it --
    // and which then reports success: the table sits in `reserveCard` with nothing more to come.
    const act = async ({ action, view, at }) => {
      const plan = toBgaCalls(action, view, at);
      await table.perform(plan.calls[0]);
      return { ok: true };
    };
    const result = await runTable({ table, brain: reserveFirst, act, memory: emptyMemory(), pollMs: 500, midActionPatienceMs: 2000, ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('mid-action');
    expect(result.refusal.detail).toContain('reserveCard');
    expect(result.moves).toBe(1);
    // Well short of the fake's 20,000-pulse cap, which is where this used to end.
    expect(table.pulses).toBeLessThan(100);
  });

  it('stops when the page accepts the second call of a move and nothing happens', async () => {
    const table = new FakeTable('play-stuck', 0);
    // BGA's `performAction` returns `undefined` rather than rejecting when its own check blocks a call.
    const perform = async (call) => (call.name === 'actReserveCard' ? undefined : table.perform(call));
    const act = makePlay({ perform, say: () => {}, actTimeoutMs: 1000 });
    const result = await runTable({ table, brain: reserveFirst, act, memory: emptyMemory(), pollMs: 500, midActionPatienceMs: 30_000, ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('refused');
    expect(result.refusal.detail).toMatch(/accepted actReserveCard, but the table did not change/);
    expect(result.moves).toBe(1);
    expect(table.pulses).toBeLessThan(100);
  });

  it('stops after one move, and searches no more, when a one-call move changes nothing', async () => {
    const table = new FakeTable('play-silent', 0);
    let searches = 0;
    const takeTokens = (view, seat) => {
      searches += 1;
      const { actions } = legalActionsFromView(view, seat);
      return { action: actions.find((a) => a.t === 'takeTokens') ?? actions[0], value: 0 };
    };
    const act = makePlay({ perform: async () => undefined, say: () => {}, actTimeoutMs: 1000 });
    const result = await runTable({ table, brain: takeTokens, act, memory: emptyMemory(), pollMs: 500, ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('refused');
    expect(result.refusal.detail).toMatch(/accepted actTakeTokens, but the table did not change/);
    expect(result.moves).toBe(1);
    expect(searches).toBe(1);
  });

  it('stops when the table never reaches the state the second call needs', async () => {
    const table = new FakeTable('play-stuck', 0);
    // Accept every call and change nothing: the table never moves into `reserveCard` or the like.
    const act = makePlay({ perform: async () => {}, say: () => {}, actTimeoutMs: 1000 });
    const twoStep = (view, seat) => {
      const { actions } = legalActionsFromView(view, seat);
      return { action: actions.find((a) => a.t === 'reserve') ?? actions[0], value: 0 };
    };
    const result = await runTable({ table, brain: twoStep, act, memory: emptyMemory(), pollMs: 500, ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('refused');
    expect(result.refusal.detail).toMatch(/After actTakeTokens, the table did not reach "reserveCard"/);
    expect(result.moves).toBe(1);
  });
});
