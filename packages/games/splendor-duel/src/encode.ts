import { tryCard } from './cards.js';
import type { CardDef, GemColor, PayColor, SplendorView, TokenColor } from './types.js';
import {
  GEM_COLORS,
  LEVELS,
  PAY_COLORS,
  TOKEN_COLORS,
  TOKEN_LIMIT,
  WIN_COLOR_PRESTIGE,
  WIN_CROWNS,
  WIN_PRESTIGE,
} from './types.js';

/**
 * A position as a fixed-length vector of numbers.
 *
 * This is half the contract between the game and anything that learns from it. The encoder lives
 * here, on the Node side, so that a trainer never has to know what a pyramid or a privilege scroll
 * is — by the time data reaches it, a position is an array of floats. That is what lets the rules
 * stay in one language and one implementation.
 *
 * Two decisions worth stating, because they are the ones that would be awkward to change later.
 *
 * **It encodes the view, not the state.** The input is a `SplendorView`, so a network structurally
 * cannot be trained on information the player could not see. Feeding it truth would produce an agent
 * that plays superbly in training and badly in a real game, and nothing would flag it.
 *
 * **Cards are encoded by their properties, not their identity.** A 67-way one-hot per slot would
 * force the network to learn each card separately, and there are only sixty-seven of them to learn
 * from. Encoding level, prestige, crowns, bonus and cost instead lets it generalise — "a three-point
 * blue card costing five red" is a thing it can understand without having seen that exact card.
 *
 * The layout is fixed and documented below. Anything reading these vectors depends on it, so adding a
 * field means appending, never inserting.
 */

/** Everything that describes one card slot, including whether it is occupied at all. */
const CARD_WIDTH = 3 /* level */ + 1 /* points */ + 1 /* crowns */ + 7 /* bonus */ + 5 /* abilities */ + 6 /* cost */ + 1; /* present */
const PYRAMID_SLOTS = 5 + 4 + 3;
const RESERVE_SLOTS = 3;
const ROYAL_WIDTH = 1 /* points */ + 4 /* abilities */ + 1; /* present */
const PLAYER_WIDTH =
  TOKEN_COLORS.length + GEM_COLORS.length + GEM_COLORS.length + 5 + RESERVE_SLOTS * CARD_WIDTH + 1;

/** Total length of an encoded position. Assert against this when loading weights. */
export const FEATURE_SIZE =
  25 * 8 /* board */ +
  1 /* bag */ +
  LEVELS.length /* deck counts */ +
  PYRAMID_SLOTS * CARD_WIDTH +
  4 * ROYAL_WIDTH +
  1 /* privilege pool */ +
  2 * PLAYER_WIDTH +
  12; /* turn and stage flags */

const ABILITIES = ['playAgain', 'takeMatchingToken', 'stealToken', 'takePrivilege', 'wildBonus'] as const;
const STAGES = ['optional', 'abilities', 'crowns', 'cleanup'] as const;
const PENDING = ['matchingToken', 'steal', 'royal', 'discard'] as const;

/**
 * Encode a position from the point of view of `seat`.
 *
 * Always written "me first, them second" rather than "seat 0 first". Otherwise the network has to
 * learn each position twice, once from each chair, from half as many examples of each.
 */
