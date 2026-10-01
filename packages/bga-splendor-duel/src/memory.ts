import { cardIdFromBga, royalIdFromBga } from './ids.js';
import type { BgaPlayer, BgaSnapshot } from './snapshot.js';

/**
 * The little that has to be carried from one snapshot to the next.
 *
 * A BGA snapshot is the whole position *as BGA shows it to this seat*, and that is nearly a
 * `SplendorView` — but three things our view states outright are, on BGA, only knowable by having
 * been watching:
 *
 *  - **Which of the opponent's reserved cards we saw.** BGA sends an opponent's reservation without
 *    its face even when it was taken from the table in front of us. But BGA's card ids are stable,
 *    so a reserved id we once saw face-up is a card we know. One never seen is `hidden`, which is
 *    less than we were entitled to in the rare case we were not looking, and never more.
 *  - **What we bought this turn.** At a discard it decides whether an extra turn follows, and BGA
 *    keeps that flag server-side. Comparing against what we owned when the turn began recovers it.
 *  - **Whether we replenished this turn.** Recoverable from BGA's arguments only while we hold a
 *    privilege; recognised here by the board growing between two of our own snapshots.
 *
 * Everything here is plain JSON, and everything is derived from snapshots — the same information
 * the page shows the operator. Nothing is read from BGA's notification stream, deliberately: that
 * stream carries cards this seat is not shown.
 */

export interface Summary {
  state: string;
  /** Is the logged-in player the one to act? */
  ours: boolean;
  boardCount: number;
  /** Both players' tokens, purchased cards, and reservation and royal counts. Not privileges. */
  holdings: string;
}

export interface Memory {
  /** BGA card id → our card id, for every jewel card this seat has seen face-up. */
  seen: Record<string, string>;
  /** What our seat owned at the start of its current turn. `null` until a turn has been seen start. */
  baseline: { cards: string[]; royals: string[] } | null;
  /** The last snapshot remembered, in brief. */
  prev: Summary | null;
  /** Whether our seat has replenished in the turn the last snapshot belongs to. */
  replenished: boolean;
}

export function emptyMemory(): Memory {
  return { seen: {}, baseline: null, prev: null, replenished: false };
}

export function ownedCards(player: BgaPlayer): string[] {
  return player.cards.flatMap((held) => {
    const id = held.index == null ? null : cardIdFromBga(held.level, held.index);
    return id ? [id] : [];
  });
}

export function ownedRoyals(player: BgaPlayer): string[] {
  return player.royalCards.flatMap((held) => {
    const id = royalIdFromBga(held.index);
    return id ? [id] : [];
  });
}

function holdingsOf(player: BgaPlayer): string {
  const tokens = player.tokens.map((t) => `${t.type}:${t.color}`).sort().join(',');
  const cards = player.cards.map((c) => c.id).sort((a, b) => a - b).join(',');
  return `${tokens}|${cards}|${player.reserved.length}|${player.royalCards.length}`;
}

export function summarise(snapshot: BgaSnapshot): Summary {
  const players = Object.values(snapshot.gamedatas.players).sort((a, b) => a.id - b.id);
  return {
    state: snapshot.gamestate.name,
    ours: snapshot.gamestate.active_player === snapshot.me,
    boardCount: snapshot.gamedatas.board.length,
    holdings: players.map(holdingsOf).join('/'),
  };
}

export function sameSummary(a: Summary, b: Summary): boolean {
  return a.state === b.state && a.ours === b.ours && a.boardCount === b.boardCount && a.holdings === b.holdings;
}

/**
 * Fold one snapshot into memory. Call it with every snapshot taken, before translating that
 * snapshot: `toView` reads `replenished` and `baseline` as facts about the snapshot it is given.
 */
export function remember(memory: Memory, snapshot: BgaSnapshot): Memory {
  const seen = { ...memory.seen };
  const note = (held: { id: number; level: number; index?: number | null }) => {
    if (held.index == null) return;
    const id = cardIdFromBga(held.level, held.index);
    if (id) seen[String(held.id)] = id;
  };
  for (const level of [1, 2, 3] as const) snapshot.gamedatas.tableCards[level].forEach(note);
  for (const player of Object.values(snapshot.gamedatas.players)) {
    player.cards.forEach(note);
    player.reserved.forEach(note);
  }

  const now = summarise(snapshot);
  // The same position again — a reload, a retry. Nothing happened, so nothing is concluded from it;
  // in particular a replenish already recognised must not be un-recognised by looking twice.
  if (memory.prev && sameSummary(memory.prev, now)) return { ...memory, seen };

  /*
   * The baseline is "what we owned before this turn's purchase". Our holdings cannot change on the
   * opponent's turn or before our mandatory action, so any snapshot taken then is a correct
   * baseline for the turn that follows. Once we are past the mandatory action — resolving an
   * ability, claiming a royal, discarding — the purchase is already in our holdings, so the
   * baseline is kept, not retaken.
   */
  const mine = Object.values(snapshot.gamedatas.players).find((p) => p.id === snapshot.me);
  const beforePurchase = !now.ours || now.state === 'playAction';
  const baseline =
    mine && beforePurchase ? { cards: ownedCards(mine), royals: ownedRoyals(mine) } : memory.baseline;

  /*
   * Our replenish, seen from outside: two consecutive snapshots of our own `playAction`, the board
   * fuller in the second, and nobody's tokens or cards different. An opponent's replenish cannot
   * look like this — their turn does not end until they have also taken, reserved or bought, which
   * changes their holdings. The flag then rides along through the rest of our turn.
   */
  const justReplenished =
    now.ours &&
    now.state === 'playAction' &&
    memory.prev !== null &&
    memory.prev.ours &&
    memory.prev.state === 'playAction' &&
    now.boardCount > memory.prev.boardCount &&
    now.holdings === memory.prev.holdings;
  const replenished = !now.ours ? false : now.state === 'playAction' ? justReplenished : memory.replenished;

  return { seen, baseline, prev: now, replenished };
}
