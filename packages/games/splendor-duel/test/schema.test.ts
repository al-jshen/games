import { RandomCursor } from '@games/engine';
import { describe, expect, it } from 'vitest';
import { apply } from '../src/apply.js';
import { legalActions } from '../src/legal.js';
import { actionValidator, optionsValidator } from '../src/schema.js';
import { setup } from '../src/setup.js';
import type { SplendorAction, SplendorState } from '../src/types.js';

/**
 * The gap these tests close: every other test calls the reducer directly, so none of them touch the
 * wire validator. A schema that rejected legitimate actions therefore passed the entire suite while
 * making purchases and discards impossible for any real client.
 *
 * The invariant is simple and worth stating: anything `legalActions` offers must survive a JSON
 * round trip and the action validator unchanged.
 */
describe('the wire schema accepts everything the engine offers', () => {
  it('validates every enumerated action, through a JSON round trip', () => {
    const seen = new Set<string>();
    let checked = 0;

    for (const seed of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'] as const) {
      let state: SplendorState = setup({ seed, seats: [0, 1], options: {} });
      const rng = new RandomCursor(`${seed}:pol`, 0);

      for (let step = 0; step < 300 && state.stage !== 'over'; step++) {
        const seat = state.turn;
        const { actions } = legalActions(state, seat);

        for (const action of actions) {
          seen.add(action.t);
          checked += 1;
          // Exactly what a client does: serialise, send, parse, validate.
          const overTheWire: unknown = JSON.parse(JSON.stringify(action));
          const parsed = actionValidator.validate(overTheWire);
          expect(parsed.ok, `${JSON.stringify(action)} -> ${parsed.ok ? '' : parsed.error}`).toBe(true);
          if (parsed.ok) {
            // And the validator must not quietly reshape it, or the reducer sees something else.
            expect(parsed.value).toEqual(overTheWire);
          }
        }

        const next = apply(state, seat, actions[rng.int(actions.length)]!);
        if (!next.ok) throw new Error(next.error.message);
        state = next.state;
      }
    }

    expect(checked).toBeGreaterThan(5000);
    // Every action kind that carries a payload must actually be exercised, or a broken schema for
    // one of them would slip through unnoticed.
    for (const kind of ['takeTokens', 'reserve', 'purchase', 'usePrivilege', 'replenish', 'discard'] as const) {
      expect(seen, `never exercised ${kind}`).toContain(kind);
    }
  });

  it('accepts sparse purses and rejects malformed ones', () => {
    const good: SplendorAction[] = [
      { t: 'purchase', from: { t: 'pyramid', level: 1, slot: 0 }, payment: {} },
      { t: 'purchase', from: { t: 'pyramid', level: 1, slot: 0 }, payment: { white: 2, gold: 1 } },
      { t: 'purchase', from: { t: 'reserved', cardId: 'l1-01' }, payment: { pearl: 1 }, wildColor: 'blue' },
      { t: 'discard', tokens: { gold: 1 } },
      { t: 'pass' },
    ];
    for (const action of good) {
      const parsed = actionValidator.validate(JSON.parse(JSON.stringify(action)));
      expect(parsed.ok, JSON.stringify(action)).toBe(true);
    }

    const bad: unknown[] = [
      { t: 'purchase', from: { t: 'pyramid', level: 1, slot: 0 }, payment: { purple: 1 } },
      { t: 'purchase', from: { t: 'pyramid', level: 1, slot: 0 }, payment: { white: -1 } },
      { t: 'purchase', from: { t: 'pyramid', level: 4, slot: 0 }, payment: {} },
      { t: 'discard', tokens: { white: 1.5 } },
      { t: 'takeTokens', cells: [0, 1, 2, 3] },
      { t: 'takeTokens', cells: [25] },
      { t: 'chooseSteal', color: 'gold' },
      { t: 'nonsense' },
    ];
    for (const action of bad) {
      expect(actionValidator.validate(action).ok, JSON.stringify(action)).toBe(false);
    }
  });

  it('defaults options and rejects nonsense ones', () => {
    expect(optionsValidator.validate({})).toEqual({ ok: true, value: {} });
    expect(optionsValidator.validate(undefined)).toEqual({ ok: true, value: {} });
    expect(optionsValidator.validate({ maxTurnsWithoutPurchase: 40 })).toEqual({
      ok: true,
      value: { maxTurnsWithoutPurchase: 40 },
    });
    expect(optionsValidator.validate({ maxTurnsWithoutPurchase: -1 }).ok).toBe(false);
  });
});
