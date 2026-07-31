import { CARD_DEFS } from './cards.generated.js';
import type { CardDef, Level, PayColor } from './types.js';
import { LEVELS } from './types.js';

const BY_ID = new Map<string, CardDef>(CARD_DEFS.map((c) => [c.id, c]));

export { CARD_DEFS };

export function card(id: string): CardDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`unknown card id: ${id}`);
  return def;
}

export function tryCard(id: string): CardDef | undefined {
  return BY_ID.get(id);
}

/** All jewel cards of a level, in a stable order. The shuffle is the reducer's job. */
export function jewelDeck(level: Level): string[] {
  return CARD_DEFS.filter((c) => c.kind === 'jewel' && c.level === level).map((c) => c.id);
}

export function royalIds(): string[] {
  return CARD_DEFS.filter((c) => c.kind === 'royal').map((c) => c.id);
}

export const ALL_JEWEL_IDS: readonly string[] = LEVELS.flatMap((l) => jewelDeck(l));
export const ALL_ROYAL_IDS: readonly string[] = royalIds();

export function costEntries(def: CardDef): [PayColor, number][] {
  return Object.entries(def.cost) as [PayColor, number][];
}

export function totalCost(def: CardDef): number {
  return Object.values(def.cost).reduce((t, n) => t + (n ?? 0), 0);
}
