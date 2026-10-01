import { RandomCursor } from '@games/engine';
import {
  LEVELS,
  apply,
  card,
  legalActions,
  setup,
  type CardRef,
  type GemColor,
  type PayColor,
  type SplendorAction,
  type SplendorState,
  type TokenColor,
} from '@games/splendor-duel';
import { gemFromBga } from '../../src/ids.js';
import { pick } from './play.js';
import { PLAYER_ID, PLAYER_RATING, cardIdOfBga, heldTokenColor, royalIdOfBga, stateOf, synthSnapshot, type Viewer } from './synth.js';

/**
 * A BGA table, as far as the adapter can tell: something that can be pulsed, snapshotted, and sent
 * BGA's action calls, with an opponent who moves in their own time.
 *
 * Underneath it is our own engine, dressed by `synthSnapshot` -- including BGA's habit of leaving a
 * bought or reserved card's table slot empty until the end of the turn. That makes it a test of the
 * loop and of the call sequences -- turn detection, waiting, the three BGA states that are the middle
 * of one of our actions -- and not a test of whether BGA behaves this way. Only a live table tests
 * that.
 *
 * `perform` follows `ActionTrait.php`: the same action names, the same arguments, the same
 * two-step flows. Where BGA would refuse a call, this throws.
 */

type Partway =
  | { k: 'privilege' }
  | { k: 'gold'; cell: number }
  | { k: 'joker'; from: CardRef; payment: Partial<Record<TokenColor, number>> };

export interface FakeCall {
  name: string;
  args: Record<string, string | number>;
}

export class FakeTable {
  state: SplendorState;
  pulses = 0;
  private ticks = 0;
  private partway: Partway | null = null;
  /** The last position of this turn at stage `optional`: what BGA's mid-turn table is measured from. */
  private turnStart: SplendorState;
  private readonly rng: RandomCursor;

  /**
   * `viewer` is our seat, or `null` for a table we are only watching: then both seats play themselves.
   *
   * `thinks` is how many pulses a player who is not ours takes over a move. A person takes seconds,
   * which is many polls; it must at least be more than the loop spends on one position (two pulses
   * to see the table at rest, one to see it has not moved under the search), or every suggestion
   * would be about a position already gone.
   */
  constructor(
    seed: string,
    readonly viewer: Viewer,
    private readonly thinks = 5,
  ) {
    this.state = setup({ seed, seats: [0, 1], options: {} });
    this.turnStart = this.state;
    this.rng = new RandomCursor(`${seed}:opponent`, 0);
  }

  private current(): { name: string; args: unknown } {
    if (this.partway?.k === 'privilege') return { name: 'usePrivilege', args: { number: 1, privileges: 1 } };
    if (this.partway?.k === 'gold') return { name: 'reserveCard', args: { canReserve: 1, deckCards: [] } };
    if (this.partway?.k === 'joker') return { name: 'placeJoker', args: { colors: [] } };
    return stateOf(this.state);
  }

  async pulse(): Promise<{ name: string; active: number; args: string }> {
    this.pulses += 1;
    if (this.pulses > 20_000) throw new Error('FakeTable: 20,000 pulses and the game has not ended');
    const theirs = this.state.stage !== 'over' && this.state.turn !== this.viewer;
    if (theirs && ++this.ticks % this.thinks === 0) {
      const seat = this.state.turn as 0 | 1;
      this.force(seat, pick(legalActions(this.state, seat).actions, this.rng));
    }
    const { name, args } = this.current();
    return { name, active: PLAYER_ID[this.state.turn as 0 | 1], args: JSON.stringify(args ?? null) };
  }

  async snapshot(): Promise<unknown> {
    const as = this.partway ? this.current() : undefined;
    return JSON.parse(JSON.stringify(synthSnapshot(this.state, this.viewer, { as, before: this.turnStart })));
  }

  private seat(): 0 | 1 {
    if (this.viewer === null) throw new Error('FakeTable: nobody at this table is ours, so nothing can be played from here');
    return this.viewer;
  }

  /** The table's settings and the players' ratings, as the page reader hands them over. */
  async facts(playerIds: number[]): Promise<{ info: unknown; ratings: Record<number, number | null> }> {
    const ratings: Record<number, number | null> = {};
    for (const id of playerIds) {
      const seat = PLAYER_ID.indexOf(id);
      ratings[id] = seat === 0 || seat === 1 ? PLAYER_RATING[seat] : null;
    }
    return { info: null, ratings };
  }

