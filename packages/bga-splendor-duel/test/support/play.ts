import { RandomCursor } from '@games/engine';
import { apply, legalActions, setup, type SplendorAction, type SplendorState } from '@games/splendor-duel';

/**
 * A move for a random game that still gets somewhere.
 *
 * Uniformly random Splendor Duel is mostly token-shuffling: purchases are a small share of the legal
 * moves, so a uniform walk rarely reaches the states that matter here — an ability to resolve, a
 * royal to claim, a discard. Preferring a purchase when one exists gets a game through all of them
 * in a couple of hundred moves.
 */
export function pick(actions: SplendorAction[], rng: RandomCursor): SplendorAction {
  const buys = actions.filter((a) => a.t === 'purchase');
  const pool = buys.length > 0 && rng.int(10) < 6 ? buys : actions;
  return pool[rng.int(pool.length)] as SplendorAction;
}

/**
 * Play a seeded game, calling `visit` on the opening position and after every single action.
 *
 * `before` is the position this turn's mandatory action was taken from -- the last position of the
 * turn at stage `optional` -- and is `undefined` when the position is itself at that stage. Pass it
 * on to `snap`/`synthSnapshot` so that mid-turn snapshots are shaped as BGA sends them.
 */
export function walk(
  seed: string,
  moves: number,
  visit: (state: SplendorState, before: SplendorState | undefined) => void,
): void {
  let state = setup({ seed, seats: [0, 1], options: {} });
  let start = state;
  const rng = new RandomCursor(`${seed}:play`, 0);
  visit(state, undefined);
  for (let i = 0; i < moves && state.stage !== 'over'; i++) {
    const seat = state.turn;
    const { actions } = legalActions(state, seat);
    const result = apply(state, seat, pick(actions, rng));
    if (!result.ok) throw new Error(`walk: ${result.error.message}`);
    state = result.state;
    if (state.stage === 'optional') start = state;
    visit(state, state.stage === 'optional' ? undefined : start);
  }
}
