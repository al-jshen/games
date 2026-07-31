import type { Seat } from '@games/engine';

/* ------------------------------------------------------------------ vocabulary */

export type GemColor = 'white' | 'blue' | 'green' | 'red' | 'black';
/** Anything a card cost can ask for. There are no pearl *bonuses*, so pearls are never discounted. */
export type PayColor = GemColor | 'pearl';
/** Anything that can sit on the board or in a player's pool. */
export type TokenColor = PayColor | 'gold';

export const GEM_COLORS: readonly GemColor[] = ['white', 'blue', 'green', 'red', 'black'];
export const PAY_COLORS: readonly PayColor[] = [...GEM_COLORS, 'pearl'];
export const TOKEN_COLORS: readonly TokenColor[] = [...PAY_COLORS, 'gold'];

/** The full bag at setup: 4 of each gem, 2 pearls, 3 gold = 25, exactly the number of board cells. */
export const TOKEN_SUPPLY: Readonly<Record<TokenColor, number>> = {
  white: 4,
  blue: 4,
  green: 4,
  red: 4,
  black: 4,
  pearl: 2,
  gold: 3,
};

export type Level = 1 | 2 | 3;
export const LEVELS: readonly Level[] = [1, 2, 3];
/** Face-up slots per level: the pyramid is 5 wide at level 1, 4 at level 2, 3 at level 3. */
export const PYRAMID_WIDTH: Readonly<Record<Level, number>> = { 1: 5, 2: 4, 3: 3 };

export const BOARD_CELLS = 25;
export const TOKEN_LIMIT = 10;
export const MAX_RESERVED = 3;
export const TOTAL_PRIVILEGES = 3;
export const CROWN_THRESHOLDS: readonly number[] = [3, 6];

export const WIN_PRESTIGE = 20;
export const WIN_CROWNS = 10;
export const WIN_COLOR_PRESTIGE = 10;

/* ------------------------------------------------------------------ cards */

export type Ability =
  /** "Take another turn immediately after this one ends." */
  | 'playAgain'
  /** "Take 1 token matching the color of this card from the board." Board only; skipped if none. */
  | 'takeMatchingToken'
  /** "Take 1 Gem or Pearl token from your opponent." Never gold. */
  | 'stealToken'
  /** "Take 1 Privilege." Falls back to taking one from the opponent. */
  | 'takePrivilege'
  /**
   * The "Associate" wild bonus. Not a resolvable effect but a purchase precondition plus a
   * permanent colour choice: the card stacks onto a colour you already own and counts as that
   * colour, including for the same-colour victory.
   */
  | 'wildBonus';

export interface CardDef {
  id: string;
  kind: 'jewel' | 'royal';
  /** 0 for royals. */
  level: number;
  name: string;
  points: number;
  crowns: number;
  /** `null` for wild cards (colour chosen on purchase) and for the 3 no-bonus prestige cards. */
  bonusColor: GemColor | null;
  /** 0 for the no-bonus cards, 2 for the five double-bonus level-2 cards, else 1. */
  bonusCount: number;
  wild: boolean;
  cost: Partial<Record<PayColor, number>>;
  abilities: Ability[];
}

/* ------------------------------------------------------------------ state */

/** Where a player's purchased cards live. One stack per bonus colour they own. */
export interface ColorStack {
  color: GemColor;
  /** Purchase order. Includes wild cards that were assigned to this colour. */
  cardIds: string[];
}

export interface PlayerState {
  tokens: Record<TokenColor, number>;
  privileges: number;
  /**
   * Reserved cards, with per-card knowledge rather than a blanket secret bucket: a card taken
   * from the face-up pyramid was legitimately seen by the opponent, while one drawn off a deck
   * was not. Same field, different visibility.
   */
  reserved: { cardId: string; publiclyKnown: boolean }[];
  stacks: ColorStack[];
  /** The 3 high-prestige cards with no bonus colour. They score, but toward the 20 only. */
  colorless: string[];
  royals: string[];
  /** How many crown thresholds have been crossed (0-2). Royals are one-shot per threshold. */
  royalsTaken: number;
}

/**
 * Where we are inside the current turn. The stages run in the rulebook's order and each may
 * pause for one player decision.
 */
export type Stage =
  /** Before the mandatory action: privileges and replenish are still available. */
  | 'optional'
  /** Resolving the abilities of the card just purchased. */
  | 'abilities'
  /** Checking whether a crown threshold was crossed. */
  | 'crowns'
  /** Discarding down to the 10-token limit. */
  | 'cleanup'
  /** Match finished. */
  | 'over';

/** A decision the current player must make before the turn can proceed. */
export type Pending =
  | { k: 'matchingToken'; color: GemColor; cardId: string }
  | { k: 'steal'; source: 'card' | 'royal'; cardId: string }
  | { k: 'royal' }
  | { k: 'discard'; count: number };

export interface SplendorOptions {
  /**
   * Non-official anti-stall rule, off by default.
   *
   * The official rules guarantee no termination: the publisher explicitly declined to add a draw
   * or turn limit, and a player who hoards the pearls and gold can loop forever. Set a positive
   * number of purchase-free turns to end such a match; useful for bot self-play.
   */
  maxTurnsWithoutPurchase?: number;
}

