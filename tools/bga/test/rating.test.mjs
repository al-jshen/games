import { describe, expect, it } from 'vitest';
import { expected, fitRating } from '../rating.mjs';

/** A small seeded generator, so the simulated games are the same games every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the rating estimate', () => {
  it('recovers a known rating from simulated games', () => {
    const random = mulberry32(20260930);
    const truth = 1650;
    const games = Array.from({ length: 3000 }, () => {
      const opponent = 1300 + Math.floor(random() * 600);
      return { opponent, score: random() < expected(truth, opponent) ? 1 : 0 };
    });
    const fit = fitRating(games);
    expect(fit.bound).toBeNull();
    // The standard error at 3000 games is about 7 points; 60 is far outside chance.
    expect(Math.abs(fit.rating - truth)).toBeLessThan(60);
    expect(fit.high - fit.low).toBeGreaterThan(15);
    expect(fit.high - fit.low).toBeLessThan(60);
  });

  it('puts an even record against one opponent at that opponent', () => {
    const fit = fitRating([{ opponent: 1500, score: 1 }, { opponent: 1500, score: 0 }]);
    expect(fit.rating).toBeCloseTo(1500, 3);
    // Two games say almost nothing, and the interval has to admit it.
    expect(fit.high - fit.low).toBeGreaterThan(400);
  });

  it('gives a bound, not a number, when every game went the same way', () => {
    const sweep = fitRating(Array.from({ length: 5 }, () => ({ opponent: 1500, score: 1 })));
    expect(sweep.rating).toBeNull();
    expect(sweep.bound).toBe('at-least');
    // The rating at which five straight wins is a 1-in-20 event: 0.05^(1/5) = 0.5493 expected score.
    expect(sweep.low).toBeCloseTo(1534.35, 0);
    const blank = fitRating(Array.from({ length: 5 }, () => ({ opponent: 1500, score: 0 })));
    expect(blank.bound).toBe('at-most');
    expect(blank.high).toBeCloseTo(1465.65, 0);
  });

  it('says nothing about no games', () => {
    expect(fitRating([])).toEqual({ games: 0, score: 0, rating: null, low: null, high: null, bound: null });
  });
});
