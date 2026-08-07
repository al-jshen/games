import { RandomCursor, unseal, type Seat } from '@games/engine';
import ticTacToe from '@games/tic-tac-toe';
import type { TicTacToeAction, TicTacToeState, TicTacToeView } from '@games/tic-tac-toe';
import { describe, expect, it } from 'vitest';
import { BASELINE, withConfig, type SearchConfig } from '../src/config.js';
import { search, type SearchDeps } from '../src/search.js';

/**
 * The search, checked against a game whose answers are already known.
 *
 * Splendor Duel cannot tell you whether your search is correct — you have no reference to compare
 * against, and a subtly broken search still produces plausible-looking moves and still beats a random
 * bot. Tic-tac-toe can: perfect play never loses, and every "must win now" and "must block now" has
 * exactly one right answer. If the search fails here, no amount of tuning against Splendor will
 * reveal why.
 *
 * Being a perfect-information game, determinizing is the identity — which also means these tests
 * exercise the tree, the backups and the exploration term in isolation, without the sampling.
 */

type Deps = SearchDeps<TicTacToeState, TicTacToeAction, TicTacToeView, Record<string, never>>;

const mod = ticTacToe as unknown as Deps['mod'];

const deps: Deps = {
  mod,
  // Nothing is hidden, so the "sampled world" is just the position itself.
  determinize: (view) => JSON.parse(JSON.stringify(view)) as TicTacToeState,
  // No domain knowledge at all: a drawn-looking position is worth zero. Everything the search knows
  // it has to find for itself, which is the point.
  evaluate: () => 0,
};

const viewFor = (state: TicTacToeState, seat: Seat): TicTacToeView =>
  JSON.parse(JSON.stringify(unseal(mod.redactFor(seat, state)))) as TicTacToeView;

function fresh(): TicTacToeState {
  return mod.setup({ seed: 'oracle', seats: [0, 1], options: {} });
}

function play(state: TicTacToeState, seat: Seat, cell: number): TicTacToeState {
  const result = mod.apply(state, seat, { t: 'place', cell } as TicTacToeAction);
  if (!result.ok) throw new Error(`illegal setup move at ${cell}: ${result.error.message}`);
  return result.state;
}

/**
 * Exact minimax. Tic-tac-toe has a few thousand reachable positions, so this is instant and needs no
 * memo — and it makes the test independent of my own tic-tac-toe theory, which is the point. An
 * earlier version of this file asserted "every sane reply here is a corner" and was simply wrong.
 */
function value(state: TicTacToeState, seat: Seat): number {
  const outcome = mod.outcome(state);
  if (outcome.status === 'over') {
    if (outcome.winners.length === 0) return 0;
    return outcome.winners.includes(seat) ? 1 : -1;
  }
  const actor = mod.currentActors(state)[0] as Seat;
  const scores = mod.legalActions(state, actor).actions.map((action) => {
    const next = mod.apply(state, actor, action);
    if (!next.ok) throw new Error('solver: legal action rejected');
    return value(next.state, seat);
  });
  return actor === seat ? Math.max(...scores) : Math.min(...scores);
}

/** Every move that preserves the best achievable result for `seat`. */
function optimalCells(state: TicTacToeState, seat: Seat): number[] {
  const scored = mod.legalActions(state, seat).actions.map((action) => {
    const next = mod.apply(state, seat, action);
    if (!next.ok) throw new Error('solver: legal action rejected');
    return { cell: (action as unknown as { cell: number }).cell, value: value(next.state, seat) };
  });
  const best = Math.max(...scored.map((s) => s.value));
  return scored.filter((s) => s.value === best).map((s) => s.cell);
}

function pick(state: TicTacToeState, seat: Seat, config: Partial<SearchConfig> = {}): number {
  const chosen = search(deps, viewFor(state, seat), seat, withConfig({ iterations: 600, ...config })).action;
  return (chosen as { cell: number }).cell;
}

/** The search's own estimate of a position, in [-1, 1] from `seat`'s point of view. */
function rootValueOf(state: TicTacToeState, seat: Seat): number {
  return search(deps, viewFor(state, seat), seat, withConfig({ iterations: 600 })).rootValue;
}