export function encodeView(view: SplendorView, seat: 0 | 1): Float32Array {
  const out = new Float32Array(FEATURE_SIZE);
  let at = 0;
  const put = (value: number) => {
    out[at++] = value;
  };
  const oneHot = (index: number, size: number) => {
    for (let i = 0; i < size; i++) out[at++] = i === index ? 1 : 0;
  };

  // Board: one slot per cell, one channel per token colour plus empty.
  for (const token of view.board) {
    oneHot(token === null ? 0 : TOKEN_COLORS.indexOf(token) + 1, 8);
  }

  put(view.bag.total / 25);
  for (const level of LEVELS) put(view.decks[level] / 25);

  for (const level of LEVELS) {
    for (let slot = 0; slot < view.pyramid[level].length; slot++) {
      at = putCard(out, at, view.pyramid[level][slot] ?? null);
    }
  }

  for (const royalId of view.royals) {
    const def = royalId ? tryCard(royalId) : undefined;
    put(def ? def.points / 3 : 0);
    for (const ability of ABILITIES.slice(0, 4)) put(def?.abilities.includes(ability) ? 1 : 0);
    put(def ? 1 : 0);
  }

  put(view.privilegePool / 3);

  at = putPlayer(out, at, view.players[seat], true);
  at = putPlayer(out, at, view.players[(1 - seat) as 0 | 1], false);

  // Whose turn, where in the turn, and the handful of flags the rules key off.
  put(view.turn === seat ? 1 : 0);
  for (let i = 0; i < STAGES.length; i++) out[at++] = STAGES[i] === view.stage ? 1 : 0;
  const pendingKind = view.pending?.k ?? null;
  for (let i = 0; i < PENDING.length; i++) out[at++] = PENDING[i] === pendingKind ? 1 : 0;
  put(view.replenishedThisTurn ? 1 : 0);
  put(Math.min(1, view.extraTurns / 2));
  put(view.boughtThisTurn ? 1 : 0);

  if (at !== FEATURE_SIZE) {
    throw new Error(`encodeView wrote ${at} of ${FEATURE_SIZE} features`);
  }
  return out;
}

/** One card slot: empty leaves every channel at zero, which the `present` flag disambiguates. */
function putCard(out: Float32Array, at: number, cardId: string | null): number {
  const def: CardDef | undefined = cardId ? tryCard(cardId) : undefined;
  if (!def) return at + CARD_WIDTH;

  for (const level of LEVELS) out[at++] = def.level === level ? 1 : 0;
  out[at++] = def.points / 5;
  out[at++] = def.crowns / 3;
  for (const color of GEM_COLORS) out[at++] = def.bonusColor === color ? 1 : 0;
  out[at++] = def.wild ? 1 : 0;
  out[at++] = def.bonusCount / 2;
  for (const ability of ABILITIES) out[at++] = def.abilities.includes(ability) ? 1 : 0;
  for (const color of PAY_COLORS) out[at++] = (def.cost[color as PayColor] ?? 0) / 8;
  out[at++] = 1;
  return at;
}

/**
 * One player. `mine` decides how reservations are written: your own are cards you can see, theirs are
 * a count of face-down slots, which is all the view gives you and all you are entitled to.
 */
function putPlayer(
  out: Float32Array,
  at: number,
  player: SplendorView['players'][number],
  mine: boolean,
): number {
  for (const color of TOKEN_COLORS) out[at++] = player.tokens[color as TokenColor] / TOKEN_LIMIT;
  for (const color of GEM_COLORS) out[at++] = player.bonuses[color as GemColor] / 8;
  for (const color of GEM_COLORS) out[at++] = player.colorPoints[color as GemColor] / WIN_COLOR_PRESTIGE;
  out[at++] = player.points / WIN_PRESTIGE;
  out[at++] = player.crowns / WIN_CROWNS;
  out[at++] = player.privileges / 3;
  out[at++] = player.tokenTotal / TOKEN_LIMIT;
  out[at++] = player.royalsTaken / 2;

  for (let slot = 0; slot < RESERVE_SLOTS; slot++) {
    const held = player.reserved[slot];
    if (!held) {
      at += CARD_WIDTH;
    } else if ('cardId' in held && mine) {
      at = putCard(out, at, held.cardId);
    } else if ('cardId' in held) {
      // Theirs, but taken from the face-up pyramid, so both players saw it.
      at = putCard(out, at, held.cardId);
    } else {
      // Face-down. Only the fact that a slot is occupied is known, so only that is encoded.
      at += CARD_WIDTH - 1;
      out[at++] = 1;
    }
  }
  out[at++] = player.reserved.length / RESERVE_SLOTS;
  return at;
}

/** For a shape assertion when loading weights, and for the sidecar written beside a dataset. */
export const FEATURE_LAYOUT = {
  size: FEATURE_SIZE,
  cardWidth: CARD_WIDTH,
  pyramidSlots: PYRAMID_SLOTS,
  reserveSlots: RESERVE_SLOTS,
  playerWidth: PLAYER_WIDTH,
} as const;

