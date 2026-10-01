import {
  CARD_DEFS,
  SPIRAL,
  TOKEN_COLORS,
  legalActions,
  type SplendorState,
  type TokenColor,
} from '@games/splendor-duel';
import { BGA_BOARD_COORDINATES, colorToBga } from '../../src/ids.js';
import { parseSnapshot, type BgaSnapshot } from '../../src/snapshot.js';

/**
 * A position from our own engine, dressed as BGA would send it.
 *
 * This is the translation run backwards, and it exists so the forward direction can be tested
 * without a BGA table: play a game here, dress every position up, translate it back, and the result
 * has to be the view our own redaction produces. It follows `getAllDatas` and the `arg*` methods in
 * thoun/splendorduel, including the parts that are awkward on purpose — ids arrive as strings, an
 * opponent's reserved card arrives without its face, an empty PHP map arrives as `[]`.
 *
 * It shares this repo's assumptions about BGA's shapes with the code under test, so it cannot catch
 * a wrong assumption. Captured fixtures from live tables are what catch those (see tools/bga).
 */

export const PLAYER_ID: readonly [number, number] = [1000, 2000];

const JEWELS = CARD_DEFS.filter((c) => c.kind === 'jewel').map((c) => c.id);
const ROYALS = CARD_DEFS.filter((c) => c.kind === 'royal').map((c) => c.id);

/** BGA card ids are database row ids with no meaning. Here they are just a stable numbering. */
export const bgaCardId = (id: string): number => JEWELS.indexOf(id) + 1;
export const cardIdOfBga = (bga: number): string => JEWELS[bga - 1] as string;
export const bgaRoyalId = (id: string): number => ROYALS.indexOf(id) + 1;
export const royalIdOfBga = (bga: number): string => ROYALS[bga - 1] as string;

/** Board tokens are 100 + cell; a held token is its owner's id + 10 x colour + a counter. */
export const boardTokenId = (cell: number): number => 100 + cell;
const heldTokenId = (seat: 0 | 1, color: TokenColor, n: number): number =>
  PLAYER_ID[seat] + TOKEN_COLORS.indexOf(color) * 10 + n;
export const heldTokenColor = (id: number): TokenColor =>
  TOKEN_COLORS[Math.floor((id % 1000) / 10)] as TokenColor;

function cardJson(id: string, location: string, locationArg: number, faceUp: boolean) {
  const match = /^l(\d)-(\d+)$/.exec(id);
  if (!match) throw new Error(`synth: not a jewel card: ${id}`);
  return {
    id: bgaCardId(id),
    location,
    locationArg,
    level: Number(match[1]),
    index: faceUp ? Number(match[2]) : null,
  };
}

function royalJson(id: string, location: string, locationArg: number) {
  return { id: bgaRoyalId(id), location, locationArg, index: bgaRoyalId(id) };
}

/** The BGA state a position is in, and the arguments BGA would send with it. */
export function stateOf(state: SplendorState): { name: string; args: unknown } {
  if (state.stage === 'over') return { name: 'gameEnd', args: null };
  const seat = state.turn as 0 | 1;
  const me = state.players[seat];
  const pending = state.pending;
  if (pending?.k === 'matchingToken') {
    return { name: 'takeBoardToken', args: { number: 1, color: colorToBga(pending.color), canTakeAnyColorOrTwoOfColor: false } };
  }
  if (pending?.k === 'steal') return { name: 'takeOpponentToken', args: { opponentId: PLAYER_ID[(1 - seat) as 0 | 1] } };
  if (pending?.k === 'royal') return { name: 'takeRoyalCard', args: null };
  if (pending?.k === 'discard') return { name: 'discardTokens', args: { number: pending.count } };

  const boardCount = state.board.filter((t) => t !== null).length;
  const privileges = state.replenishedThisTurn || boardCount === 0 ? 0 : me.privileges;
  const canRefill = state.bag.length > 0 && boardCount < 25 && !state.replenishedThisTurn;
  const buyable: Record<string, unknown[]> = {};
  for (const action of legalActions(state, seat).actions) {
    if (action.t !== 'purchase') continue;
    const id =
      action.from.t === 'pyramid'
        ? (state.pyramid[action.from.level][action.from.slot] as string)
        : action.from.cardId;
    buyable[String(bgaCardId(id))] = [{}];
  }
  const canReserve = me.reserved.length < 3;
  const onlyGold = state.board.every((t) => t === null || t === 'gold');
  const canTakeTokens = boardCount > 0 && !(!canReserve && onlyGold);
  const canBuyCard = Object.keys(buyable).length > 0;
  return {
    name: 'playAction',
    args: {
      privileges,
      canRefill,
      mustRefill: canRefill && !canTakeTokens && !canBuyCard,
      canTakeTokens,
      canReserve,
      canBuyCard,
      // PHP encodes an empty map as a list. The schema has to take both, so the fixture sends both.
      buyableCards: canBuyCard ? buyable : [],
      reducedCosts: [],
      playerAntiPlaying: false,
      opponentAntiPlaying: false,
    },
  };
}

