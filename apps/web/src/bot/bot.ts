/**
 * What a bot opponent is, from both sides of the worker boundary.
 *
 * The bot is the network from the self-play loop, playing the same ISMCTS search the arena measured
 * it with, running in the player's own browser. It takes a real seat over a real socket: the server
 * has no idea it is a bot, which is why none of this needed a protocol change or a line in
 * `apps/server`. See `worker.ts`.
 */

/**
 * Where `tools/selfplay/publish_bot.mjs` puts the reigning checkpoints, relative to the site root.
 *
 * Deliberately not named after a generation. Promoting gen4 is `publish_bot.mjs --generation 4` and
 * nothing else; which generation is sitting here is recorded in `bot.json` and read at runtime, so
 * this constant never has to be kept in step with anything.
 */
export const BOT_BASE = '/bots/splendor-duel/current';

/** Only game with an encoder, a policy layout and a trained net. The rest have no bot to offer. */
export const BOT_GAME = 'splendor-duel';

/**
 * Simulations per move: the strength dial, and the only one.
 *
 * The network is the same whatever you pick -- a weaker *network* would mean shipping several -- so
 * strength here is entirely how long the search gets to think. It was three named levels, and a
 * continuous dial is both more honest and more useful: the thing being chosen really is a number,
 * and where a player wants to sit on it depends on how strong they are and how long they are willing
 * to wait, neither of which three labels can guess.
 *
 * 1000 is the default because it is the operating point every measurement of this network was taken
 * at -- self-play generated its training data there, the gate that promoted it ran there, and the
 * "beats the heuristic search" figure in `bot.json` is a 1000-iteration number.
 *
 * **Above it is measured, and the top of the range is a great deal stronger.** gen11 at 5000 beat
 * gen11 at 1000 over 400 games: 274-126, 68.5%, +135 elo [98, 172]. For scale, a whole generation
 * of the self-play loop is worth about twelve. Five times the thinking buys more than eleven
 * generations of training did, which says the search is nowhere near saturated at its own operating
 * point -- and, read the other way, that the loop writes its training targets with a searcher much
 * weaker than the hardware it runs on could afford.
 */
export const MIN_ITERATIONS = 100;
export const MAX_ITERATIONS = 5000;
export const DEFAULT_ITERATIONS = 1000;
/** One click of the slider. 50 stops is finer than anyone can perceive the difference between. */
export const ITERATION_STEP = 100;

export function clampIterations(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ITERATIONS;
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, Math.round(value)));
}

/**
 * How long one move takes, in milliseconds.
 *
 * Measured on a Zen 4 workstation under node, against the shipped checkpoints at full-depth PUCT:
 * 100 iterations 0.07s, 300 0.19s, 1000 0.70s, 2000 1.40s, 3000 2.08s, 5000 3.46s. Dead linear at
 * ~0.7ms an iteration, which is what you would expect when every iteration is one forward pass of
 * the value head plus one of the policy head.
 *
 * A browser is in the same neighbourhood and a phone is slower, so this is a floor rather than a
 * promise -- which is why the UI shows it as "about". Worth showing at all because the top of the
 * range is genuinely slow: 5000 is several seconds a move, and a player should choose that on
 * purpose rather than discover it.
 */
export function estimateMs(iterations: number): number {
  return iterations * 0.7;
}

/**
 * Sample the opening from the visit counts instead of taking the favourite, for this many moves.
 *
 * Mostly so the bot does not open identically every game. The deal is random so games differ
 * regardless, but the first few moves out of a fresh board are the ones a player would otherwise
 * watch it repeat.
 *
 * Interpolated on log(iterations) rather than held constant, because sampling is also a handicap:
 * at the bottom of the range, where somebody has deliberately asked for a weaker opponent, playing
 * loosely for the first twenty moves is the direction they were already going. At the top it backs
 * off to a token amount, enough for variety and not enough to throw a game.
 */
export function exploreFor(iterations: number): { temperature: number; moves: number } {
  const span = Math.log(MAX_ITERATIONS / MIN_ITERATIONS);
  const t = Math.min(1, Math.max(0, Math.log(clampIterations(iterations) / MIN_ITERATIONS) / span));
  return { temperature: 1 - 0.7 * t, moves: Math.round(20 - 16 * t) };
}

