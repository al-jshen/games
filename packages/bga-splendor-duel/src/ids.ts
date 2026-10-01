import { SPIRAL, tryCard, type GemColor, type TokenColor } from '@games/splendor-duel';

/**
 * BGA's numbering of everything, next to ours.
 *
 * All of it is read from BGA's published implementation of this game (thoun/splendorduel:
 * `modules/php/constants.inc.php`, `Object/Token.php`, `Game.php`) rather than inferred from a
 * running page. `test/ids.test.ts` holds a second copy of BGA's card list and proves the two sides
 * mean the same card by the same number.
 */

const TOKEN_BY_BGA: Readonly<Record<number, TokenColor>> = {
  [-1]: 'gold',
  0: 'pearl',
  1: 'blue',
  2: 'white',
  3: 'green',
  4: 'black',
  5: 'red',
};

const GEM_BY_BGA: Readonly<Record<number, GemColor>> = {
  1: 'blue',
  2: 'white',
  3: 'green',
  4: 'black',
  5: 'red',
};

/** The "colour" BGA files a card under when it has no bonus colour of its own. */
export const BGA_COLORLESS = 9;

/**
 * A token's colour. Gold is a token *type* on BGA (`type: 1`) rather than a colour, so the type is
 * read first. `null` for anything this game does not have without the expansion (glassware, `6`).
 */
export function tokenColorFromBga(token: { type: number; color: number }): TokenColor | null {
  if (token.type === 1) return 'gold';
  if (token.type !== 2 || token.color === -1) return null;
  return TOKEN_BY_BGA[token.color] ?? null;
}

/** A bonus colour — one of the five gems. Pearl and gold are not bonuses, so they are `null`. */
export function gemFromBga(color: number): GemColor | null {
  return GEM_BY_BGA[color] ?? null;
}

export function colorToBga(color: TokenColor): number {
  for (const [bga, ours] of Object.entries(TOKEN_BY_BGA)) {
    if (ours === color) return Number(bga);
  }
  throw new Error(`no BGA colour for ${color}`);
}

/**
 * BGA's board positions 1-25 as [row, column], both 1-based. Index is `position - 1`.
 *
 * BGA numbers positions in refill order and refills in that order, which is exactly what `SPIRAL`
 * is for us. So position k *is* `SPIRAL[k - 1]` and the two boards refill identically — the one
 * thing the orientation of the spiral decides. The coordinates are kept for talking to a person:
 * "row 2, column 4" is what they can find on the screen.
 */
export const BGA_BOARD_COORDINATES: readonly (readonly [number, number])[] = [
  [3, 3], [4, 3], [4, 2], [3, 2], [2, 2],
  [2, 3], [2, 4], [3, 4], [4, 4], [5, 4],
  [5, 3], [5, 2], [5, 1], [4, 1], [3, 1],
  [2, 1], [1, 1], [1, 2], [1, 3], [1, 4],
  [1, 5], [2, 5], [3, 5], [4, 5], [5, 5],
];

export function cellFromBga(position: number): number | null {
  if (!Number.isInteger(position)) return null;
  return SPIRAL[position - 1] ?? null;
}

export function cellToBga(cell: number): number {
  const at = SPIRAL.indexOf(cell);
  if (at < 0) throw new Error(`no such board cell: ${cell}`);
  return at + 1;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** BGA identifies a jewel card by (level, index within the level). So do we, as `l2-07`. */
export function cardIdFromBga(level: number, index: number): string | null {
  const id = `l${level}-${two(index)}`;
  return tryCard(id)?.kind === 'jewel' ? id : null;
}

/** Royals 1-4 are the base game's. 5 and up belong to the expansion and have no card here. */
export function royalIdFromBga(index: number): string | null {
  const id = `royal-${two(index)}`;
  return tryCard(id)?.kind === 'royal' ? id : null;
}