describe('the search, against a game with known answers', () => {
  it('takes a win when one is on offer', () => {
    // X on 0 and 1; 2 completes the top row. Anything else throws the game away.
    let state = fresh();
    state = play(state, 0, 0);
    state = play(state, 1, 4);
    state = play(state, 0, 1);
    state = play(state, 1, 5);
    expect(pick(state, 0)).toBe(2);
  });

  it('reports a root value that knows who is winning', () => {
    /*
     * The root value is recorded as a training target, so it has to mean what it says. A blend that
     * leaned on a number with the wrong sign would poison every position in the dataset, and nothing
     * downstream would flag it -- the loss would fall perfectly well against a wrong target.
     */
    let won = fresh();
    won = play(won, 0, 0);
    won = play(won, 1, 4);
    won = play(won, 0, 1);
    won = play(won, 1, 5);
    // X to move with 2 completing the top row.
    const winning = rootValueOf(won, 0);
    expect(winning).toBeGreaterThan(0.5);
    expect(winning).toBeLessThanOrEqual(1);

    // The same position from the other chair: about to be beaten, and it should say so.
    let lost = fresh();
    lost = play(lost, 0, 0);
    lost = play(lost, 1, 4);
    lost = play(lost, 0, 1);
    // O to move, and only one move survives, so most of the tree is losing.
    expect(rootValueOf(lost, 1)).toBeLessThan(winning);
  });

  it('blocks a loss when one is threatened', () => {
    // X threatens the top row; O has nothing better to do than stop it.
    let state = fresh();
    state = play(state, 0, 0);
    state = play(state, 1, 4);
    state = play(state, 0, 1);
    expect(pick(state, 1)).toBe(2);
  });

  it('plays a move the solver agrees is optimal, across a spread of positions', () => {
    /*
     * Checked against exact minimax rather than against my judgement. "Optimal" means preserving the
     * best result available — often several moves qualify, and the search only has to choose one of
     * them.
     */
    const rng = new RandomCursor('spread', 0);
    let checked = 0;
    for (let game = 0; game < 8; game++) {
      let state = fresh();
      // Walk a few random plies in, then ask.
      const plies = rng.int(5);
      for (let i = 0; i < plies && mod.outcome(state).status !== 'over'; i++) {
        const seat = mod.currentActors(state)[0] as Seat;
        const { actions } = mod.legalActions(state, seat);
        state = play(state, seat, (actions[rng.int(actions.length)] as { cell: number }).cell);
      }
      if (mod.outcome(state).status === 'over') continue;
      const seat = mod.currentActors(state)[0] as Seat;
      const best = optimalCells(state, seat);
      expect(best, `game ${game}: solver found no move`).not.toHaveLength(0);
      expect(best, `game ${game}`).toContain(pick(state, seat, { iterations: 1200, seed: `spread:${game}` }));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(4);
  });

  it('never loses to itself, from either seat', () => {
    /*
     * The strongest statement available here. Tic-tac-toe is a draw under perfect play, so a search
     * that plays both sides and ever produces a winner has a real defect — and it is a defect that
     * a Splendor win-rate would happily hide.
     */
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      let state = fresh();
      for (let ply = 0; ply < 9; ply++) {
        if (mod.outcome(state).status === 'over') break;
        const seat = mod.currentActors(state)[0] as Seat;
        const cell = pick(state, seat, { seed: `${seed}:${ply}`, iterations: 500 });
        state = play(state, seat, cell);
      }
      const outcome = mod.outcome(state);
      expect(outcome.status).toBe('over');
      expect(outcome.status === 'over' && outcome.winners, `seed ${seed} produced a winner`).toEqual([]);
    }
  });

  it('never loses to a random opponent either', () => {
    // A weaker bar than self-play, but it catches a search that only looks sane in symmetric lines.
    const rng = new RandomCursor('random-opponent', 0);
    for (let game = 0; game < 12; game++) {
      const botSeat: Seat = game % 2 === 0 ? 0 : 1;
      let state = fresh();
      while (mod.outcome(state).status !== 'over') {
        const seat = mod.currentActors(state)[0] as Seat;
        if (seat === botSeat) {
          state = play(state, seat, pick(state, seat, { seed: `rand:${game}`, iterations: 400 }));
        } else {
          const { actions } = mod.legalActions(state, seat);
          const action = actions[rng.int(actions.length)] as TicTacToeAction;
          const result = mod.apply(state, seat, action);
          if (!result.ok) throw new Error('random opponent played an illegal move');
          state = result.state;
        }
      }
      const outcome = mod.outcome(state);
      const lost = outcome.status === 'over' && outcome.winners.length > 0 && !outcome.winners.includes(botSeat);
      expect(lost, `game ${game}: the search lost to random play`).toBe(false);
    }
  });

  it('holds up with every extra switched off', () => {
    // The baseline has to be correct on its own. If it is not, an improvement measured against it
    // is measuring the wrong thing.
    let state = fresh();
    state = play(state, 0, 0);
    state = play(state, 1, 4);
    state = play(state, 0, 1);
    expect(pick(state, 1, { ...BASELINE, iterations: 600 })).toBe(2);
  });

  it('gets better with more search, not worse', () => {
    /*
     * A tree that accumulates nothing can still look fine on one-move tactics. This is the property
     * that distinguishes a working search: measured against the solver over a sample of positions,
     * a bigger budget must not do worse than a small one.
     */
    const rng = new RandomCursor('budget', 0);
    const positions: { state: TicTacToeState; seat: Seat; best: number[] }[] = [];
    for (let game = 0; positions.length < 12 && game < 40; game++) {
      let state = fresh();
      for (let i = 0; i < 1 + rng.int(4) && mod.outcome(state).status !== 'over'; i++) {
        const seat = mod.currentActors(state)[0] as Seat;
        const { actions } = mod.legalActions(state, seat);
        state = play(state, seat, (actions[rng.int(actions.length)] as { cell: number }).cell);
      }
      if (mod.outcome(state).status === 'over') continue;
      const seat = mod.currentActors(state)[0] as Seat;
      positions.push({ state, seat, best: optimalCells(state, seat) });
    }

    const rate = (iterations: number) =>
      positions.filter((p, i) => p.best.includes(pick(p.state, p.seat, { iterations, seed: `b${iterations}:${i}` })))
        .length;

    const small = rate(60);
    const large = rate(1500);
    expect(large, `optimal at 1500 (${large}) was worse than at 60 (${small})`).toBeGreaterThanOrEqual(small);
    // And a large budget should get most of them outright.
    expect(large).toBeGreaterThanOrEqual(positions.length - 2);
  });
});
