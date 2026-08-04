import { unseal } from '@games/engine';
import { apply, legalActions, redactFor, setup } from '@games/splendor-duel';
import type { SplendorState, SplendorView } from '@games/splendor-duel';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SplendorDuelBoard from '@games/splendor-duel/ui';
import TicTacToeBoard from '@games/tic-tac-toe/ui';
import { describeEffect, describeTurn } from '../../../packages/games/splendor-duel/src/ui/Guide.tsx';
import { CardView } from '../../../packages/games/splendor-duel/src/ui/Card.tsx';
import { fullMoveTime, isRealTimestamp, moveTimeLabel } from '../src/time.js';

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

describe('the move log', () => {
  /**
   * Log lines are written in the voice of the player the line is attributed to. Most effects happen
   * to that player, but not all of them, and getting the subject wrong turns the log into a record
   * of things that did not happen.
   */
  it('credits the scroll from a replenish to the opponent, not to whoever replenished', () => {
    let found: { actor: 0 | 1; effects: Record<string, unknown>[] } | null = null;
    for (const state of statesAlongAGame('replenish-log', 200)) {
      const replenish = legalActions(state, state.turn).actions.find((a) => a.t === 'replenish');
      if (!replenish) continue;
      const result = apply(state, state.turn, replenish);
      if (!result.ok) continue;
      found = { actor: state.turn, effects: result.effects as unknown as Record<string, unknown>[] };
      break;
    }
    expect(found, 'no replenish came up to test').not.toBeNull();

    const lines = found!.effects.map((effect) => describeEffect(effect, found!.actor));
    expect(lines).toContain('opponent gained a scroll');
    // The bug this replaces: the same effect read as though the mover had gained it.
    expect(lines).not.toContain('gained a scroll');
  });

  it('pluralises the replenish count instead of hedging with "token(s)"', () => {
    expect(describeEffect({ k: 'replenished', placed: [1] }, 0)).toBe('replenished 1 token');
    expect(describeEffect({ k: 'replenished', placed: [1, 2, 3] }, 0)).toBe('replenished 3 tokens');
  });

  it('says who ended up with a scroll in each of the ways one changes hands', () => {
    const line = (effect: Record<string, unknown>, actor: number) => describeEffect(effect, actor);
    // A card ability granting the mover a scroll from the pool.
    expect(line({ k: 'privilegeGranted', seat: 0, from: 'pool' }, 0)).toBe('gained a scroll');
    // A replenish: the other player gets it.
    expect(line({ k: 'privilegeGranted', seat: 1, from: 'pool' }, 0)).toBe('opponent gained a scroll');
    // The pool was empty, so it came off the other player.
    expect(line({ k: 'privilegeGranted', seat: 0, from: 'opponent' }, 0)).toBe('took a scroll from the opponent');
    expect(line({ k: 'privilegeGranted', seat: 1, from: 'opponent' }, 0)).toBe('opponent took a scroll back');
    // All three were already held, so nothing happened and there is nothing to say.
    expect(line({ k: 'privilegeGranted', seat: 0, from: 'none' }, 0)).toBe('');
  });
});

describe('card tooltips', () => {
  // l1-27 costs 4 white + 1 pearl. Three published datasets get this card wrong, so it doubles as a
  // check that the tooltip is reading real card data.
  it('shows the printed cost alongside what the card costs you', () => {
    const discounted = renderToStaticMarkup(<CardView cardId="l1-27" effectiveCost={{ white: 1, pearl: 1 }} />);
    expect(discounted).toContain('cost 1 white, 1 pearl');
    // Without this, "1 white" tells you nothing about whether your tableau is doing any work.
    expect(discounted).toContain('printed cost 4 white, 1 pearl');
  });

  it('does not claim a discount where there is none', () => {
    const plain = renderToStaticMarkup(<CardView cardId="l1-27" />);
    expect(plain).toContain('cost 4 white, 1 pearl');
    expect(plain).not.toContain('printed cost');
  });

  it('distinguishes a card that is free from one your bonuses have made free', () => {
    const earned = renderToStaticMarkup(<CardView cardId="l1-27" effectiveCost={{}} />);
    expect(earned).toContain('free with your bonuses');
    expect(earned).toContain('printed cost 4 white, 1 pearl');
  });
});

describe('move timestamps', () => {
  const at = new Date(2026, 7, 2, 14, 7, 42).getTime();

  it('shows seconds, so moves made in the same minute stay in order', () => {
    const label = moveTimeLabel(at, new Date(2026, 7, 2, 18, 0, 0));
    // Locale-dependent formatting, so match the shape rather than an exact string: some locales
    // write 14:07:42 and some 2:07:42 PM, and both are correct for the reader who sees them.
    expect(label).toMatch(/\b\d{1,2}:07:42\b/);
  });

  it('leaves seconds off a chat line, where the column is narrow and order is obvious', () => {
    const label = moveTimeLabel(at, new Date(2026, 7, 2, 18, 0, 0), false);
    expect(label).toMatch(/\b\d{1,2}:07\b/);
    expect(label).not.toMatch(/:42/);
  });

  it('shows the date instead once the move is not from today', () => {
    const label = moveTimeLabel(at, new Date(2026, 7, 9, 10, 0, 0));
    expect(label).not.toMatch(/:\d{2}/);
    expect(label).toMatch(/2|Aug/);
  });

  it('puts the whole moment, to the second, in the tooltip', () => {
    expect(fullMoveTime(at)).toMatch(/42/);
  });

  it('treats a missing or nonsense timestamp as nothing to show', () => {
    expect(isRealTimestamp(at)).toBe(true);
    expect(isRealTimestamp(0)).toBe(false);
    expect(isRealTimestamp(Number.NaN)).toBe(false);
    expect(isRealTimestamp(undefined as unknown as number)).toBe(false);
  });
});
