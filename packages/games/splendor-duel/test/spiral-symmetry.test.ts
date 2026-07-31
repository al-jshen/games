import { describe, expect, it } from 'vitest';
import { ALL_LINES, SPIRAL } from '../src/spiral.js';

/**
 * How much does the spiral's orientation actually matter?
 *
 * The rulebook does not specify it, implementations disagree, and it is tempting to treat that as a
 * correctness problem. These tests establish that it is mostly *not* one, and say exactly why — which
 * is worth pinning down, because the alternative is worrying about it forever.
 *
 * The argument: the only thing cell positions are used for is (a) which cells form a takeable line
 * and (b) the order the board refills. Line legality treats rows, columns and both diagonals
 * symmetrically, so it is invariant under the eight symmetries of the square. And every valid
 * outward square spiral is one of those eight symmetries applied to any other. So two
 * implementations that pick different orientations are playing relabellings of the same game.
 *
 * What the orientation *does* affect is whether the on-screen board matches the printed one, which is
 * why it was still worth measuring rather than guessing.
 */

/** The eight symmetries of the square, as maps on row-major cell indices of a 5x5 grid. */
const D4: { name: string; map: (cell: number) => number }[] = (() => {
  const at = (r: number, c: number) => r * 5 + c;
  const rc = (cell: number) => [Math.floor(cell / 5), cell % 5] as const;
  return [
    { name: 'identity', map: (x) => x },
    { name: 'rotate 90', map: (x) => { const [r, c] = rc(x); return at(c, 4 - r); } },
    { name: 'rotate 180', map: (x) => { const [r, c] = rc(x); return at(4 - r, 4 - c); } },
    { name: 'rotate 270', map: (x) => { const [r, c] = rc(x); return at(4 - c, r); } },
    { name: 'flip horizontal', map: (x) => { const [r, c] = rc(x); return at(r, 4 - c); } },
    { name: 'flip vertical', map: (x) => { const [r, c] = rc(x); return at(4 - r, c); } },
    { name: 'transpose', map: (x) => { const [r, c] = rc(x); return at(c, r); } },
    { name: 'anti-transpose', map: (x) => { const [r, c] = rc(x); return at(4 - c, 4 - r); } },
  ];
})();

const key = (cells: readonly number[]) => [...cells].sort((a, b) => a - b).join(',');

/** Is this order a legal outward square spiral: centre start, single steps, the right leg lengths? */
function isOutwardSpiral(order: readonly number[]): boolean {
  if (order.length !== 25 || new Set(order).size !== 25) return false;
  if (order[0] !== 12) return false;
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1] as number;
    const b = order[i] as number;
    const dr = Math.abs(Math.floor(a / 5) - Math.floor(b / 5));
    const dc = Math.abs((a % 5) - (b % 5));
    if (dr + dc !== 1) return false;
  }
  const legs: number[] = [];
  let run = 1;
  for (let i = 2; i < order.length; i++) {
    if ((order[i] as number) - (order[i - 1] as number) === (order[i - 1] as number) - (order[i - 2] as number)) run += 1;
    else {
      legs.push(run);
      run = 1;
    }
  }
  legs.push(run);
  return JSON.stringify(legs) === JSON.stringify([1, 1, 2, 2, 3, 3, 4, 4, 4]);
}

/** Build a spiral from scratch: pick a first step and a turn direction, then walk outward. */
function buildSpiral(firstDir: number, clockwise: boolean): number[] {
  // Directions in clockwise order starting from "up".
  const dirs = [
    [-1, 0],
    [0, 1],
    [1, 0],
    [0, -1],
  ] as const;
  const legs = [1, 1, 2, 2, 3, 3, 4, 4, 4];
  let dir = firstDir;
  let row = 2;
  let col = 2;
  const out = [12];
  for (const leg of legs) {
    const [dr, dc] = dirs[dir] as readonly [number, number];
    for (let step = 0; step < leg; step++) {
      row += dr;
      col += dc;
      if (row < 0 || row > 4 || col < 0 || col > 4) return [];
      out.push(row * 5 + col);
    }
    dir = clockwise ? (dir + 1) % 4 : (dir + 3) % 4;
  }
  return out;
}

describe('the spiral orientation question', () => {
  it('ships a valid outward square spiral', () => {
    expect(isOutwardSpiral(SPIRAL)).toBe(true);
  });

  it('there are exactly eight valid outward spirals', () => {
    const built = new Set<string>();
    for (let dir = 0; dir < 4; dir++) {
      for (const clockwise of [true, false]) {
        const spiral = buildSpiral(dir, clockwise);
        if (spiral.length === 25 && isOutwardSpiral(spiral)) built.add(spiral.join(','));
      }
    }
    expect(built.size).toBe(8);
  });

  it('those eight are exactly the symmetries of the one we ship', () => {
    // Independently constructed spirals...
    const built = new Set<string>();
    for (let dir = 0; dir < 4; dir++) {
      for (const clockwise of [true, false]) {
        const spiral = buildSpiral(dir, clockwise);
        if (spiral.length === 25 && isOutwardSpiral(spiral)) built.add(spiral.join(','));
      }
    }
    // ...match the orbit of ours under the eight symmetries of the square.
    const orbit = new Set(D4.map(({ map }) => SPIRAL.map(map).join(',')));
    expect(orbit.size).toBe(8);
    expect([...orbit].sort()).toEqual([...built].sort());
  });

  it('line legality is invariant under every symmetry, which is why orientation is a relabelling', () => {
    const lines = new Set(ALL_LINES.map(key));
    for (const { name, map } of D4) {
      const mapped = new Set(ALL_LINES.map((line) => key(line.map(map))));
      expect(mapped.size, name).toBe(lines.size);
      expect([...mapped].sort(), `lines are not invariant under ${name}`).toEqual([...lines].sort());
    }
  });

  it('the two orientations fan implementations disagree about are a 180-degree rotation apart', () => {
    // Ours steps up out of the centre; the common alternative steps down. Same game, board turned
    // around -- which is why picking the wrong one is a cosmetic bug rather than a rules bug.
    const rotated = SPIRAL.map(D4.find((t) => t.name === 'rotate 180')!.map);
    expect(rotated.slice(0, 3)).toEqual([12, 17, 16]);
    expect(isOutwardSpiral(rotated)).toBe(true);
  });
});
