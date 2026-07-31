import { RandomCursor, type Seat } from '@games/engine';
import { jewelDeck, royalIds } from './cards.js';
import { SPIRAL } from './spiral.js';
import { emptyTokens } from './score.js';
import type { Level, PlayerState, SplendorOptions, SplendorState, TokenColor } from './types.js';
import { BOARD_CELLS, LEVELS, PYRAMID_WIDTH, TOKEN_SUPPLY, TOKEN_COLORS, TOTAL_PRIVILEGES } from './types.js';

function emptyPlayer(): PlayerState {
  return {
    tokens: emptyTokens(),
    privileges: 0,
    reserved: [],
    stacks: [],
    colorless: [],
    royals: [],
    royalsTaken: 0,
  };
}

/** One entry per physical token: 4 of each gem, 2 pearls, 3 gold. */
function fullTokenSupply(): TokenColor[] {
  const out: TokenColor[] = [];
  for (const color of TOKEN_COLORS) {
    for (let i = 0; i < TOKEN_SUPPLY[color]; i++) out.push(color);
  }
  return out;
}

export function setup(ctx: { seed: string; seats: Seat[]; options: SplendorOptions }): SplendorState {
  if (ctx.seats.length !== 2) {
    throw new Error(`splendor-duel is a 2-player game, got ${ctx.seats.length} seats`);
  }
  const rng = new RandomCursor(ctx.seed, 0);

  const decks = {} as Record<Level, string[]>;
  const pyramid = {} as Record<Level, (string | null)[]>;
  for (const level of LEVELS) {
    const shuffled = rng.shuffle(jewelDeck(level));
    // Reveal the face-up row for this level; the rest stays as the deck.
    pyramid[level] = shuffled.slice(0, PYRAMID_WIDTH[level]);
    decks[level] = shuffled.slice(PYRAMID_WIDTH[level]);
  }

  // All 25 tokens start on the board, so the bag begins EMPTY and replenish is impossible until
  // tokens return to it via purchases or the end-of-turn discard.
  const board: (TokenColor | null)[] = new Array<TokenColor | null>(BOARD_CELLS).fill(null);
  const tokens = rng.shuffle(fullTokenSupply());
  SPIRAL.forEach((cell, i) => {
    board[cell] = tokens[i] ?? null;
  });

  const royals = rng.shuffle(royalIds());

  // First player is random; their opponent is compensated with 1 privilege.
  const first = rng.int(2) as Seat;
  const second = (1 - first) as Seat;
  const players: [PlayerState, PlayerState] = [emptyPlayer(), emptyPlayer()];
  const secondPlayer = players[second];
  if (secondPlayer) secondPlayer.privileges = 1;

  return {
    v: 1,
    seed: ctx.seed,
    rngCounter: rng.counter,
    options: { ...ctx.options },
    bag: [],
    board,
    decks,
    pyramid,
    royals,
    privilegePool: TOTAL_PRIVILEGES - 1,
    players,
    turn: first,
    stage: 'optional',
    pending: null,
    abilityQueue: [],
    replenishedThisTurn: false,
    extraTurns: 0,
    turnsWithoutPurchase: 0,
    boughtThisTurn: false,
    winner: null,
    winReason: null,
  };
}
