import { RandomCursor } from '@games/engine';
import { describe, expect, it } from 'vitest';
import { apply } from '../src/apply.js';
import { legalActions, validate } from '../src/legal.js';
import { sampleAction } from '../src/sample.js';
import { setup } from '../src/setup.js';
import type { SplendorState } from '../src/types.js';

/**
 * The rollout sampler proposes moves instead of deriving them, so the only thing standing between it
 * and a corrupt rollout is that everything it returns is genuinely legal. A proposal that slipped
 * through would not throw — `apply` would refuse it and the rollout would quietly stop early, making
 * every evaluation downstream of it subtly wrong and nothing would say so.
 */
describe('sampleAction', () => {
  it('only ever returns moves the arbiter accepts', () => {
    const rng = new RandomCursor('sample-legal', 0);
    let checked = 0;

    for (let game = 0; game < 6; game++) {
      let state: SplendorState = setup({
        seed: `sample-${game}`,
        seats: [0, 1],
        options: { maxTurnsWithoutPurchase: 60 },
      });

      for (let move = 0; move < 120; move++) {
        const seat = state.turn;
        const legal = legalActions(state, seat).actions;
        // Ten proposals per position, so the rarer branches get exercised too.
        for (let i = 0; i < 10; i++) {
          const action = sampleAction(state, seat, rng);
          if (action === null) {
            expect(legal, 'returned nothing while a legal move existed').toHaveLength(0);
            continue;
          }
          expect(validate(state, seat, action), `move ${move}: ${JSON.stringify(action)}`).toBe(true);
          checked += 1;
        }
        if (legal.length === 0) break;
        const played = sampleAction(state, seat, rng);
        if (!played) break;
        const result = apply(state, seat, played);
        expect(result.ok, 'a sampled action was refused by apply').toBe(true);
        if (!result.ok) break;
        state = result.state;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('reaches every kind of move, not just the easy one', () => {
    /*
     * Taking a single token is always available, so a sampler that quietly fell back to it every
     * time would pass the legality test and make rollouts useless. This checks the distribution is
     * actually spread.
     */
    const rng = new RandomCursor('sample-variety', 0);
    let state: SplendorState = setup({ seed: 'variety', seats: [0, 1], options: {} });
    const kinds = new Set<string>();

    for (let move = 0; move < 160; move++) {
      const seat = state.turn;
      for (let i = 0; i < 12; i++) {
        const action = sampleAction(state, seat, rng);
        if (action) kinds.add(action.t);
      }
      const played = sampleAction(state, seat, rng);
      if (!played) break;
      const result = apply(state, seat, played);
      if (!result.ok) break;
      state = result.state;
    }

    for (const kind of ['takeTokens', 'purchase', 'reserve']) {
      expect(kinds, `never proposed a ${kind}`).toContain(kind);
    }
    // And multi-token lines, not only singles.
    expect(kinds.size).toBeGreaterThan(3);
  });
});
