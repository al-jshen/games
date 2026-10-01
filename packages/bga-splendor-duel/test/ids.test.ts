import { ALL_LINES, CARD_DEFS, SPIRAL, TOKEN_COLORS, card } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import {
  BGA_BOARD_COORDINATES,
  cardIdFromBga,
  cellFromBga,
  cellToBga,
  colorToBga,
  gemFromBga,
  royalIdFromBga,
  tokenColorFromBga,
} from '../src/ids.js';
import { BGA_CARDS, BGA_ROYALS } from './fixtures/bga-cards.js';

/**
 * The three vocabularies BGA and this repo each have a version of.
 *
 * Every one of these is a place where the two could disagree without anything crashing: a colour
 * off by one is still a colour, a rotated board is still a board, and a mislabelled card is still a
 * card. The bot would simply be shown a position that is not the one on the table.
 */

const POWER: Record<number, string> = {
  1: 'playAgain',
  2: 'wildBonus',
  3: 'takeMatchingToken',
  4: 'takePrivilege',
  5: 'stealToken',
};

describe('colours', () => {
  it('round-trips every token colour', () => {
    for (const color of TOKEN_COLORS) {
      const bga = colorToBga(color);
      expect(tokenColorFromBga({ type: color === 'gold' ? 1 : 2, color: bga })).toBe(color);
    }
  });

  it('reads gold from the token type, whatever the colour field says', () => {
    expect(tokenColorFromBga({ type: 1, color: -1 })).toBe('gold');
    expect(tokenColorFromBga({ type: 1, color: 0 })).toBe('gold');
  });

  it('has no word for the expansion colour', () => {
    expect(tokenColorFromBga({ type: 2, color: 6 })).toBeNull();
    expect(gemFromBga(6)).toBeNull();
    // Pearl and gold are tokens, not gems: no card has either as its bonus.
    expect(gemFromBga(0)).toBeNull();
    expect(gemFromBga(-1)).toBeNull();
  });
});

describe('board cells', () => {
  it('maps the 25 BGA positions onto the 25 cells, in the order both sides refill', () => {
    const cells = Array.from({ length: 25 }, (_, i) => cellFromBga(i + 1));
    expect(cells).toEqual([...SPIRAL]);
    for (const cell of SPIRAL) expect(cellFromBga(cellToBga(cell))).toBe(cell);
    expect(cellFromBga(0)).toBeNull();
    expect(cellFromBga(26)).toBeNull();
  });

  it("is BGA's board turned half a turn, which keeps every line a line", () => {
    /*
     * BGA numbers its positions from the centre going *down* first; our spiral goes up first. That
     * is a 180-degree rotation, and the reason it is harmless is checked rather than asserted: a
     * rotation of the square sends straight runs to straight runs.
     */
    BGA_BOARD_COORDINATES.forEach(([row, column], i) => {
      const rowMajor = (row - 1) * 5 + (column - 1);
      expect(cellFromBga(i + 1)).toBe(24 - rowMajor);
    });
    const lines = new Set(ALL_LINES.map((line) => line.join(',')));
    for (const line of ALL_LINES) {
      const turned = line.map((cell) => 24 - cell).sort((a, b) => a - b);
      expect(lines.has(turned.join(','))).toBe(true);
    }
  });
});

describe('cards', () => {
  it('agrees with BGA on every jewel card, field by field', () => {
    for (const [level, index, colour, cost, provides, points, crowns, powers] of BGA_CARDS) {
      const id = cardIdFromBga(level, index);
      expect(id, `BGA card (${level}, ${index})`).not.toBeNull();
      const def = card(id as string);

      const [bonus] = Object.entries(provides);
      const expectedCost = Object.fromEntries(
        Object.entries(cost).map(([c, n]) => [tokenColorFromBga({ type: 2, color: Number(c) }), n]),
      );
      expect(
        {
          level: def.level,
          points: def.points,
          crowns: def.crowns,
          bonusColor: def.bonusColor,
          bonusCount: def.bonusCount,
          wild: def.wild,
          cost: def.cost,
          abilities: [...def.abilities].sort(),
        },
        id as string,
      ).toEqual({
        level,
        points,
        crowns,
        bonusColor: colour === 9 ? null : gemFromBga(colour),
        bonusCount: bonus ? bonus[1] : 0,
        wild: bonus ? Number(bonus[0]) === 9 : false,
        cost: expectedCost,
        abilities: powers.map((p) => POWER[p]).sort(),
      });
    }
  });

  it('covers the whole deck, and nothing outside it', () => {
    const jewels = CARD_DEFS.filter((c) => c.kind === 'jewel').map((c) => c.id).sort();
    const mapped = BGA_CARDS.map(([level, index]) => cardIdFromBga(level, index)).sort();
    expect(mapped).toEqual(jewels);
    expect(cardIdFromBga(1, 31)).toBeNull();
    expect(cardIdFromBga(4, 1)).toBeNull();
  });

  it('agrees with BGA on the four royals, and refuses the expansion ones', () => {
    for (const [index, points, powers] of BGA_ROYALS) {
      const def = card(royalIdFromBga(index) as string);
      expect(def.kind).toBe('royal');
      expect(def.points).toBe(points);
      expect([...def.abilities].sort()).toEqual(powers.map((p) => POWER[p]).sort());
    }
    expect(royalIdFromBga(5)).toBeNull();
  });
});
