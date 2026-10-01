import { RandomCursor } from '@games/engine';
import {
  BOARD_CELLS,
  GEM_COLORS,
  LEVELS,
  PYRAMID_WIDTH,
  TOKEN_LIMIT,
  TOTAL_PRIVILEGES,
  bonuses,
  card,
  colorPoints,
  determinize,
  emptyTokens,
  tokenTotal,
  totalCrowns,
  totalPoints,
  type Ability,
  type GemColor,
  type Level,
  type Pending,
  type PlayerState,
  type PlayerView,
  type ReservedView,
  type SplendorView,
  type Stage,
  type TokenColor,
} from '@games/splendor-duel';
import type { z } from 'zod';
import { BGA_COLORLESS, cardIdFromBga, cellFromBga, gemFromBga, royalIdFromBga, tokenColorFromBga } from './ids.js';
import { sameSummary, summarise, type Memory } from './memory.js';
import type { Refusal, RefusalReason } from './refusal.js';
import {
  zDiscardArgs,
  zPlayActionArgs,
  zTakeBoardTokenArgs,
  type BgaCard,
  type BgaPlayer,
  type BgaSnapshot,
} from './snapshot.js';
import { stateKind } from './states.js';

/**
 * A BGA snapshot, as the position our bot understands.
 *
 * The output is a `SplendorView` for the logged-in seat — the type `determinize` and `encodeView`
 * take — so the search and the network run on a BGA game exactly as they do on one of ours, with
 * nothing in either of them knowing the difference.
 *
 * The translation is strict. It has no fallbacks for things it does not recognise, because a
 * fallback here would be a guess about the position, and a bot that plays a guessed position plays
 * moves nobody chose. Anything unrecognised is a `Refusal`. The few places where something has to be
 * *assumed* rather than read — the adapter was started mid-turn, so there is no memory of how the
 * turn began — are returned as `warnings` and shown to the operator.
 */

export interface Translation {
  view: SplendorView;
  seat: 0 | 1;
  /** What had to be assumed rather than read. Never empty silently: the caller shows these. */
  warnings: string[];
}

export type ToViewResult = ({ ok: true } & Translation) | { ok: false; refusal: Refusal };

class Stop extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.detail);
  }
}

function stop(reason: RefusalReason, detail: string): never {
  throw new Stop({ reason, detail });
}

export interface ToViewOptions {
  /**
   * The snapshot is a spectator's, moved to this seat with `asSeat`.
   *
   * A spectator is shown no reservation's face, the mover's included. So the seat's own unseen
   * reservations are hidden in the view, exactly as an opponent's are, and the view is what the
   * player to move could be said to know as far as an onlooker can tell. Without this, a seat's own
   * reservation arriving faceless is a refusal: for a seated account it means the page is not what
   * we think it is.
   */
  spectating?: boolean;
}

