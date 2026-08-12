/**
 * What a bot opponent is, from both sides of the worker boundary.
 *
 * The bot is the network from the self-play loop, playing the same ISMCTS search the arena measured
 * it with, running in the player's own browser. It takes a real seat over a real socket: the server
 * has no idea it is a bot, which is why none of this needed a protocol change or a line in
 * `apps/server`. See `worker.ts`.
 */

/** Where `tools/selfplay/publish_bot.mjs` puts checkpoints, relative to the site root. */
export const BOT_BASE = '/bots/splendor-duel/gen3';

/** Only game with an encoder, a policy layout and a trained net. The rest have no bot to offer. */
export const BOT_GAME = 'splendor-duel';

export type BotLevelId = 'easy' | 'normal' | 'hard';

export interface BotLevel {
  id: BotLevelId;
  label: string;
  /**
   * Simulations per move. The only strength dial that matters here -- the network is the same at
   * every level, and a weaker *network* would mean shipping three of them.
   */
  iterations: number;
  /**
   * Sample the opening from the visit counts instead of taking the favourite, for this many moves.
   *
   * Not really a difficulty knob: it is there so the bot does not open identically every game. The
   * deal is random so games differ regardless, but the first few moves out of a fresh board are the
   * ones a player would otherwise watch it repeat. Higher on `easy` because varied play is also
   * weaker play, which is the direction that level wants anyway.
   */
  explore: { temperature: number; moves: number };
  /**
   * Floor on how long a move appears to take, in milliseconds.
   *
   * `easy` searches in about 50ms, and a reply that instant reads as "it did not think" rather than
   * "it thought quickly" -- and gives the player no beat to see what happened on the board. This is
   * presentation, not handicap: the search has already finished when the timer runs.
   */
  minThinkMs: number;
  blurb: string;
}

/**
 * Three points on one dial.
 *
 * Timings are one move at a mid-game position, measured on a Zen 4 workstation under node: 80
 * iterations ~50ms, 300 ~170ms, 1000 ~650ms. A browser is in the same neighbourhood, a phone is
 * slower, and all three are inside what a person waits for without noticing.
 *
 * `hard` is 1000 because that is the operating point everything about this network was measured at:
 * self-play generated its training data at 1000 iterations, the gate that promoted it ran at 1000,
 * and the 93% against the heuristic search in `bot.json` is a 1000-iteration number. Turning it up
 * further is untested rather than obviously stronger.
 */
export const BOT_LEVELS: readonly BotLevel[] = [
  {
    id: 'easy',
    label: 'Easy',
    iterations: 80,
    explore: { temperature: 1, moves: 20 },
    minThinkMs: 600,
    blurb: 'Looks a move or two ahead and plays loosely. A place to learn the rules.',
  },
  {
    id: 'normal',
    label: 'Normal',
    iterations: 300,
    explore: { temperature: 0.5, moves: 8 },
    minThinkMs: 400,
    blurb: 'Reads the board properly. Will punish a wasted turn.',
  },
  {
    id: 'hard',
    label: 'Hard',
    iterations: 1000,
    explore: { temperature: 0.3, moves: 4 },
    minThinkMs: 0,
    blurb: 'Full strength — the exact search the network was measured at.',
  },
];

export function levelById(id: BotLevelId): BotLevel {
  return BOT_LEVELS.find((level) => level.id === id) ?? (BOT_LEVELS[1] as BotLevel);
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
      level: BotLevel;
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
