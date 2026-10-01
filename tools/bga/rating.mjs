/**
 * One rating, fitted to results against opponents whose ratings are known.
 *
 * The model is the Elo curve and nothing else: the chance of beating an opponent rated R_i from a
 * rating R is 1 / (1 + 10^((R_i - R) / 400)). The estimate is the R that makes the expected score
 * equal the actual one, which is the maximum-likelihood R. It is in whatever units the opponents'
 * ratings are in -- BGA displays ratings shifted by a constant, and a constant shift of every
 * input shifts the answer by the same amount.
 *
 * The interval comes from the curvature of the likelihood at the estimate (Fisher information).
 * It is honest about the number of games and silent about everything else: it knows nothing about
 * whether the opponents were trying.
 */

const K = Math.LN10 / 400;

export function expected(rating, opponent) {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/** The root of an increasing function, by bisection. A hundred halvings is far past float precision. */
function root(f, lo, hi) {
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function fitRating(games) {
  const n = games.length;
  if (n === 0) return { games: 0, score: 0, rating: null, low: null, high: null, bound: null };

  const score = games.reduce((total, game) => total + game.score, 0);
  const lo = Math.min(...games.map((g) => g.opponent)) - 2000;
  const hi = Math.max(...games.map((g) => g.opponent)) + 2000;

  if (score === n || score === 0) {
    /*
     * Every game went the same way, so the likelihood has no peak -- it only keeps rising (or
     * falling) with R. What the data does support is a one-sided statement: the rating below which
     * a clean sweep like this would have been a 1-in-20 event.
     */
    const won = score === n;
    const logLikelihood = (r) =>
      games.reduce((total, g) => total + Math.log(won ? expected(r, g.opponent) : 1 - expected(r, g.opponent)), 0);
    const edge = root((r) => (won ? logLikelihood(r) - Math.log(0.05) : Math.log(0.05) - logLikelihood(r)), lo, hi);
    return {
      games: n,
      score,
      rating: null,
      low: won ? edge : null,
      high: won ? null : edge,
      bound: won ? 'at-least' : 'at-most',
    };
  }

  const rating = root((r) => games.reduce((total, g) => total + expected(r, g.opponent), 0) - score, lo, hi);
  const information =
    K * K *
    games.reduce((total, g) => {
      const e = expected(rating, g.opponent);
      return total + e * (1 - e);
    }, 0);
  const half = 1.96 / Math.sqrt(information);
  return { games: n, score, rating, low: rating - half, high: rating + half, bound: null };
}
