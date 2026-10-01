import { RandomCursor } from '@games/engine';
import { apply, legalActions, setup, type SplendorAction } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { locate } from '../src/locate.js';
import { emptyMemory, remember } from '../src/memory.js';
import { parseSnapshot } from '../src/snapshot.js';
import { toBgaCalls } from '../src/toBgaCalls.js';
import { toView } from '../src/toView.js';
import { FakeTable } from './support/fakeTable.js';
import { pick } from './support/play.js';
import { bgaCardId, boardTokenId, snap } from './support/synth.js';

/**
 * In `play` mode these calls are the bot's hands. The property that matters is not that each call
 * looks right but that sending them does to the table exactly what the action does to our engine --
 * same tokens, same card, same payment, and nothing else.
 */

/** The kinds of move whose calls differ: a wild purchase has a second call, a deck reservation names the deck. */
function kindOf(action: SplendorAction): string {
  if (action.t === 'purchase' && action.wildColor) return 'purchase-wild';
  if (action.t === 'reserve' && action.from.t === 'deck') return 'reserve-deck';
  return action.t;
}

describe('toBgaCalls', () => {
  const opening = setup({ seed: 'calls', seats: [0, 1], options: {} });
  const mover = opening.turn as 0 | 1;
  const plan = (action: SplendorAction) => {
    const snapshot = snap(opening, mover);
    const result = toView(snapshot, remember(emptyMemory(), snapshot));
    if (!result.ok) throw new Error(result.refusal.detail);
    return toBgaCalls(action, result.view, locate(snapshot));
  };
  const legal = legalActions(opening, mover).actions;

  it('takes tokens by their ids, sorted, comma-joined, as the page itself sends them', () => {
    const take = legal.find((a) => a.t === 'takeTokens' && a.cells.length === 3) as Extract<SplendorAction, { t: 'takeTokens' }>;
    const ids = take.cells.map(boardTokenId).sort((a, b) => a - b).join(',');
    expect(plan(take)).toEqual({ ok: true, calls: [{ name: 'actTakeTokens', args: { ids } }] });
  });

  it('reserves in two calls, and waits for the table to ask for the card in between', () => {
    const reserve = legal.find((a) => a.t === 'reserve' && a.from.t === 'pyramid') as Extract<SplendorAction, { t: 'reserve' }>;
    if (reserve.from.t !== 'pyramid') throw new Error('unreachable');
    const cardId = opening.pyramid[reserve.from.level][reserve.from.slot] as string;
    expect(plan(reserve)).toEqual({
      ok: true,
      calls: [
        { name: 'actTakeTokens', args: { ids: String(boardTokenId(reserve.goldCell)) }, then: 'reserveCard' },
        { name: 'actReserveCard', args: { id: bgaCardId(cardId) } },
      ],
    });
  });

  it('has no calls for a pass', () => {
    const result = plan({ t: 'pass' });
    expect(result.ok).toBe(false);
  });

  it('does to a table exactly what the action does to the engine, for every kind of move in a game', async () => {
    const kinds = new Set<string>();
    let performed = 0;
    for (const seed of ['calls-a', 'calls-b']) {
      const table = new FakeTable(seed, 0);
      const rng = new RandomCursor(`${seed}:moves`, 0);
      let memory = emptyMemory();
      for (let i = 0; i < 500 && table.state.stage !== 'over'; i++) {
        const seat = table.state.turn as 0 | 1;
        const action = pick(legalActions(table.state, seat).actions, rng);
        if (seat !== 0 || action.t === 'pass') {
          table.force(seat, action);
          continue;
        }

        const parsed = parseSnapshot(await table.snapshot());
        if (!parsed.ok) throw new Error(parsed.refusal.detail);
        memory = remember(memory, parsed.snapshot);
        const translated = toView(parsed.snapshot, memory);
        if (!translated.ok) throw new Error(translated.refusal.detail);

        const expected = apply(table.state, 0, action);
        if (!expected.ok) throw new Error(expected.error.message);

        const calls = toBgaCalls(action, translated.view, locate(parsed.snapshot));
        expect(calls.ok, calls.ok ? '' : calls.refusal.detail).toBe(true);
        if (!calls.ok) return;
        for (const call of calls.calls) {
          await table.perform(call);
          // `then` names the state the page must be in before the next call. The fake must agree.
          if (call.then) expect((await table.pulse()).name).toBe(call.then);
        }
        expect(table.state).toEqual(expected.state);
        kinds.add(kindOf(action));
        performed += 1;
      }
    }
    expect(performed).toBeGreaterThan(100);
    for (const kind of [
      'takeTokens',
      'usePrivilege',
      'replenish',
      'reserve',
      'reserve-deck',
      'purchase',
      'purchase-wild',
      'chooseMatchingToken',
      'chooseSteal',
      'chooseRoyal',
      'discard',
    ]) {
      expect(kinds.has(kind), `no ${kind} was performed; add a seed`).toBe(true);
    }
  });
});
