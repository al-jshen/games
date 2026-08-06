import type { Seat } from '@games/engine';
import { bonuses, colorPoints, totalCrowns, totalPoints } from './score.js';
import type { PlayerState, SplendorState } from './types.js';
import {
  GEM_COLORS,
  TOKEN_COLORS,
  WIN_COLOR_PRESTIGE,
  WIN_CROWNS,
  WIN_PRESTIGE,
} from './types.js';

/**
 * How good a position is, roughly, without searching.
 *
 * A search needs *some* opinion at the point where it stops looking. This one is deliberately
 * shallow: it exists to be directionally right, not to play well on its own. Anything requiring
 * lookahead — denial, tempo traps, which specific card to contest — is the search's job.
 *
 * The one idea that matters here is that Splendor Duel has **three win conditions and you only need
 * one**. So progress is a *max*, not a sum. A player on 19 prestige with no crowns is nearly winning;
 * adding their three measures together would rate them mediocre and the search would happily trade
 * away the win.
 *
 * Every weight is exposed because none of them is more than an educated guess. They are meant to be
 * tuned by playing configurations against each other, not by argument.
 */
export interface EvalWeights {
  /** Weight on progress toward the nearest win condition. */
  race: number;
  /**
   * Convexity of that progress. Above 1 because the last few points are worth far more than the
   * first few — 19 of 20 converts next turn, 10 of 20 does not.
   */
  raceExponent: number;
  /** Weight on the engine: things that buy *future* prestige rather than present prestige. */
  engine: number;
  /** Per permanent colour bonus. These compound — each one discounts that colour for ever. */
  bonus: number;
  /** Gold is wild, so it is worth more than a gem. */
  gold: number;
  gem: number;
  /** A scroll is a free token off the board, and you choose which. */
  privilege: number;
  /** A reservation is optionality plus a little denial. */
  reserved: number;
  /** Having the move is worth something in a race. */
  tempo: number;
  /** Squash factor into [-1, 1]. Larger makes the evaluation more decisive. */
  sharpness: number;
}

export const DEFAULT_WEIGHTS: EvalWeights = {
  race: 1,
  raceExponent: 1.5,
  engine: 0.08,
  bonus: 1,
  gold: 0.5,
  gem: 0.32,
  privilege: 0.4,
  reserved: 0.25,
  tempo: 0.04,
  sharpness: 2.2,
};

/** Progress toward whichever win condition this player is closest to, in [0, 1]. */
export function raceProgress(player: PlayerState): number {
  const perColor = colorPoints(player);
  const best = Math.max(...GEM_COLORS.map((c) => perColor[c]));
  return Math.max(
    totalPoints(player) / WIN_PRESTIGE,
    totalCrowns(player) / WIN_CROWNS,
    best / WIN_COLOR_PRESTIGE,
  );
}

function engineStrength(player: PlayerState, w: EvalWeights): number {
  // Hoisted: `bonuses` rebuilds its record by walking the whole tableau, and this is called at every
  // leaf of every iteration. Calling it once per colour was five times the work for one answer.
  const owned = bonuses(player);
  const bonus = GEM_COLORS.reduce((sum, c) => sum + owned[c], 0);
  const gems = TOKEN_COLORS.reduce((sum, c) => (c === 'gold' ? sum : sum + player.tokens[c]), 0);
  return (
    bonus * w.bonus +
    player.tokens.gold * w.gold +
    gems * w.gem +
    player.privileges * w.privilege +
    player.reserved.length * w.reserved
  );
}

function standing(state: SplendorState, seat: Seat, w: EvalWeights): number {
  const player = state.players[seat as 0 | 1];
  const race = Math.pow(Math.min(1, raceProgress(player)), w.raceExponent);
  const tempo = state.turn === seat ? w.tempo : 0;
  return w.race * race + w.engine * engineStrength(player, w) + tempo;
}

/**
 * The position from `seat`'s point of view, in [-1, 1], on the same scale as a win or a loss so it
 * composes with terminal results in a search.
 *
 * Always a difference, never an absolute: this is a race, and being three cards from winning means
 * nothing if the opponent is two away.
 */
export function evaluate(state: SplendorState, seat: Seat, weights: EvalWeights = DEFAULT_WEIGHTS): number {
  if (state.winner !== null) return state.winner === seat ? 1 : -1;
  const other = (1 - seat) as Seat;
  return Math.tanh(weights.sharpness * (standing(state, seat, weights) - standing(state, other, weights)));
}

/**
 * A cheap rollout policy: mostly buy, sometimes anything.
 *
 * Uniform rollouts are close to useless in an engine-building game — two random players never build
 * an engine, so whatever advantage one side had never gets to cash out and the result is nearly
 * independent of the position being evaluated. Nudging toward purchases at least lets the engines
 * matter. It stays cheap and stays random enough not to be a fixed strategy the search can overfit.
 */
export function rolloutPreference(actions: readonly { t: string }[]): number[] {
  const buys: number[] = [];
  for (const [i, action] of actions.entries()) if (action.t === 'purchase') buys.push(i);
  return buys;
}
