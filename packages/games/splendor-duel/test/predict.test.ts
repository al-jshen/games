import { RandomCursor, unseal } from '@games/engine';
import { describe, expect, it } from 'vitest';
import { apply } from '../src/apply.js';
import { legalActions } from '../src/legal.js';
import { applyToView, legalActionsFromView } from '../src/predict.js';
import { redactFor } from '../src/redact.js';
import { setup } from '../src/setup.js';
import type { SplendorAction, SplendorState } from '../src/types.js';

function newGame(seed: string): SplendorState {
  return setup({ seed, seats: [0, 1], options: {} });
}

/**
 * Prediction is only worth having if it is *exact*. Anything the client renders optimistically has
 * to match what the server will send, or the board visibly corrects itself and players stop
 * trusting it.
 */
describe('client-side prediction', () => {
  it('exactly matches the server for every action it claims to predict', () => {
    let checked = 0;
    let exact = 0;

    for (const seed of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      let state = newGame(seed);
      const rng = new RandomCursor(`${seed}:pol`, 0);

      for (let step = 0; step < 160 && state.stage !== 'over'; step++) {
        const seat = state.turn;
        const view = unseal(redactFor(seat, state));
        const { actions } = legalActions(state, seat);

        for (const action of actions) {
          const predicted = applyToView(view, seat, action);
          if (!predicted.ok) continue; // Honestly declined (replenish / deck reservation).
          checked += 1;

          const server = apply(state, seat, action);
          expect(server.ok, JSON.stringify(action)).toBe(true);
          if (!server.ok) continue;
          const truth = unseal(redactFor(seat, server.state));

          if (predicted.unresolved) {
            // A pyramid slot is awaiting a reveal, so only that slot may differ. Everything the
            // client claimed to know must still be right.
            expect({ ...predicted.state, pyramid: null }, JSON.stringify(action)).toEqual({
              ...truth,
              pyramid: null,
            });
          } else {
            exact += 1;
            expect(predicted.state, JSON.stringify(action)).toEqual(truth);
          }
        }

        const chosen = actions[rng.int(actions.length)]!;
        const next = apply(state, seat, chosen);
        if (!next.ok) throw new Error(next.error.message);
        state = next.state;
      }
    }

    // Sanity: the test is actually exercising both paths, not silently skipping everything.
    expect(checked).toBeGreaterThan(2000);
    expect(exact).toBeGreaterThan(1000);
  });

  it('declines to predict the two actions that hinge on hidden information', () => {
    // Give the bag something to hold so replenish becomes legal.
    const base = newGame('unpredictable');
    const state: SplendorState = JSON.parse(JSON.stringify(base));
    state.bag = ['white', 'blue'];
    state.board[0] = null;
    state.board[1] = null;

    const view = unseal(redactFor(state.turn, state));

    const replenish: SplendorAction = { t: 'replenish' };
    expect(applyToView(view, state.turn, replenish).ok).toBe(false);

    // Find a gold token to make a deck reservation legal.
    const goldCell = state.board.indexOf('gold');
    if (goldCell >= 0) {
      const fromDeck: SplendorAction = { t: 'reserve', goldCell, from: { t: 'deck', level: 1 } };
      expect(applyToView(view, state.turn, fromDeck).ok).toBe(false);
    }
  });

  it('offers a bot the same actions from a view as the server does from truth', () => {
    for (const seed of ['v1', 'v2', 'v3']) {
      let state = newGame(seed);
      const rng = new RandomCursor(`${seed}:pol`, 0);

      for (let step = 0; step < 120 && state.stage !== 'over'; step++) {
        const seat = state.turn;
        const view = unseal(redactFor(seat, state));
        const truth = legalActions(state, seat).actions;
        const fromView = legalActionsFromView(view, seat).actions;

        const key = (a: SplendorAction) => JSON.stringify(a);
        expect(new Set(fromView.map(key))).toEqual(new Set(truth.map(key)));

        const next = apply(state, seat, truth[rng.int(truth.length)]!);
        if (!next.ok) throw new Error(next.error.message);
        state = next.state;
      }
    }
  });
});