export interface SplendorState {
  readonly v: 1;
  /** SECRET. Implies every future shuffle; must never reach a client. */
  seed: string;
  /** SECRET-ish. Stripped in views alongside the seed. */
  rngCounter: number;
  options: SplendorOptions;

  /** SECRET *order*. The composition is public — players can legitimately count what was spent. */
  bag: TokenColor[];
  /** 25 cells, row-major. Public. */
  board: (TokenColor | null)[];
  /** SECRET order; the counts are public. */
  decks: Record<Level, string[]>;
  /** Face-up cards. `null` is a permanently empty slot (its deck ran out). Public. */
  pyramid: Record<Level, (string | null)[]>;
  /** 4 slots; `null` once claimed. Public. */
  royals: (string | null)[];
  /** Privileges above the board. Pool + both players always sums to 3. */
  privilegePool: number;

  players: [PlayerState, PlayerState];
  turn: Seat;
  stage: Stage;
  pending: Pending | null;
  /**
   * Abilities still to resolve, each tagged with the card that granted it. Drained before any
   * stage transition, so abilities added by a royal card resolve immediately too.
   */
  abilityQueue: { ability: Ability; cardId: string }[];
  /** Replenish is once per turn, and privileges may not be spent after it. */
  replenishedThisTurn: boolean;
  /** Pending extra turns from `playAgain`. Chains, so it is a counter rather than a flag. */
  extraTurns: number;
  /** Only used when `options.maxTurnsWithoutPurchase` is set. */
  turnsWithoutPurchase: number;
  boughtThisTurn: boolean;
  winner: Seat | null;
  winReason: string | null;
}

/* ------------------------------------------------------------------ actions */

export type CardRef =
  | { t: 'pyramid'; level: Level; slot: number }
  | { t: 'reserved'; cardId: string };

export type SplendorAction =
  /** Optional, repeatable: return 1 privilege, take 1 non-gold token from any cell. */
  | { t: 'usePrivilege'; cell: number }
  /** Optional, once per turn. Afterwards privileges are locked for the turn. */
  | { t: 'replenish' }
  /** Mandatory A. 1-3 cells forming an unbroken straight run of non-gold tokens. */
  | { t: 'takeTokens'; cells: number[] }
  /** Mandatory B. The only way to get gold. */
  | { t: 'reserve'; goldCell: number; from: { t: 'pyramid'; level: Level; slot: number } | { t: 'deck'; level: Level } }
  /** Mandatory C. `payment` must exactly cover the discounted cost; gold is wild. */
  | {
      t: 'purchase';
      from: CardRef;
      payment: Partial<Record<TokenColor, number>>;
      /** Required for wild cards: which colour stack this card joins, permanently. */
      wildColor?: GemColor;
    }
  | { t: 'chooseMatchingToken'; cell: number }
  | { t: 'chooseSteal'; color: PayColor }
  | { t: 'chooseRoyal'; royalId: string }
  | { t: 'discard'; tokens: Partial<Record<TokenColor, number>> }
  /**
   * End the turn without a mandatory action. Legal **only** when no mandatory action and no
   * replenish is possible — see `docs/splendor-duel-rules.md` for why that state is reachable and
   * why the official rules do not cover it.
   */
  | { t: 'pass' };

export type SplendorActionType = SplendorAction['t'];

/* ------------------------------------------------------------------ view */

/** Opponent reservations are either publicly known or an opaque placeholder that preserves count. */
export type ReservedView = { cardId: string } | { hidden: true };

export interface PlayerView {
  seat: Seat;
  tokens: Record<TokenColor, number>;
  tokenTotal: number;
  privileges: number;
  reserved: ReservedView[];
  stacks: ColorStack[];
  colorless: string[];
  royals: string[];
  royalsTaken: number;
  /** Derived, but sent so clients and bots never disagree with the server about score. */
  points: number;
  crowns: number;
  bonuses: Record<GemColor, number>;
  colorPoints: Record<GemColor, number>;
}

export interface SplendorView {
  readonly v: 1;
  /** `null` for a spectator. */
  you: Seat | null;
  /** Composition only — never the order. */
  bag: { counts: Record<TokenColor, number>; total: number };
  board: (TokenColor | null)[];
  decks: Record<Level, number>;
  pyramid: Record<Level, (string | null)[]>;
  royals: (string | null)[];
  privilegePool: number;
  players: [PlayerView, PlayerView];
  turn: Seat;
  stage: Stage;
  pending: Pending | null;
  extraTurns: number;
  /**
   * Public turn bookkeeping. All of it is information both players legitimately have, and all of it
   * is load-bearing: without `replenishedThisTurn` a client cannot tell that privileges are locked
   * for the rest of the turn, and would offer a move the server will refuse.
   */
  replenishedThisTurn: boolean;
  abilityQueue: { ability: Ability; cardId: string }[];
  turnsWithoutPurchase: number;
  boughtThisTurn: boolean;
  options: SplendorOptions;
  winner: Seat | null;
  winReason: string | null;
}
