import { BOARD_CELLS } from './types.js';

/**
 * The order the board is filled: centre first, then outward along the printed spiral.
 *
 * The rulebook only ever says "starting with the central space and following the printed spiral",
 * and the spiral itself is art on the physical board, so text sources cannot settle its orientation.
 * Fan implementations disagree about it.
 *
 * How much that matters: less than it looks. Line legality treats rows, columns and both diagonals
 * symmetrically, so it is invariant under all eight symmetries of the square, and every valid outward
 * square spiral is one of those symmetries applied to any other — so a different orientation is a
 * relabelling of the same game, not a different game. See `test/spiral-symmetry.test.ts`, which
 * proves both halves of that. What the orientation does decide is whether the board on screen refills
 * the way the printed one does, which is cheap to get right, so it was measured rather than guessed.
 *
 * This constant was measured from the printed board art. Each cell carries a path segment; by
 * detecting which cell edges each segment touches you recover the undirected path, and the centre
 * is a degree-1 endpoint that orients it. The result is self-checking: all 25 edge detections
 * agree mutually, there are exactly two degree-1 endpoints (centre = start, top-left = end), it
 * forms a complete 25-cell Hamiltonian path, and its leg lengths are 1,1,2,2,3,3,4,4,4 — the
 * signature of an outward square spiral. Direction: centre, then UP, then clockwise.
 *
 * `tools/verify-spiral` re-derives this from the board art, and a test asserts the two agree.
 *
 *   24  9 10 11 12      (fill order per cell, row 0 at top)
 *   23  8  1  2 13
 *   22  7  0  3 14
 *   21  6  5  4 15
 *   20 19 18 17 16
 */
export const SPIRAL: readonly number[] = [
  12, 7, 8, 13, 18, 17, 16, 11, 6, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5, 0,
];

export const CENTER_CELL = 12;

/** The four line directions for taking tokens: →, ↓, ↘, ↙. */
const DIRECTIONS: readonly [number, number][] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

export function cellRow(cell: number): number {
  return Math.floor(cell / 5);
}

export function cellCol(cell: number): number {
  return cell % 5;
}

export function cellIndex(row: number, col: number): number {
  return row * 5 + col;
}

/**
 * Every straight run of 1-3 cells on the board, as sorted cell-index arrays.
 *
 * Only forward directions are generated, so a run and its reverse are the same entry rather than
 * two. Occupancy is *not* considered here — that is the caller's job — so this can be computed
 * once and cached.
 */
function buildAllLines(): readonly number[][] {
  const lines: number[][] = [];
  for (let cell = 0; cell < BOARD_CELLS; cell++) lines.push([cell]);

  for (const [dr, dc] of DIRECTIONS) {
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        for (const length of [2, 3]) {
          const run: number[] = [];
          let ok = true;
          for (let step = 0; step < length; step++) {
            const r = row + dr * step;
            const c = col + dc * step;
            if (r < 0 || r > 4 || c < 0 || c > 4) {
              ok = false;
              break;
            }
            run.push(cellIndex(r, c));
          }
          if (ok) lines.push(run.slice().sort((a, b) => a - b));
        }
      }
    }
  }
  return lines;
}

/** All geometrically valid selections, regardless of what is currently on the board. */
export const ALL_LINES: readonly number[][] = buildAllLines();

/**
 * Is `cells` a legal "take up to 3 tokens" selection on this board?
 *
 * The rule that trips implementations up: a gold token or an empty space *inside* the run makes it
 * illegal — you may not jump over either. Since every cell in a candidate run must hold a non-gold
 * token, that falls out of checking occupancy across the whole run.
 */
export function isLegalTokenLine(board: readonly (string | null)[], cells: readonly number[]): boolean {
  if (cells.length < 1 || cells.length > 3) return false;
  const unique = new Set(cells);
  if (unique.size !== cells.length) return false;
  for (const cell of cells) {
    if (!Number.isInteger(cell) || cell < 0 || cell >= BOARD_CELLS) return false;
    const token = board[cell];
    if (token === null || token === undefined || token === 'gold') return false;
  }
  const sorted = [...cells].sort((a, b) => a - b);
  const key = sorted.join(',');
  return LINE_KEYS.has(key);
}

const LINE_KEYS: ReadonlySet<string> = new Set(ALL_LINES.map((l) => l.join(',')));

/** Legal token selections given current occupancy. Used by `legalActions`. */
export function availableTokenLines(board: readonly (string | null)[]): number[][] {
  return ALL_LINES.filter((line) =>
    line.every((cell) => {
      const token = board[cell];
      return token !== null && token !== undefined && token !== 'gold';
    }),
  );
}
