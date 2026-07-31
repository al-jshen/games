/**
 * Counter-based deterministic randomness.
 *
 * Every random value is a pure function of `(seed, counter)`, so a game's state only has to
 * carry an integer to be perfectly reproducible. This is deliberately vendored rather than
 * taken from a dependency: a PRNG whose output changes between versions would silently
 * invalidate every stored replay, and no test would catch it.
 *
 * The seed is a secret with the same weight as deck order — anyone holding it can compute every
 * future shuffle. It must never appear in a redacted view.
 */

/** FNV-1a over a string, to fold the seed down to 32 bits. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32 finaliser — good avalanche, 32-bit safe in JS. */
function splitmix32(x: number): number {
  let t = (x + 0x9e3779b9) | 0;
  t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
  t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
  return (t ^ (t >>> 15)) >>> 0;
}

/** The n-th 32-bit random word for a seed. Pure: same inputs always give the same word. */
export function randomU32(seed: string, counter: number): number {
  return splitmix32((hashString(seed) ^ splitmix32(counter | 0)) | 0);
}

/**
 * A cursor over the random stream. Mutating `counter` inside a reducer is fine — it is not
 * observable from outside — but the reducer must write the final value back into game state.
 *
 *   const draw = new RandomCursor(state.seed, state.rngCounter);
 *   const order = draw.shuffle(cards);
 *   return { ...state, deck: order, rngCounter: draw.counter };
 */
export class RandomCursor {
  constructor(
    private readonly seed: string,
    public counter: number,
  ) {}

  /** Next raw 32-bit word. */
  u32(): number {
    return randomU32(this.seed, this.counter++);
  }

  /** Uniform integer in `[0, n)`, unbiased via rejection sampling. */
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`RandomCursor.int: bad bound ${n}`);
    if (n === 1) return 0;
    // Reject the short tail so every residue is equally likely.
    const limit = Math.floor(0x100000000 / n) * n;
    let v = this.u32();
    while (v >= limit) v = this.u32();
    return v % n;
  }

  /** Fisher-Yates. Returns a new array; the input is untouched. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  /**
   * Remove and return one uniformly-chosen element. Mutates `pool` — intended for drawing from
   * a bag inside a reducer that already owns a fresh copy of the array.
   */
  take<T>(pool: T[]): T {
    if (pool.length === 0) throw new Error('RandomCursor.take: empty pool');
    const i = this.int(pool.length);
    const [v] = pool.splice(i, 1);
    return v as T;
  }
}
