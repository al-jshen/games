import { describe, expect, it } from 'vitest';
import { CARD_DEFS, card } from '../src/cards.js';
import { ALL_LINES, SPIRAL, isLegalTokenLine } from '../src/spiral.js';
import { GEM_COLORS } from '../src/types.js';

/**
 * These duplicate the generator's own checks on purpose. The generator can only fail at generation
 * time; these fail in CI if anyone hand-edits `cards.generated.ts`.
 */
describe('card data', () => {
  const jewels = CARD_DEFS.filter((c) => c.kind === 'jewel');
  const royals = CARD_DEFS.filter((c) => c.kind === 'royal');
  const sum = (xs: readonly number[]) => xs.reduce((t, n) => t + n, 0);

  it('has the right deck composition', () => {
    expect(CARD_DEFS).toHaveLength(71);
    expect(jewels.filter((c) => c.level === 1)).toHaveLength(30);
    expect(jewels.filter((c) => c.level === 2)).toHaveLength(24);
    expect(jewels.filter((c) => c.level === 3)).toHaveLength(13);
    expect(royals).toHaveLength(4);
    expect(new Set(CARD_DEFS.map((c) => c.id)).size).toBe(71);
  });

  it('totals 92 jewel prestige, 9 royal prestige and 28 crowns', () => {
    expect(sum(jewels.map((c) => c.points))).toBe(92);
    expect(sum(royals.map((c) => c.points))).toBe(9);
    expect(sum(jewels.map((c) => c.crowns))).toBe(28);
    expect(sum(royals.map((c) => c.crowns))).toBe(0);
  });

  it('has 5 double-bonus cards, all level 2', () => {
    const doubles = jewels.filter((c) => c.bonusCount === 2);
    expect(doubles.map((c) => c.id).sort()).toEqual(['l2-04', 'l2-08', 'l2-12', 'l2-16', 'l2-20']);
    expect(doubles.every((c) => c.level === 2)).toBe(true);
  });

  it('has 9 wild cards and 3 no-bonus prestige cards', () => {
    expect(jewels.filter((c) => c.wild)).toHaveLength(9);
    const noBonus = jewels.filter((c) => !c.wild && c.bonusColor === null);
    expect(noBonus.map((c) => c.points).sort((a, b) => a - b)).toEqual([3, 5, 6]);
  });

  it('distributes abilities as the physical deck does', () => {
    const withAbility = (tag: string) => jewels.filter((c) => c.abilities.includes(tag as never)).length;
    expect(withAbility('playAgain')).toBe(6);
    expect(withAbility('takeMatchingToken')).toBe(5);
    expect(withAbility('takePrivilege')).toBe(5);
    expect(withAbility('stealToken')).toBe(5);
    expect(withAbility('wildBonus')).toBe(9);
    // Exactly one card carries two abilities: the level-3 wild card costing 8 red.
    const twoAbilities = jewels.filter((c) => c.abilities.length === 2);
    expect(twoAbilities).toHaveLength(1);
    expect(twoAbilities[0]!.abilities.sort()).toEqual(['playAgain', 'wildBonus']);
  });

  it('gives every colour an equal share at each level', () => {
    for (const [level, per] of [
      [1, 5],
      [2, 4],
      [3, 2],
    ] as const) {
      for (const color of GEM_COLORS) {
        expect(jewels.filter((c) => c.level === level && c.bonusColor === color)).toHaveLength(per);
      }
    }
  });

  it('matches the royal card signatures', () => {
    expect(royals.map((c) => `${c.points}:${c.abilities.join('+') || 'none'}`).sort()).toEqual([
      '2:playAgain',
      '2:stealToken',
      '2:takePrivilege',
      '3:none',
    ]);
  });

  it('reproduces the l1-27 cross-source regression case', () => {
    // Three published fan datasets get this card wrong (an extra black, or a dropped crown).
    const c = card('l1-27');
    expect(c.cost).toEqual({ white: 4, pearl: 1 });
    expect(c.crowns).toBe(1);
    expect(c.points).toBe(0);
    expect(c.wild).toBe(true);
  });

  it('never asks for more than one pearl and has no pearl bonus', () => {
    expect(Math.max(...jewels.map((c) => c.cost.pearl ?? 0))).toBe(1);
    expect(jewels.some((c) => (c.bonusColor as string) === 'pearl')).toBe(false);
  });
});

