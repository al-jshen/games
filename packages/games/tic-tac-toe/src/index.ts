/**
 * Tic-tac-toe: the smallest complete `GameModule`.
 *
 * It exists to validate the abstraction rather than to be fun. An interface with a single
 * implementor is a guess, and this is what proves that adding a game touches no platform code —
 * only a new package plus one line in the server registry and one in the web app's board map.
 *
 * It also exercises the awkward corners deliberately: a game with no hidden information at all
 * (so `redactFor` is near-identity), a draw outcome, and an action space small enough that
 * `legalActions` is trivially complete.
 */

import {
  applyErr,
  applyOk,
  gameError,
  seal,
  type ApplyResult,
  type Effect,
  type GameError,
  type GameModule,
  type Outcome,
  type Seat,
  type Validator,
  type Viewer,
} from '@games/engine';
import { z } from 'zod';

export type Mark = 'x' | 'o';
export type Cell = Mark | null;

export interface TicTacToeState {
  readonly v: 1;
  seed: string;
  board: Cell[];
  turn: Seat;
  winner: Seat | null;
  /** Set when the board fills with no line. */
  draw: boolean;
  moves: number;
}

/** No hidden information, so the view is the state minus the seed. */
export interface TicTacToeView {
  readonly v: 1;
  you: Seat | null;
  board: Cell[];
  turn: Seat;
  winner: Seat | null;
  draw: boolean;
  moves: number;
}

export type TicTacToeAction = { t: 'place'; cell: number };
export type TicTacToeOptions = Record<string, never>;

const LINES: readonly [number, number, number][] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function markFor(seat: Seat): Mark {
  return seat === 0 ? 'x' : 'o';
}

function winningSeat(board: readonly Cell[]): Seat | null {
  for (const [a, b, c] of LINES) {
    const mark = board[a];
    if (mark && mark === board[b] && mark === board[c]) return mark === 'x' ? 0 : 1;
  }
  return null;
}

function adapt<T>(schema: z.ZodType<unknown>): Validator<T> {
  return {
    validate(input: unknown) {
      const parsed = schema.safeParse(input);
      if (parsed.success) return { ok: true, value: parsed.data as T };
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };
    },
  };
}

const zAction = z.object({ t: z.literal('place'), cell: z.number().int().min(0).max(8) });

function validate(state: TicTacToeState, seat: Seat, action: TicTacToeAction): true | GameError {
  if (state.winner !== null || state.draw) return gameError('MATCH_OVER', 'The match is over.');
  if (seat !== state.turn) return gameError('NOT_YOUR_TURN', 'It is not your turn.');
  if (state.board[action.cell] !== null) return gameError('ILLEGAL_ACTION', 'That cell is taken.');
  return true;
}

export const ticTacToe: GameModule<TicTacToeState, TicTacToeAction, TicTacToeView, TicTacToeOptions> = {
  id: 'tic-tac-toe',
  stateVersion: 1,
  meta: {
    title: 'Tic-Tac-Toe',
    blurb: 'Three in a row. Mostly here to prove new games plug in cleanly.',
    minPlayers: 2,
    maxPlayers: 2,
    estMinutes: [1, 2],
  },
  actionValidator: adapt<TicTacToeAction>(zAction),
  optionsValidator: adapt<TicTacToeOptions>(z.object({}).default({})),

  setup({ seed }) {
    return {
      v: 1,
      seed,
      board: new Array<Cell>(9).fill(null),
      // Seat 0 always starts; there is nothing to randomise, so the seed is unused here.
      turn: 0,
      winner: null,
      draw: false,
      moves: 0,
    };
  },

  currentActors(state) {
    return state.winner !== null || state.draw ? [] : [state.turn];
  },

  legalActions(state, seat) {
    if (state.winner !== null || state.draw || seat !== state.turn) {
      return { actions: [], truncated: false };
    }
    const actions: TicTacToeAction[] = [];
    state.board.forEach((cell, i) => {
      if (cell === null) actions.push({ t: 'place', cell: i });
    });
    return { actions, truncated: false };
  },

  isLegal: validate,

  apply(state, seat, action): ApplyResult<TicTacToeState> {
    const problem = validate(state, seat, action);
    if (problem !== true) return applyErr(problem.code, problem.message);

    const board = [...state.board];
    board[action.cell] = markFor(seat);
    const effects: Effect[] = [{ k: 'placed', seat, cell: action.cell, mark: markFor(seat) }];

    const winner = winningSeat(board);
    const moves = state.moves + 1;
    const draw = winner === null && moves === 9;
    if (winner !== null) effects.push({ k: 'gameOver', winner, reason: 'line' });
    else if (draw) effects.push({ k: 'gameOver', winner: null, reason: 'draw' });

    return applyOk({
      ...state,
      board,
      moves,
      winner,
      draw,
      turn: (winner === null && !draw ? 1 - seat : seat) as Seat,
    }, effects);
  },

  outcome(state): Outcome {
    if (state.winner !== null) return { status: 'over', winners: [state.winner], reason: 'line' };
    if (state.draw) return { status: 'over', winners: [], reason: 'draw' };
    return { status: 'active' };
  },

  redactFor(viewer: Viewer, state) {
    // Built from scratch rather than by deleting `seed`, so a future secret field cannot leak by
    // being forgotten here.
    return seal<TicTacToeView>({
      v: 1,
      you: viewer,
      board: [...state.board],
      turn: state.turn,
      winner: state.winner,
      draw: state.draw,
      moves: state.moves,
    });
  },

  redactEffect(_viewer, effect) {
    return effect;
  },
};

export default ticTacToe;
