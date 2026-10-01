import { RandomCursor } from '@games/engine';
import { apply, legalActions, setup, type SplendorAction, type SplendorState } from '@games/splendor-duel';
import { pick } from './play.js';
import { PLAYER_ID, stateOf, synthSnapshot } from './synth.js';

/**
 * A BGA table, as far as the adapter's loop can tell: something that can be pulsed and snapshotted,
 * with an opponent who moves in their own time.
 *
 * Underneath it is our own engine, dressed by `synthSnapshot`. That makes it a test of the loop --
 * turn detection, waiting, stopping, the order things are asked in -- and not a test of whether BGA
 * behaves this way. Only a live table tests that.
 *
 * The opponent moves on every third pulse rather than instantly, so the loop actually sees the
 * table sitting on the other player's turn, which is most of what a real table does.
 */
export class FakeTable {
  state: SplendorState;
  pulses = 0;
  private ticks = 0;
  private readonly rng: RandomCursor;

  constructor(
    seed: string,
    readonly viewer: 0 | 1,
  ) {
    this.state = setup({ seed, seats: [0, 1], options: {} });
    this.rng = new RandomCursor(`${seed}:opponent`, 0);
  }

  protected current(): { name: string; args: unknown } {
    return stateOf(this.state);
  }

  async pulse(): Promise<{ name: string; active: number; args: string }> {
    this.pulses += 1;
    if (this.pulses > 20_000) throw new Error('FakeTable: 20,000 pulses and the game has not ended');
    const theirs = this.state.stage !== 'over' && this.state.turn !== this.viewer;
    if (theirs && ++this.ticks % 3 === 0) {
      const seat = this.state.turn as 0 | 1;
      this.force(seat, pick(legalActions(this.state, seat).actions, this.rng));
    }
    const { name, args } = this.current();
    return { name, active: PLAYER_ID[this.state.turn as 0 | 1], args: JSON.stringify(args ?? null) };
  }

  async snapshot(): Promise<unknown> {
    return JSON.parse(JSON.stringify(synthSnapshot(this.state, this.viewer)));
  }

  /** The operator, doing as advised. */
  play(action: SplendorAction): void {
    this.force(this.viewer, action);
  }

  force(seat: 0 | 1, action: SplendorAction): void {
    const result = apply(this.state, seat, action);
    if (!result.ok) throw new Error(result.error.message);
    this.state = result.state;
  }
}