function playerJson(state: SplendorState, seat: 0 | 1, viewer: 0 | 1) {
  const player = state.players[seat];
  const pid = PLAYER_ID[seat];
  const tokens = TOKEN_COLORS.flatMap((color) =>
    Array.from({ length: player.tokens[color] }, (_, n) => ({
      id: heldTokenId(seat, color, n),
      location: 'player',
      locationArg: pid,
      type: color === 'gold' ? 1 : 2,
      color: colorToBga(color),
    })),
  );
  const cards = [
    ...player.stacks.flatMap((stack) =>
      stack.cardIds.map((id, i) => cardJson(id, `player${pid}-${colorToBga(stack.color)}`, i, true)),
    ),
    ...player.colorless.map((id, i) => cardJson(id, `player${pid}-9`, i, true)),
    // BGA orders one query across every column by position, so colours arrive interleaved.
  ].sort((a, b) => a.locationArg - b.locationArg);
  return {
    id: String(pid),
    score: state.winner === seat ? 1 : 0,
    playerNo: seat + 1,
    privileges: player.privileges,
    tokens,
    cards,
    // `Card::onlyIds`: an opponent's reservation has no face, whether or not it was taken face-up.
    reserved: player.reserved.map((held) => cardJson(held.cardId, 'reserved', pid, seat === viewer)),
    royalCards: player.royals.map((id) => royalJson(id, 'player', pid)),
    endReasons: [],
  };
}

export function synthSnapshot(
  state: SplendorState,
  viewer: 0 | 1,
  override?: { name: string; args: unknown },
): unknown {
  const { name, args } = override ?? stateOf(state);
  const byLevel = <T>(make: (level: 1 | 2 | 3) => T) => ({ 1: make(1), 2: make(2), 3: make(3) });
  return {
    tableId: 'synthetic',
    me: PLAYER_ID[viewer],
    gamestate: { name, active_player: String(PLAYER_ID[state.turn as 0 | 1]), args },
    gamedatas: {
      players: {
        [PLAYER_ID[0]]: playerJson(state, 0, viewer),
        [PLAYER_ID[1]]: playerJson(state, 1, viewer),
      },
      board: state.board.flatMap((color, cell) => {
        if (color === null) return [];
        const position = SPIRAL.indexOf(cell) + 1;
        const [row, column] = BGA_BOARD_COORDINATES[position - 1] as readonly [number, number];
        return [{ id: boardTokenId(cell), location: 'board', locationArg: position, type: color === 'gold' ? 1 : 2, color: colorToBga(color), row, column }];
      }),
      cardDeckCount: byLevel((level) => state.decks[level].length),
      cardDeckTop: byLevel((level) => {
        const top = state.decks[level][0];
        return top ? cardJson(top, `deck${level}`, state.decks[level].length, false) : null;
      }),
      tableCards: byLevel((level) =>
        state.pyramid[level].flatMap((id, slot) => (id ? [cardJson(id, `table${level}`, slot + 1, true)] : [])),
      ),
      royalCards: state.royals.flatMap((id, i) => (id ? [royalJson(id, 'deck', i)] : [])),
      expansion: false,
    },
  };
}

/** `synthSnapshot`, through the schema, or a thrown error — for tests that are about something else. */
export function snap(state: SplendorState, viewer: 0 | 1): BgaSnapshot {
  const parsed = parseSnapshot(synthSnapshot(state, viewer));
  if (!parsed.ok) throw new Error(`synth produced a snapshot the schema refuses: ${parsed.refusal.detail}`);
  return parsed.snapshot;
}