  /** The operator, doing as advised. */
  play(action: SplendorAction): void {
    this.force(this.seat(), action);
  }

  force(seat: 0 | 1, action: SplendorAction): void {
    const result = apply(this.state, seat, action);
    if (!result.ok) throw new Error(result.error.message);
    this.state = result.state;
    if (this.state.stage === 'optional') this.turnStart = this.state;
  }

  /** One of BGA's action calls, from the viewer's seat. */
  async perform(call: FakeCall): Promise<void> {
    const seat = this.seat();
    if (this.state.turn !== seat || this.state.stage === 'over') throw new Error('It is not your turn');
    const ids = (value: string | number | undefined): number[] =>
      String(value ?? '').split(',').filter((part) => part !== '').map(Number);

    switch (call.name) {
      case 'actUsePrivilege':
        if (this.partway || this.state.stage !== 'optional') throw new Error('This move is not authorized now');
        this.partway = { k: 'privilege' };
        return;

      case 'actRefillBoard':
        return this.force(seat, { t: 'replenish' });

      case 'actTakeTokens': {
        const cells = ids(call.args.ids).map((id) => id - 100);
        const [only] = cells;
        if (this.partway?.k === 'privilege') {
          this.partway = null;
          if (cells.length !== 1 || only === undefined) throw new Error('This fake takes one token per privilege');
          return this.force(seat, { t: 'usePrivilege', cell: only });
        }
        if (this.state.pending?.k === 'matchingToken') {
          if (only === undefined) throw new Error('You must take tokens from the board');
          return this.force(seat, { t: 'chooseMatchingToken', cell: only });
        }
        if (cells.length === 1 && only !== undefined && this.state.board[only] === 'gold') {
          if (this.state.players[seat].reserved.length >= 3) throw new Error("You can't reserve more than 3 cards");
          this.partway = { k: 'gold', cell: only };
          return;
        }
        return this.force(seat, { t: 'takeTokens', cells: [...cells].sort((a, b) => a - b) });
      }

      case 'actReserveCard': {
        if (this.partway?.k !== 'gold') throw new Error('This move is not authorized now');
        const goldCell = this.partway.cell;
        this.partway = null;
        return this.force(seat, { t: 'reserve', goldCell, from: this.sourceOf(Number(call.args.id)) });
      }

      case 'actBuyCard': {
        const cardId = cardIdOfBga(Number(call.args.id));
        const from = this.refOf(cardId);
        const payment = this.tally(ids(call.args.tokensIds));
        if (card(cardId).wild) {
          this.partway = { k: 'joker', from, payment };
          return;
        }
        return this.force(seat, { t: 'purchase', from, payment });
      }

      case 'actPlaceJoker': {
        if (this.partway?.k !== 'joker') throw new Error('This move is not authorized now');
        const { from, payment } = this.partway;
        this.partway = null;
        const wildColor = gemFromBga(Number(call.args.color)) as GemColor;
        return this.force(seat, { t: 'purchase', from, payment, wildColor });
      }

      case 'actTakeOpponentToken':
        return this.force(seat, { t: 'chooseSteal', color: heldTokenColor(Number(call.args.id)) as PayColor });

      case 'actTakeRoyalCard':
        return this.force(seat, { t: 'chooseRoyal', royalId: royalIdOfBga(Number(call.args.id)) });

      case 'actDiscardTokens':
        return this.force(seat, { t: 'discard', tokens: this.tally(ids(call.args.ids)) });

      default:
        throw new Error(`This move is not authorized now: ${call.name}`);
    }
  }

  private refOf(cardId: string): CardRef {
    for (const level of LEVELS) {
      const slot = this.state.pyramid[level].indexOf(cardId);
      if (slot >= 0) return { t: 'pyramid', level, slot };
    }
    return { t: 'reserved', cardId };
  }

  private sourceOf(bga: number): Extract<SplendorAction, { t: 'reserve' }>['from'] {
    const cardId = cardIdOfBga(bga);
    for (const level of LEVELS) {
      const slot = this.state.pyramid[level].indexOf(cardId);
      if (slot >= 0) return { t: 'pyramid', level, slot };
      if (this.state.decks[level][0] === cardId) return { t: 'deck', level };
    }
    throw new Error('You must reserve a card from the table or from the decks');
  }

  private tally(tokenIds: number[]): Partial<Record<TokenColor, number>> {
    const out: Partial<Record<TokenColor, number>> = {};
    for (const id of tokenIds) {
      const color = heldTokenColor(id);
      out[color] = (out[color] ?? 0) + 1;
    }
    return out;
  }
}