export function toView(snapshot: BgaSnapshot, memory: Memory, options: ToViewOptions = {}): ToViewResult {
  if (!memory.prev || !sameSummary(memory.prev, summarise(snapshot))) {
    throw new Error('toView: call remember(memory, snapshot) with this snapshot first');
  }
  try {
    return { ok: true, ...translate(snapshot, memory, options.spectating === true) };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

function seatOf(player: BgaPlayer): 0 | 1 {
  if (player.playerNo === 1) return 0;
  if (player.playerNo === 2) return 1;
  return stop('bad-snapshot', `Player ${player.id} has turn order ${player.playerNo}; expected 1 or 2.`);
}

function jewel(held: BgaCard): string {
  const id = held.index == null ? null : cardIdFromBga(held.level, held.index);
  return id ?? stop('unmapped', `BGA card ${held.id} (level ${held.level}, index ${String(held.index)}) is not a card we know.`);
}

function args<T>(schema: z.ZodType<T>, snapshot: BgaSnapshot): T {
  const parsed = schema.safeParse(snapshot.gamestate.args);
  if (!parsed.success) {
    stop('bad-snapshot', `State "${snapshot.gamestate.name}" came with arguments this adapter does not recognise.`);
  }
  return parsed.data;
}

function buildPlayer(player: BgaPlayer, mine: boolean, memory: Memory): PlayerView {
  const tokens = emptyTokens();
  for (const token of player.tokens) {
    const color =
      tokenColorFromBga(token) ??
      stop('unmapped', `Player ${player.id} holds a token of BGA colour ${token.color}, which the base game does not have.`);
    tokens[color] += 1;
  }

  const byColor = new Map<GemColor, string[]>();
  const colorless: string[] = [];
  // BGA files a purchased card under `player<id>-<column>`, and orders within a column by position.
  for (const held of [...player.cards].sort((a, b) => a.locationArg - b.locationArg)) {
    const id = jewel(held);
    const def = card(id);
    const column = Number(held.location.slice(held.location.lastIndexOf('-') + 1));
    if (column === BGA_COLORLESS) {
      if (def.wild) stop('mid-action', `Wild card ${id} has been bought but not yet placed on a column.`);
      if (def.bonusColor) stop('inconsistent', `Card ${id} has a ${def.bonusColor} bonus but sits with the colourless cards.`);
      colorless.push(id);
      continue;
    }
    const gem = gemFromBga(column) ?? stop('unmapped', `Card ${id} sits in "${held.location}", which is not a gem column.`);
    if (!def.wild && def.bonusColor !== gem) {
      stop('inconsistent', `Card ${id} has a ${String(def.bonusColor)} bonus but sits in the ${gem} column.`);
    }
    byColor.set(gem, [...(byColor.get(gem) ?? []), id]);
  }
  const stacks = GEM_COLORS.filter((color) => byColor.has(color)).map((color) => ({
    color,
    cardIds: byColor.get(color) as string[],
  }));

  const royals = player.royalCards.map(
    (held) => royalIdFromBga(held.index) ?? stop('expansion', `Royal card ${held.index} belongs to the Counterfeiters expansion.`),
  );

  const reserved: ReservedView[] = player.reserved.map((held) => {
    if (held.index != null) return { cardId: jewel(held) };
    if (mine) stop('bad-snapshot', `Our own reserved card ${held.id} arrived without its face.`);
    // BGA never shows an opponent's reservation. If we saw this card id on the table earlier, it
    // was reserved in front of us and we know it; otherwise it came off a deck, or we were not
    // watching, and either way it is hidden.
    const known = memory.seen[String(held.id)];
    return known ? { cardId: known } : { hidden: true };
  });

  // Only the fields the score helpers read; `reserved` is irrelevant to every one of them.
  const scored: PlayerState = {
    tokens,
    privileges: player.privileges,
    reserved: [],
    stacks,
    colorless,
    royals,
    royalsTaken: royals.length,
  };
  return {
    seat: seatOf(player),
    tokens,
    tokenTotal: tokenTotal(tokens),
    privileges: player.privileges,
    reserved,
    stacks,
    colorless,
    royals,
    // A royal is only ever claimed by crossing a crown threshold, one per threshold, and with four
    // royals for two players the table cannot run out. So the count of one is the count of the other.
    royalsTaken: royals.length,
    points: totalPoints(scored),
    crowns: totalCrowns(scored),
    bonuses: bonuses(scored),
    colorPoints: colorPoints(scored),
  };
}

interface TurnFacts {
  stage: Stage;
  pending: Pending | null;
  replenished: boolean;
  bought: boolean;
  extraTurns: number;
}

/**
 * Where in the turn we are: the part of a view that BGA expresses as a state name and a few
 * server-side flags, and we express as fields.
 */
function turnFacts(snapshot: BgaSnapshot, mine: PlayerView, memory: Memory, warnings: string[]): TurnFacts {
  const has = (id: string, ability: Ability): boolean => card(id).abilities.includes(ability);
  const owned = [...mine.stacks.flatMap((s) => s.cardIds), ...mine.colorless];

  // What this turn added, by comparison with how the turn began. At most one card and one royal can
  // arrive in a turn, so more than that means the baseline is from some earlier turn and is no use.
  const base = memory.baseline;
  let bought = base ? owned.filter((id) => !base.cards.includes(id)) : null;
  let claimed = base ? mine.royals.filter((id) => !base.royals.includes(id)) : null;
  if ((bought && bought.length > 1) || (claimed && claimed.length > 1)) {
    bought = null;
    claimed = null;
  }

  const replenished = memory.replenished;
  switch (snapshot.gamestate.name) {
    case 'playAction': {
      const a = args(zPlayActionArgs, snapshot);
      // BGA stops offering privileges once the board has been replenished this turn. If we hold one,
      // the board has something on it, and none is on offer, that is what happened. This is the
      // fallback for a first snapshot; memory recognises the replenish directly when it saw it.
      const locked = mine.privileges > 0 && a.privileges === 0 && snapshot.gamedatas.board.length > 0;
      return { stage: 'optional', pending: null, replenished: replenished || locked, bought: false, extraTurns: 0 };
    }

    case 'takeBoardToken': {
      const a = args(zTakeBoardTokenArgs, snapshot);
      const color = gemFromBga(a.color) ?? stop('expansion', `"Take a token" of BGA colour ${a.color} is an expansion power.`);
      // The card that granted this is the one just bought, which is the newest in its own column.
      const cardId =
        mine.stacks.find((s) => s.color === color)?.cardIds.at(-1) ??
        stop('inconsistent', `BGA asks for a ${color} token for a ${color} card, and we own no ${color} card.`);
      return { stage: 'abilities', pending: { k: 'matchingToken', color, cardId }, replenished, bought: true, extraTurns: 0 };
    }

    case 'takeOpponentToken': {
      const royal = mine.royals.find((id) => has(id, 'stealToken'));
      const cards = owned.filter((id) => has(id, 'stealToken'));
      let fromRoyal: boolean;
      if (claimed) {
        fromRoyal = claimed.some((id) => has(id, 'stealToken'));
      } else if (royal && cards.length === 0) {
        fromRoyal = true;
      } else {
        fromRoyal = false;
        if (royal) warnings.push('Started mid-turn: cannot tell whether a card or a royal granted this steal; assumed the card.');
      }
      if (fromRoyal) {
        const cardId = royal ?? stop('inconsistent', 'BGA asks for a steal and we hold nothing that grants one.');
        // A royal's ability resolves in the crowns stage, after the card's own.
        return { stage: 'crowns', pending: { k: 'steal', source: 'royal', cardId }, replenished, bought: true, extraTurns: 0 };
      }
      const cardId =
        bought?.find((id) => has(id, 'stealToken')) ??
        cards.at(-1) ??
        stop('inconsistent', 'BGA asks for a steal and we hold nothing that grants one.');
      return { stage: 'abilities', pending: { k: 'steal', source: 'card', cardId }, replenished, bought: true, extraTurns: 0 };
    }

    case 'takeRoyalCard':
      return { stage: 'crowns', pending: { k: 'royal' }, replenished, bought: true, extraTurns: 0 };

    case 'discardTokens': {
      const a = args(zDiscardArgs, snapshot);
      const count = mine.tokenTotal - TOKEN_LIMIT;
      if (count <= 0 || count !== a.number) {
        stop('inconsistent', `BGA asks for ${a.number} discard(s); we count ${mine.tokenTotal} tokens.`);
      }
      const pending: Pending = { k: 'discard', count };
      if (!bought || !claimed) {
        warnings.push('Started mid-turn: cannot tell whether an extra turn follows this discard; assumed not.');
        return { stage: 'cleanup', pending, replenished, bought: false, extraTurns: 0 };
      }
      // "Play again" is the one ability whose effect outlives the turn's other decisions, and BGA
      // keeps the flag server-side. What was bought or claimed this turn says the same thing.
      const extraTurns = [...bought, ...claimed].filter((id) => has(id, 'playAgain')).length;
      return { stage: 'cleanup', pending, replenished, bought: bought.length > 0, extraTurns };
    }

    default:
      return stop('unknown-state', `No translation for BGA state "${snapshot.gamestate.name}".`);
  }
}

function translate(snapshot: BgaSnapshot, memory: Memory, spectating: boolean): Translation {
  const { gamedatas, gamestate } = snapshot;
  if (gamedatas.expansion) stop('expansion', 'The Counterfeiters expansion is enabled on this table.');

  const kind = stateKind(gamestate.name);
  if (kind === 'mid-action') {
    stop('mid-action', `The table is in "${gamestate.name}", the middle of an action. Finish or cancel it.`);
  }
  if (kind !== 'decision') stop('unknown-state', `No translation for BGA state "${gamestate.name}".`);

  const players = Object.values(gamedatas.players);
  if (players.length !== 2) stop('bad-snapshot', `Expected 2 players, found ${players.length}.`);
  const mine = players.find((p) => p.id === snapshot.me) ?? stop('spectator', 'The logged-in account is not seated at this table.');
  const theirs = players.find((p) => p.id !== snapshot.me) ?? stop('bad-snapshot', 'No opponent at this table.');
  if (gamestate.active_player !== mine.id) stop('not-our-turn', 'It is not our seat that is to act.');

  // `mine` in the sense of "every reservation here has its face": true of our own seat, and of no
  // seat at all when we are only watching.
  const me = buildPlayer(mine, !spectating, memory);
  const them = buildPlayer(theirs, false, memory);
  if (me.seat === them.seat) stop('bad-snapshot', 'Both players report the same turn order.');
  const seat = me.seat as 0 | 1;

  const board: (TokenColor | null)[] = new Array<TokenColor | null>(BOARD_CELLS).fill(null);
  for (const token of gamedatas.board) {
    const cell = cellFromBga(token.locationArg) ?? stop('unmapped', `Board token ${token.id} is at position ${token.locationArg}.`);
    const color = tokenColorFromBga(token) ?? stop('unmapped', `Board token ${token.id} has BGA colour ${token.color}.`);
    if (board[cell] !== null) stop('inconsistent', `Two tokens on board position ${token.locationArg}.`);
    board[cell] = color;
  }

  const pyramid = {} as Record<Level, (string | null)[]>;
  const decks = {} as Record<Level, number>;
  for (const level of LEVELS) {
    const row = new Array<string | null>(PYRAMID_WIDTH[level]).fill(null);
    for (const held of gamedatas.tableCards[level]) {
      const slot = held.locationArg - 1;
      if (held.level !== level || slot < 0 || slot >= row.length) {
        stop('inconsistent', `Table card ${held.id} claims level ${held.level}, slot ${held.locationArg}, in the level ${level} row.`);
      }
      row[slot] = jewel(held);
    }
    pyramid[level] = row;
    decks[level] = gamedatas.cardDeckCount[level];
  }

  const onTable = gamedatas.royalCards
    .map((held) => royalIdFromBga(held.index) ?? stop('expansion', `Royal card ${held.index} belongs to the Counterfeiters expansion.`))
    .sort();
  if (onTable.length > 4) stop('inconsistent', `${onTable.length} royal cards on the table.`);
  // Slot order is arbitrary on both sides; claimed royals leave `null`s, as they do in our engine.
  const royals: (string | null)[] = [...onTable, ...new Array<null>(4 - onTable.length).fill(null)];

  const privilegePool = TOTAL_PRIVILEGES - me.privileges - them.privileges;
  if (privilegePool < 0) stop('inconsistent', 'The two players hold more than three privileges between them.');
  const bagTotal = BOARD_CELLS - gamedatas.board.length - me.tokenTotal - them.tokenTotal;
  if (bagTotal < 0) stop('inconsistent', 'More than 25 tokens are in play.');

  const warnings: string[] = [];
  const facts = turnFacts(snapshot, me, memory, warnings);

  const view: SplendorView = {
    v: 1,
    you: seat,
    bag: { total: bagTotal },
    board,
    decks,
    pyramid,
    royals,
    privilegePool,
    players: seat === 0 ? [me, them] : [them, me],
    turn: seat,
    stage: facts.stage,
    pending: facts.pending,
    extraTurns: facts.extraTurns,
    replenishedThisTurn: facts.replenished,
    // Empty at every decision point: no card queues a second ability behind a choice.
    abilityQueue: [],
    // BGA has no stall rule, and neither of these reaches the network or the legality check.
    turnsWithoutPurchase: 0,
    boughtThisTurn: facts.bought,
    options: {},
    winner: null,
    winReason: null,
  };

  /*
   * The last check is the search's own first step. `determinize` rebuilds the bag and the decks by
   * subtraction, and throws if the counts cannot be a real position — a card seen twice, a colour
   * with five tokens. Better found here, as a refusal with the snapshot attached, than as an
   * exception a thousand iterations into a search.
   */
  try {
    determinize(view, seat, new RandomCursor('bga-consistency', 0));
  } catch (error) {
    stop('inconsistent', `The snapshot is not a possible position: ${(error as Error).message}`);
  }

  return { view, seat, warnings };
}