describe('the board spiral', () => {
  it('is a complete permutation of the 25 cells starting at the centre', () => {
    expect(SPIRAL).toHaveLength(25);
    expect(new Set(SPIRAL).size).toBe(25);
    expect(SPIRAL[0]).toBe(12);
    expect([...SPIRAL].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('walks one step at a time, never diagonally', () => {
    for (let i = 1; i < SPIRAL.length; i++) {
      const a = SPIRAL[i - 1]!;
      const b = SPIRAL[i]!;
      const dr = Math.abs(Math.floor(a / 5) - Math.floor(b / 5));
      const dc = Math.abs((a % 5) - (b % 5));
      expect(dr + dc).toBe(1);
    }
  });

  it('has the leg lengths of an outward square spiral', () => {
    // Measured from the printed board art; 1,1,2,2,3,3,4,4,4 is the signature.
    const legs: number[] = [];
    let run = 1;
    for (let i = 2; i < SPIRAL.length; i++) {
      const prev = SPIRAL[i - 1]! - SPIRAL[i - 2]!;
      const curr = SPIRAL[i]! - SPIRAL[i - 1]!;
      if (curr === prev) run += 1;
      else {
        legs.push(run);
        run = 1;
      }
    }
    legs.push(run);
    expect(legs).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 4]);
  });

  it('turns clockwise, starting upward out of the centre', () => {
    // centre (2,2) -> (1,2) is one row up.
    expect(SPIRAL[1]).toBe(7);
    expect(SPIRAL[2]).toBe(8);
  });
});

describe('token lines', () => {
  it('enumerates every straight run of 1-3 cells exactly once', () => {
    // 25 singles.
    // Pairs: 5x4 horizontal + 5x4 vertical + 4x4 down-right + 4x4 down-left = 20+20+16+16 = 72.
    // Triples: 5x3 + 5x3 + 3x3 + 3x3 = 15+15+9+9 = 48.
    expect(ALL_LINES.filter((l) => l.length === 1)).toHaveLength(25);
    expect(ALL_LINES.filter((l) => l.length === 2)).toHaveLength(72);
    expect(ALL_LINES.filter((l) => l.length === 3)).toHaveLength(48);
    expect(ALL_LINES).toHaveLength(145);
    const keys = ALL_LINES.map((l) => l.join(','));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('rejects runs broken by a gap or a gold token', () => {
    const board: (string | null)[] = new Array(25).fill('white');
    expect(isLegalTokenLine(board, [0, 1, 2])).toBe(true);

    board[1] = null; // an empty space inside the run
    expect(isLegalTokenLine(board, [0, 1, 2])).toBe(false);

    board[1] = 'gold'; // a gold token inside the run
    expect(isLegalTokenLine(board, [0, 1, 2])).toBe(false);

    // ...and you may not jump over it to take the cells either side.
    expect(isLegalTokenLine(board, [0, 2])).toBe(false);
  });

  it('rejects non-collinear and oversized selections', () => {
    const board: (string | null)[] = new Array(25).fill('white');
    expect(isLegalTokenLine(board, [0, 1, 2, 3])).toBe(false);
    expect(isLegalTokenLine(board, [0, 2, 4])).toBe(false); // gapped along a row
    expect(isLegalTokenLine(board, [0, 6, 12])).toBe(true); // diagonal
    expect(isLegalTokenLine(board, [4, 8, 12])).toBe(true); // anti-diagonal
    expect(isLegalTokenLine(board, [0, 1])).toBe(true);
    expect(isLegalTokenLine(board, [4, 5])).toBe(false); // wraps from row 0 to row 1
  });
});
