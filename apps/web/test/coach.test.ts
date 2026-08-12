import { RandomCursor } from '@games/engine';
import splendorDuel, { legalActionsFromView, redactFor, type SplendorState, type SplendorView } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { analyse } from '../src/bot/analyse.js';
import { publishedEngine } from './published-engine.js';

/**
 * The coach: what the panel in a game between people is actually reading out.
 *
 * The interesting properties are not "is the evaluation right" -- that is what the arena is for --
 * but the ones a player would be misled by: that it never suggests moves on somebody else's turn,
 * that the same move is never listed twice, and that every move it names is one a person could act
 * on rather than a raw action shape.
 */

const engine = publishedEngine();

/** A position `plies` in, played out at random, plus whose turn it is there. */
function position(seed: string, plies: number): { state: SplendorState; turn: number } {
  const rng = new RandomCursor(seed, 0);
  let state = splendorDuel.setup({ seed, seats: [0, 1], options: { maxTurnsWithoutPurchase: 60 } });
  for (let i = 0; i < plies; i++) {
    const seat = splendorDuel.currentActors(state)[0];
    if (seat === undefined) break;
    const { actions } = legalActionsFromView(redactFor(seat, state) as SplendorView, seat);
    if (actions.length === 0) break;
    const next = splendorDuel.apply(state, seat, actions[rng.int(actions.length)]!);
    if (!next.ok) break;
    state = next.state;
    if (splendorDuel.outcome(state).status === 'over') break;
  }
  return { state, turn: splendorDuel.currentActors(state)[0] ?? 0 };
}

const viewFor = (state: SplendorState, seat: number): SplendorView =>
  JSON.parse(JSON.stringify(redactFor(seat, state))) as SplendorView;

describe('the coach', () => {
  it('evaluates a position and suggests moves on your turn', () => {
    const { state, turn } = position('coach-a', 20);
    const reading = analyse(engine, {
      view: viewFor(state, turn),
      seat: turn,
      yourTurn: true,
      iterations: 60,
      seed: 'a',
    });

    expect(Number.isFinite(reading.staticValue)).toBe(true);
    expect(reading.staticValue).toBeGreaterThanOrEqual(-1);
    expect(reading.staticValue).toBeLessThanOrEqual(1);
    expect(Number.isFinite(reading.searchValue)).toBe(true);
    expect(reading.moves.length).toBeGreaterThan(0);
    expect(reading.moves.length).toBeLessThanOrEqual(4);
    expect(reading.instinct).not.toBeNull();
  });

  it('says nothing about moves when it is not your turn', () => {
    const { state, turn } = position('coach-b', 15);
    const other = 1 - turn;
    const reading = analyse(engine, {
      view: viewFor(state, other),
      seat: other,
      yourTurn: false,
      iterations: 60,
      seed: 'b',
    });

    // The evaluation is fair game -- you can see the board. A list of your opponent's best replies
    // is a different thing, and not yours to read.
    expect(reading.moves).toEqual([]);
    expect(reading.instinct).toBeNull();
    expect(Number.isFinite(reading.searchValue)).toBe(true);
  });

  it('never lists the same move twice, and shares are ordered and add up to at most one', () => {
    for (const plies of [0, 8, 24]) {
      const { state, turn } = position(`coach-c${plies}`, plies);
      const reading = analyse(engine, {
        view: viewFor(state, turn),
        seat: turn,
        yourTurn: true,
        iterations: 120,
        seed: `c${plies}`,
      });

      /*
       * The regression this pins: reserving differs only in which gold token you take, which
       * `describeAction` deliberately does not name -- so the raw ranking produced two rows reading
       * "Reserve L2 blue, with a gold" at 25% and 5%, which looks like a bug and understates a move
       * the search likes.
       */
      const texts = reading.moves.map((m) => m.text);
      expect(new Set(texts).size).toBe(texts.length);

      const shares = reading.moves.map((m) => m.visits);
      expect([...shares].sort((a, b) => b - a)).toEqual(shares);
      expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1.0001);
      for (const move of reading.moves) {
        expect(move.prior).toBeGreaterThanOrEqual(0);
        expect(move.prior).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  it('names every move in words a player could act on', () => {
    for (const plies of [0, 5, 17, 33]) {
      const { state, turn } = position(`coach-d${plies}`, plies);
      const reading = analyse(engine, {
        view: viewFor(state, turn),
        seat: turn,
        yourTurn: true,
        iterations: 60,
        seed: `d${plies}`,
      });
      for (const move of reading.moves) {
        // `describeAction`'s fallback, which should be unreachable for anything `legalActions` made.
        expect(move.text).not.toBe('a move');
        expect(move.text.length).toBeGreaterThan(3);
      }
    }
  });
});