/**
 * Floor on how long a move appears to take, in milliseconds.
 *
 * At 100 iterations the search finishes in about 70ms, and a reply that instant reads as "it did not
 * think" rather than "it thought quickly" -- it also gives the player no beat to see what just
 * happened on the board. So the *perceived* move time never drops below half a second. This is
 * presentation, not handicap: the search has already finished before the timer starts, and above
 * roughly 700 iterations it does nothing at all.
 */
export function minThinkMsFor(iterations: number): number {
  return Math.max(0, 500 - estimateMs(iterations));
}

/** A short word for where the slider is sitting. Bands are wide; only the top one carries a number. */
export function describeStrength(iterations: number): string {
  if (iterations < 250) return 'Casual — reads a move or two ahead';
  if (iterations < 700) return 'Steady — will punish a wasted turn';
  if (iterations <= 1200) return 'Full strength — the loop’s own operating point';
  if (iterations <= 3000) return 'Beyond how the loop plays — measurably stronger';
  return 'Strongest — +135 elo over 1000, at several seconds a move';
}

/** `bot.json`, written by `publish_bot.mjs`. Only the parts the UI shows are typed. */
export interface BotManifest {
  id: string;
  generation: number;
  published: string;
  value: { parameters: number };
  policy: { parameters: number };
  measured?: {
    gate: number | null;
    baseline?: Record<string, number> | null;
  };
}

/* --------------------------------------------------------------- worker protocol */

export type ToBot =
  | {
      t: 'start';
      url: string;
      code: string;
      name: string;
      base: string;
      /** Simulations per move. Everything else the bot does is derived from it. */
      iterations: number;
      /** The bot's own seat token, when it has played here before. Null takes a fresh seat. */
      token: string | null;
      /** Seeds the search, so a reload does not replay the same game move for move. */
      seed: string;
    }
  | { t: 'stop' };

export type FromBot =
  /** The checkpoints are loaded; the socket is about to open. */
  | { t: 'ready' }
  /** A seat token worth keeping, so a reload can put the bot back in the same seat. */
  | { t: 'token'; code: string; token: string }
  /** Between `true` and `false` the worker is inside a search and will not answer anything. */
  | { t: 'thinking'; on: boolean }
  /** The bot followed a rematch into a new room and holds a seat there. */
  | { t: 'rematch'; code: string; token: string }
  | { t: 'error'; message: string };

/* --------------------------------------------------------------- the coach */

/**
 * How hard the coach reads before answering, and how it is described.
 *
 * Lower than the levels the bot plays at, on purpose. The coach runs on *every* position including
 * your opponent's, so it is asked three or four times as often as an opponent would be, and it is
 * answering while somebody is waiting to move. `deep` is there for when you want to stop and study a
 * position rather than keep the game going.
 */
export const COACH_DEPTHS = [
  { id: 'quick', label: 'Quick', iterations: 150 },
  { id: 'deep', label: 'Deep', iterations: 600 },
] as const;

export type CoachDepthId = (typeof COACH_DEPTHS)[number]['id'];

export function coachIterations(depth: CoachDepthId): number {
  return COACH_DEPTHS.find((d) => d.id === depth)?.iterations ?? 150;
}

export type ToCoach =
  | { t: 'load'; base: string }
  /**
   * A position to look at. `seat` is whose side to report from, which is always the person asking --
   * an evaluation that flipped sign depending on whose turn it was would be unreadable.
   *
   * `yourTurn` decides whether moves are suggested at all. The evaluation is wanted on both turns;
   * a list of moves you cannot play is noise, and worse, it is a list of moves for your *opponent*
   * that you are not entitled to reason about from the position they can see.
   */
  | { t: 'look'; id: number; view: unknown; seat: number; yourTurn: boolean; iterations: number };

export interface CoachMove {
  /** Already in the game's own words -- the worker cannot render, but it can name. */
  text: string;
  /** Share of the search's visits. The search's confidence, not the network's. */
  visits: number;
  /** The policy head's prior on this move, before any search. */
  prior: number;
  /** What the search thinks the position is worth after playing it, from your seat. */
  value: number;
}

export type FromCoach =
  | { t: 'ready' }
  | {
      t: 'read';
      id: number;
      /** The value head alone, in [-1, 1] from your seat. One forward pass, no search. */
      staticValue: number;
      /** The same head averaged over the search tree. Better, and slower. */
      searchValue: number;
      /** Best first. Empty when it is not your turn. */
      moves: CoachMove[];
      /** The policy head's own favourite, before search. Null when it is not your turn. */
      instinct: string | null;
      /** How long the search took, so the UI can be honest about why it is behind. */
      ms: number;
    }
  | { t: 'error'; message: string };
