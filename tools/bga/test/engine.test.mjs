import { apply, legalActions, legalActionsFromView, redactFor, setup } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { loadPublished, makeBrain } from '../engine.mjs';
import { PUBLISHED } from '../paths.mjs';

describe('the engine the adapter plays with', () => {
  it('is the published checkpoint, and picks a legal move from a real view', () => {
    const engine = loadPublished(PUBLISHED);
    expect(engine.generation).toBeGreaterThan(0);
    expect(engine.deps.priors).toBeDefined();

    const state = setup({ seed: 'bga-engine', seats: [0, 1], options: {} });
    const seat = state.turn;
    const view = JSON.parse(JSON.stringify(redactFor(seat, state)));
    const { action, value } = makeBrain(engine, 60, 'test')(view, seat, 0);

    const legal = legalActionsFromView(view, seat).actions.map((a) => JSON.stringify(a));
    expect(legal).toContain(JSON.stringify(action));
    expect(value).toBeGreaterThanOrEqual(-1);
    expect(value).toBeLessThanOrEqual(1);
  });

  it('picks a legal move mid-turn, from a view with a slot BGA has not refilled yet', () => {
    const engine = loadPublished(PUBLISHED);
    // Play until a purchase from the table leaves a decision in the same turn.
    let state = setup({ seed: 'bga-engine-midturn', seats: [0, 1], options: {} });
    let view = null;
    for (let i = 0; i < 400 && !view && state.stage !== 'over'; i++) {
      const seat = state.turn;
      const actions = legalActions(state, seat).actions;
      const buy = actions.find((a) => a.t === 'purchase' && a.from.t === 'pyramid');
      const action = buy ?? actions[i % actions.length];
      const next = apply(state, seat, action);
      if (!next.ok) throw new Error(next.error.message);
      if (buy && next.state.turn === seat && next.state.pending && next.state.pyramid[buy.from.level][buy.from.slot] !== null) {
        // As BGA shows it: the slot empty, and the card that will fill it back on its deck.
        view = JSON.parse(JSON.stringify(redactFor(seat, next.state)));
        view.pyramid[buy.from.level][buy.from.slot] = null;
        view.decks[buy.from.level] += 1;
      }
      state = next.state;
    }
    if (!view) throw new Error('no purchase from the table led to a decision in the same turn; change the seed');

    const seat = view.turn;
    const { action } = makeBrain(engine, 60, 'test-midturn')(view, seat, 0);
    const legal = legalActionsFromView(view, seat).actions.map((a) => JSON.stringify(a));
    expect(legal).toContain(JSON.stringify(action));
  });
});
