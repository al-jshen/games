import type { ComponentType } from 'react';

/**
 * Per-game UI, loaded on demand.
 *
 * This map plus one line in the server registry is the entire cost of adding a game. There is
 * deliberately no generic board renderer: board games differ enough that a generic one would fit
 * exactly one of them and fight every other.
 */
export interface BoardProps {
  /** The redacted view for this viewer. Shape is game-defined. */
  view: unknown;
  seat: number | null;
  /** Seats allowed to act right now. */
  actors: number[];
  submit: (action: unknown) => void;
  /** True while a local move is awaiting server confirmation. */
  pending: boolean;
}

export type BoardComponent = ComponentType<BoardProps>;

/**
 * What a game's `./ui` entry may export. Only the board is required; `describeEffect` lets a game
 * narrate its own move log, since only it knows that `l1-09` is a level-1 white card.
 */
export interface BoardModule {
  default: BoardComponent;
  describeEffect?: (effect: Record<string, unknown>) => string;
}

const BOARDS: Record<string, () => Promise<BoardModule>> = {
  'splendor-duel': () => import('@games/splendor-duel/ui'),
  'tic-tac-toe': () => import('@games/tic-tac-toe/ui'),
};

export function hasBoard(gameId: string): boolean {
  return gameId in BOARDS;
}

export function loadBoard(gameId: string): Promise<BoardModule> {
  const loader = BOARDS[gameId];
  if (!loader) return Promise.reject(new Error(`No UI registered for game "${gameId}"`));
  return loader();
}
