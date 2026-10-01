import { z } from 'zod';
import type { Refusal } from './refusal.js';

/**
 * What the reader hands over: the page's full game state, as BGA built it for this seat.
 *
 * The shape follows `getAllDatas` in thoun/splendorduel. Only what the translation reads is listed;
 * zod drops the rest, which is most of it — BGA's framework adds a great deal that is none of our
 * business. What is listed is required: a snapshot missing any of it is refused whole, because a
 * half-read position is worse than none.
 */

/**
 * BGA sends database integers as strings in some places and numbers in others. Accept both, and
 * nothing else — `z.coerce.number()` would also turn `null`, `''` and `true` into numbers, which is
 * exactly the kind of quiet misreading this schema is here to prevent.
 */
const int = z.union([
  z.number().int(),
  z.string().regex(/^-?\d+$/).transform((s) => Number(s)),
]);

const zToken = z.object({
  id: int,
  location: z.string(),
  locationArg: int,
  /** 1 = gold, 2 = a coloured token. */
  type: int,
  color: int,
  /** Board tokens only. */
  row: int.nullish(),
  column: int.nullish(),
});

const zCard = z.object({
  id: int,
  location: z.string(),
  locationArg: int,
  level: int,
  /** Absent when BGA is not showing this seat the card's face. */
  index: int.nullish(),
});

const zRoyal = z.object({
  id: int,
  location: z.string(),
  locationArg: int,
  index: int,
});

const zPlayer = z.object({
  id: int,
  /** 1 once the game is won by this player. */
  score: int,
  /** 1 or 2, in turn order. */
  playerNo: int,
  privileges: int,
  tokens: z.array(zToken),
  cards: z.array(zCard),
  reserved: z.array(zCard),
  royalCards: z.array(zRoyal),
  endReasons: z.array(int).default([]),
});

const byLevel = <T extends z.ZodType>(item: T) => z.object({ 1: item, 2: item, 3: item });

export const zBgaSnapshot = z.object({
  tableId: z.string(),
  /** The logged-in player's id. */
  me: int,
  gamestate: z.object({
    name: z.string(),
    active_player: int.nullish(),
    args: z.unknown(),
  }),
  gamedatas: z.object({
    players: z.record(z.string(), zPlayer),
    board: z.array(zToken),
    cardDeckCount: byLevel(int),
    cardDeckTop: byLevel(zCard.nullable()),
    tableCards: byLevel(z.array(zCard)),
    /** The royals still on the table. */
    royalCards: z.array(zRoyal),
    expansion: z.boolean(),
  }),
});

export type BgaSnapshot = z.infer<typeof zBgaSnapshot>;
export type BgaPlayer = z.infer<typeof zPlayer>;
export type BgaToken = z.infer<typeof zToken>;
export type BgaCard = z.infer<typeof zCard>;
export type BgaRoyal = z.infer<typeof zRoyal>;

/** `argPlayAction`. `buyableCards` is a map by card id — which PHP sends as `[]` when it is empty. */
export const zPlayActionArgs = z.object({
  privileges: int,
  canRefill: z.boolean(),
  mustRefill: z.boolean(),
  canTakeTokens: z.boolean(),
  canReserve: z.boolean(),
  canBuyCard: z.boolean(),
  buyableCards: z.union([z.array(z.unknown()).max(0), z.record(z.string(), z.unknown())]),
});
export type PlayActionArgs = z.infer<typeof zPlayActionArgs>;

export function buyableIds(args: PlayActionArgs): number[] {
  if (Array.isArray(args.buyableCards)) return [];
  return Object.keys(args.buyableCards).map(Number).sort((a, b) => a - b);
}

/** `argTakeBoardToken`. */
export const zTakeBoardTokenArgs = z.object({ color: int, number: int });

/** `argDiscardTokens`. */
export const zDiscardArgs = z.object({ number: int });

export function parseSnapshot(raw: unknown): { ok: true; snapshot: BgaSnapshot } | { ok: false; refusal: Refusal } {
  const parsed = zBgaSnapshot.safeParse(raw);
  if (parsed.success) return { ok: true, snapshot: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return {
    ok: false,
    refusal: { reason: 'bad-snapshot', detail: `The page's game state is not the shape this adapter reads. ${issues}` },
  };
}
