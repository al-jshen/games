import { unseal } from '@games/engine';
import { apply, legalActions, redactFor, setup } from '@games/splendor-duel';
import type { SplendorState, SplendorView } from '@games/splendor-duel';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SplendorDuelBoard from '@games/splendor-duel/ui';
import TicTacToeBoard from '@games/tic-tac-toe/ui';
import { describeTurn } from '../../../packages/games/splendor-duel/src/ui/Guide.tsx';

/**
 * Render the boards against real redacted views.
 *
 * These are cheap and they catch the entire class of "the board threw and the room went blank",
 * which is otherwise only discoverable by clicking through the app. They also assert the thing
 * automated tests are uniquely good at here: that nothing secret ends up in the markup.
 */

function view(state: SplendorState, seat: 0 | 1): SplendorView {
  return unseal(redactFor(seat, state));
}

/** Walk a match forward so later states (purchases, royals, pending decisions) get rendered too. */
function statesAlongAGame(seed: string, steps: number): SplendorState[] {
  let state = setup({ seed, seats: [0, 1], options: {} });
  const out: SplendorState[] = [state];
  let counter = 0;
  for (let i = 0; i < steps && state.stage !== 'over'; i++) {
    const { actions } = legalActions(state, state.turn);
    if (actions.length === 0) break;
    // Deterministic but varied: no Math.random, so a failure is reproducible.
    counter = (counter * 31 + 17) % 9973;
    const next = apply(state, state.turn, actions[counter % actions.length]!);
    if (!next.ok) break;
    state = next.state;
    out.push(state);
  }
  return out;
}

describe('Splendor Duel board renders', () => {
  const states = statesAlongAGame('render', 140);

  it('walked far enough to be a real test', () => {
    expect(states.length).toBeGreaterThan(100);
    // Confirm the walk actually reached interesting states, not just the opening.
    expect(states.some((s) => s.players.some((p) => p.stacks.length > 0))).toBe(true);
    expect(states.some((s) => s.pending !== null)).toBe(true);
  });

  it('renders every state for both seats without throwing', () => {
    for (const [index, state] of states.entries()) {
      for (const seat of [0, 1] as const) {
        const markup = renderToStaticMarkup(
          <SplendorDuelBoard
            view={view(state, seat)}
            seat={seat}
            actors={state.stage === 'over' ? [] : [state.turn]}
            submit={() => undefined}
            pending={false}
          />,
        );
        expect(markup.length, `state ${index} seat ${seat}`).toBeGreaterThan(500);
      }
    }
  });

  it('never puts the seed, deck order or a hidden card into the markup', () => {
    const withSecrets: SplendorState = JSON.parse(JSON.stringify(states[40]!));
    withSecrets.seed = 'SEED-SENTINEL-VALUE';
    withSecrets.players[1].reserved = [{ cardId: 'l3-13', publiclyKnown: false }];

    const markup = renderToStaticMarkup(
      <SplendorDuelBoard
        view={view(withSecrets, 0)}
        seat={0}
        actors={[withSecrets.turn]}
        submit={() => undefined}
        pending={false}
      />,
    );
    expect(markup).not.toContain('SEED-SENTINEL-VALUE');
    // The opponent's deck-drawn reservation must not be named anywhere in the DOM.
    expect(markup).not.toContain('l3-13');
    // ...but its slot is still shown, because holding three blocks further reservations.
    expect(markup).toContain('sd-facedown');
  });

  it('shows how full the bag is without showing what is in it', () => {
    // Pick a state well into the game, so the bag has actually been filled by spending.
    const state = states.find((s) => s.bag.length >= 4) ?? states[states.length - 1]!;
    const markup = renderToStaticMarkup(
      <SplendorDuelBoard
        view={view(state, 0)}
        seat={0}
        actors={[state.turn]}
        submit={() => undefined}
        pending={false}
      />,
    );

    expect(markup).toContain('sd-bag-number');
    /*
     * Replenish draws blind, so the bag's composition is worth knowing and is meant to be tracked
     * rather than read off. It is reconstructible from the board and both players' tokens, so this
     * is not a secret being protected -- it is the arithmetic staying the player's job.
     */
    expect(markup, 'the per-colour breakdown must not come back').not.toContain('sd-bag-gems');
    expect(markup).not.toContain('in the bag');
  });

  it('shows the empty-slot placeholder rather than crashing on an unrevealed card', () => {
    // What an optimistic prediction produces: a pyramid slot awaiting a reveal from the server.
    const predicted = JSON.parse(JSON.stringify(view(states[0]!, 0))) as SplendorView;
    predicted.pyramid[1][0] = '__unknown__';
    const markup = renderToStaticMarkup(
      <SplendorDuelBoard view={predicted} seat={0} actors={[predicted.turn]} submit={() => undefined} pending />,
    );
    expect(markup).toContain('dealing');
  });

  it('handles a null view and a spectator-less seat gracefully', () => {
    expect(
      renderToStaticMarkup(
        <SplendorDuelBoard view={null} seat={null} actors={[]} submit={() => undefined} pending={false} />,
      ),
    ).toContain('Waiting for the board');
  });
});

describe('the turn guide', () => {
  it('describes something actionable whenever it is your turn', () => {
    for (const state of statesAlongAGame('guide', 120)) {
      if (state.stage === 'over') continue;
      const seat = state.turn as 0 | 1;
      const v = view(state, seat);
      const suggestions = describeTurn(v, seat, legalActions(state, seat).actions);
      expect(suggestions.length, `no guidance at version with stage ${state.stage}`).toBeGreaterThan(0);
      for (const suggestion of suggestions) {
        expect(suggestion.title.length).toBeGreaterThan(3);
        expect(suggestion.detail.length).toBeGreaterThan(10);
      }
    }
  });

  it('leads with the pending decision, and only that, when one is outstanding', () => {
    const state = statesAlongAGame('guide-pending', 200).find((s) => s.pending !== null);
    expect(state).toBeDefined();
    if (!state) return;
    const seat = state.turn as 0 | 1;
    const suggestions = describeTurn(view(state, seat), seat, legalActions(state, seat).actions);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.urgent).toBe(true);
  });
});

describe('tic-tac-toe board renders', () => {
  it('renders an empty grid for the player to move', () => {
    const markup = renderToStaticMarkup(
      <TicTacToeBoard
        view={{ v: 1, you: 0, board: new Array(9).fill(null), turn: 0, winner: null, draw: false, moves: 0 }}
        seat={0}
        actors={[0]}
        submit={() => undefined}
        pending={false}
      />,
    );
    expect(markup).toContain('ttt-grid');
    expect(markup).toContain('Your move');
  });
});
