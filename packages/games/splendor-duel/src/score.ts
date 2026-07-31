import { card } from './cards.js';
import type { GemColor, PayColor, PlayerState, TokenColor } from './types.js';
import { GEM_COLORS, TOKEN_COLORS, WIN_COLOR_PRESTIGE, WIN_CROWNS, WIN_PRESTIGE } from './types.js';

export function emptyTokens(): Record<TokenColor, number> {
  return { white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0, gold: 0 };
}

export function emptyGems<T>(fill: T): Record<GemColor, T> {
  return { white: fill, blue: fill, green: fill, red: fill, black: fill };
}

export function tokenTotal(tokens: Record<TokenColor, number>): number {
  return TOKEN_COLORS.reduce((t, c) => t + tokens[c], 0);
}

/** All jewel cards a player has purchased, across colour stacks and the colourless pile. */
export function purchasedJewels(player: PlayerState): string[] {
  return [...player.stacks.flatMap((s) => s.cardIds), ...player.colorless];
}

/**
 * Per-colour bonus counts, i.e. the discount applied to future purchases.
 *
 * A wild card contributes exactly 1 to the colour it was assigned, even when it is stacked on a
 * double-bonus card. There are no pearl bonuses, so pearl costs can never be discounted.
 */
export function bonuses(player: PlayerState): Record<GemColor, number> {
  const out = emptyGems(0);
  for (const stack of player.stacks) {
    for (const id of stack.cardIds) {
      out[stack.color] += card(id).bonusCount;
    }
  }
  return out;
}

/** Prestige grouped by bonus colour — the basis of the same-colour victory. */
export function colorPoints(player: PlayerState): Record<GemColor, number> {
  const out = emptyGems(0);
  for (const stack of player.stacks) {
    for (const id of stack.cardIds) {
      out[stack.color] += card(id).points;
    }
  }
  return out;
}

/** Total prestige: jewel cards plus royal cards. Reserved cards are inert and score nothing. */
export function totalPoints(player: PlayerState): number {
  let total = 0;
  for (const id of purchasedJewels(player)) total += card(id).points;
  for (const id of player.royals) total += card(id).points;
  return total;
}

/** Crowns come only from jewel cards; royals grant none. */
export function totalCrowns(player: PlayerState): number {
  let total = 0;
  for (const id of purchasedJewels(player)) total += card(id).crowns;
  return total;
}

/**
 * The cost of a card after this player's bonuses, per colour.
 *
 * Discounts are compulsory and floor at zero — excess bonuses never generate tokens, and a player
 * cannot decline a discount in order to shed unwanted tokens.
 */
export function effectiveCost(
  player: PlayerState,
  cardId: string,
): Partial<Record<PayColor, number>> {
  const def = card(cardId);
  const discount = bonuses(player);
  const out: Partial<Record<PayColor, number>> = {};
  for (const [colorRaw, amountRaw] of Object.entries(def.cost)) {
    const color = colorRaw as PayColor;
    const amount = amountRaw ?? 0;
    // Pearls have no corresponding bonus, so they are never reduced.
    const reduced = color === 'pearl' ? amount : Math.max(0, amount - discount[color]);
    if (reduced > 0) out[color] = reduced;
  }
  return out;
}

export function costTotal(cost: Partial<Record<PayColor, number>>): number {
  return Object.values(cost).reduce((t, n) => t + (n ?? 0), 0);
}

/**
 * The cheapest way for `player` to pay `cost`: spend matching tokens first, cover the rest with
 * gold. Returns `null` when they cannot afford it at all.
 */
export function minimalPayment(
  player: PlayerState,
  cost: Partial<Record<PayColor, number>>,
): Partial<Record<TokenColor, number>> | null {
  const payment: Partial<Record<TokenColor, number>> = {};
  let goldNeeded = 0;
  for (const [colorRaw, amountRaw] of Object.entries(cost)) {
    const color = colorRaw as PayColor;
    const amount = amountRaw ?? 0;
    const own = Math.min(player.tokens[color], amount);
    if (own > 0) payment[color] = own;
    goldNeeded += amount - own;
  }
  if (goldNeeded > player.tokens.gold) return null;
  if (goldNeeded > 0) payment.gold = goldNeeded;
  return payment;
}

export type VictoryReason = 'prestige' | 'crowns' | 'color';

/**
 * Which victory condition this player meets, if any.
 *
 * Checked only at the end of that player's own turn, after the discard. There is no equalising
 * turn and no draw: points and crowns are only ever gained on your own turn, and the match stops
 * the moment a condition holds.
 */
export function victoryFor(player: PlayerState): VictoryReason | null {
  if (totalPoints(player) >= WIN_PRESTIGE) return 'prestige';
  if (totalCrowns(player) >= WIN_CROWNS) return 'crowns';
  const perColor = colorPoints(player);
  if (GEM_COLORS.some((c) => perColor[c] >= WIN_COLOR_PRESTIGE)) return 'color';
  return null;
}
