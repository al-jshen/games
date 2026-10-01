import type { TokenColor } from '@games/splendor-duel';
import { cardIdFromBga, cellFromBga, royalIdFromBga, tokenColorFromBga } from './ids.js';
import type { BgaPlayer, BgaSnapshot, BgaToken } from './snapshot.js';

/**
 * Where everything our actions name actually is on the BGA table.
 *
 * Our actions talk about positions and kinds — "cell 7", "two blue", "the card in level 2, slot 1".
 * BGA's talk about individual objects by database id. This is the index between them, built once
 * per snapshot, and it is what both the instructions for a person and the calls for the page are
 * written from, so the two cannot point at different things.
 *
 * It assumes a snapshot `toView` has already accepted, and skips anything it cannot name rather
 * than complaining twice about it.
 */
export interface Located {
  /** Our cell → the BGA token sitting on it. */
  boardToken: Map<number, BgaToken>;
  /** The BGA ids of the tokens we hold, by colour, lowest id first. */
  myTokens: Record<TokenColor, number[]>;
  theirTokens: Record<TokenColor, number[]>;
  /** Our card id → BGA's, for the cards we can act on: the table and our own reservations. */
  cardBgaId: Map<string, number>;
  ourCardId: Map<number, string>;
  /** The royals still on the table. */
  royalBgaId: Map<string, number>;
  /** BGA's id for the top card of each deck — what "reserve from the deck" has to name. */
  deckTop: Record<1 | 2 | 3, number | null>;
}

function byColor(player: BgaPlayer | undefined): Record<TokenColor, number[]> {
  const out: Record<TokenColor, number[]> = { white: [], blue: [], green: [], red: [], black: [], pearl: [], gold: [] };
  for (const token of player?.tokens ?? []) {
    const color = tokenColorFromBga(token);
    if (color) out[color].push(token.id);
  }
  for (const ids of Object.values(out)) ids.sort((a, b) => a - b);
  return out;
}

export function locate(snapshot: BgaSnapshot): Located {
  const { gamedatas } = snapshot;
  const players = Object.values(gamedatas.players);
  const mine = players.find((p) => p.id === snapshot.me);
  const theirs = players.find((p) => p.id !== snapshot.me);

  const boardToken = new Map<number, BgaToken>();
  for (const token of gamedatas.board) {
    const cell = cellFromBga(token.locationArg);
    if (cell !== null) boardToken.set(cell, token);
  }

  const cardBgaId = new Map<string, number>();
  const ourCardId = new Map<number, string>();
  const note = (held: { id: number; level: number; index?: number | null }) => {
    const id = held.index == null ? null : cardIdFromBga(held.level, held.index);
    if (!id) return;
    cardBgaId.set(id, held.id);
    ourCardId.set(held.id, id);
  };
  for (const level of [1, 2, 3] as const) gamedatas.tableCards[level].forEach(note);
  mine?.reserved.forEach(note);

  const royalBgaId = new Map<string, number>();
  for (const held of gamedatas.royalCards) {
    const id = royalIdFromBga(held.index);
    if (id) royalBgaId.set(id, held.id);
  }

  return {
    boardToken,
    myTokens: byColor(mine),
    theirTokens: byColor(theirs),
    cardBgaId,
    ourCardId,
    royalBgaId,
    deckTop: {
      1: gamedatas.cardDeckTop[1]?.id ?? null,
      2: gamedatas.cardDeckTop[2]?.id ?? null,
      3: gamedatas.cardDeckTop[3]?.id ?? null,
    },
  };
}
