import { legalActionsFromView, redactFor, setup } from '@games/splendor-duel';
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
});
