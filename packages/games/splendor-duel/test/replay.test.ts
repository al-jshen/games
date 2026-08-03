import { RandomCursor, createMatch, isJsonRoundTrippable, replay, step, undoLast } from '@games/engine';
import { describe, expect, it } from 'vitest';
import { splendorDuel } from '../src/index.js';
import type { SplendorAction, SplendorState } from '../src/types.js';

/**
 * A match is persisted as `{seed, gameId, options, actions[]}` — a few hundred bytes — rather than as
 * state snapshots. That only works if replaying the log reproduces the state exactly, so this is the
 * test that protects every stored replay, every bug report, and the move log in the UI.
 *
 * It is also the regression net for rule changes: change a rule deliberately and this fails, which
 * is the reminder to bump `stateVersion` and re-record.
 */
describe('replay', () => {
  function playToEnd(seed: string) {
    const match = createMatch(splendorDuel, {
      matchId: `m-${seed}`,
      code: 'TEST01',
      seed,
      seats: [0, 1],
      options: { maxTurnsWithoutPurchase: 80 },
      now: 0,
    });
    const rng = new RandomCursor(`${seed}:pol`, 0);
    let live = match;

    for (let i = 0; i < 3000; i++) {
      const actors = splendorDuel.currentActors(live.state);
      if (actors.length === 0) break;
      const seat = actors[0]!;
      const { actions } = splendorDuel.legalActions(live.state, seat);
      if (actions.length === 0) break;
      const result = step(splendorDuel, live, seat, actions[rng.int(actions.length)]!, i + 1);
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      live = result.match;
    }
    return live;
  }

  it('reproduces the final state exactly from the action log', () => {
    for (const seed of ['r1', 'r2', 'r3', 'r4', 'r5']) {
      const live = playToEnd(seed);
      expect(live.record.actions.length).toBeGreaterThan(20);

      const rebuilt = replay(splendorDuel, live.record);
      expect(rebuilt.version).toBe(live.version);
      // Byte-identical, not merely equivalent: key order matters for the view-stability guarantee.
      expect(JSON.stringify(rebuilt.state)).toBe(JSON.stringify(live.state));
    }
  });

  it('survives a JSON round trip of the record, as persistence requires', () => {
    const live = playToEnd('r-json');
    expect(isJsonRoundTrippable(live.record)).toBe(true);
    const fromDisk = JSON.parse(JSON.stringify(live.record));
    const rebuilt = replay(splendorDuel, fromDisk);
    expect(JSON.stringify(rebuilt.state)).toBe(JSON.stringify(live.state));
  });

  it('is stable for a given seed: setup is a pure function of it', () => {
    const a = splendorDuel.setup({ seed: 'golden', seats: [0, 1], options: {} });
    const b = splendorDuel.setup({ seed: 'golden', seats: [0, 1], options: {} });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // A golden fingerprint, so an accidental change to the shuffle or the PRNG shows up here rather
    // than as silently invalid stored replays.
    const fingerprint = {
      turn: a.turn,
      board: a.board.join(','),
      pyramid: [1, 2, 3].map((l) => a.pyramid[l as 1 | 2 | 3].join(',')),
      deckTops: [1, 2, 3].map((l) => a.decks[l as 1 | 2 | 3][0]),
      royals: a.royals.join(','),
    };
    expect(fingerprint).toMatchInlineSnapshot(`
      {
        "board": "gold,gold,black,blue,white,green,black,black,red,red,white,blue,pearl,gold,pearl,green,white,blue,red,white,black,green,red,blue,green",
        "deckTops": [
          "l1-15",
          "l2-06",
          "l3-12",
        ],
        "pyramid": [
          "l1-12,l1-26,l1-10,l1-30,l1-25",
          "l2-09,l2-12,l2-08,l2-11",
          "l3-10,l3-02,l3-11",
        ],
        "royals": "royal-02,royal-04,royal-01,royal-03",
        "turn": 1,
      }
    `);
  });

  it('rejects a log that does not fit its seed', () => {
    const live = playToEnd('r-tamper');
    const tampered = {
      ...live.record,
      // Same actions, different shuffle: the log can no longer be legal all the way through.
      seed: 'a-different-seed-entirely',
    };
    expect(() => replay(splendorDuel, tampered)).toThrow();
  });

  it('never lets the seed reach a view, at any point in a match', () => {
    const live = playToEnd('r-secret');
    for (const viewer of [0, 1, null] as const) {
      const wire = JSON.stringify(splendorDuel.redactFor(viewer, live.state as SplendorState));
      expect(wire).not.toContain(live.record.seed);
    }
  });
});

/** A type-level reminder that the log stores actions, not internal state. */
export type LoggedSplendorAction = SplendorAction;

describe('undo', () => {
  /**
   * Undo is a platform operation, not a rule: it drops the last logged action and replays. The
   * consequence worth testing is that it cannot invent a position — whatever comes back is a state
   * the reducer itself produced, because the reducer is what rebuilt it.
   */
  function playSome(seed: string, moves: number) {
    let live = createMatch(splendorDuel, {
      matchId: `m-${seed}`,
      code: 'UNDO01',
      seed,
      seats: [0, 1],
      options: {},
      now: 1_000,
    });
    const rng = new RandomCursor(`${seed}:undo`, 0);
    const snapshots: { version: number; state: string }[] = [
      { version: live.version, state: JSON.stringify(live.state) },
    ];
    for (let i = 0; i < moves; i++) {
      const seat = splendorDuel.currentActors(live.state)[0];
      if (seat === undefined) break;
      const { actions } = splendorDuel.legalActions(live.state, seat);
      if (actions.length === 0) break;
      const result = step(splendorDuel, live, seat, actions[rng.int(actions.length)]!, 2_000 + i);
      if (!result.ok) break;
      live = result.match;
      snapshots.push({ version: live.version, state: JSON.stringify(live.state) });
    }
    return { live, snapshots };
  }

  it('returns the position to exactly what it was before the last move', () => {
    const { live, snapshots } = playSome('undo-exact', 12);
    expect(live.version).toBeGreaterThan(4);

    const undone = undoLast(splendorDuel, live);
    expect(undone).not.toBeNull();
    const previous = snapshots[snapshots.length - 2]!;
    expect(undone!.match.version).toBe(previous.version);
    // Byte-identical, not merely equivalent: this is a replay, so anything else would mean the
    // reducer is not deterministic.
    expect(JSON.stringify(undone!.match.state)).toBe(previous.state);
    expect(undone!.match.record.actions).toHaveLength(live.record.actions.length - 1);
    expect(undone!.undone).toEqual(live.record.actions.at(-1));
  });

  it('gives back a move log that matches the actions that are left', () => {
    const { live } = playSome('undo-log', 10);
    const undone = undoLast(splendorDuel, live)!;
    expect(undone.log).toHaveLength(undone.match.record.actions.length);
    expect(undone.log.map((e) => e.version)).toEqual(undone.match.record.actions.map((a) => a.version));
    // The timestamps are the original ones, not the moment of the undo.
    expect(undone.log.map((e) => e.at)).toEqual(undone.match.record.actions.map((a) => a.at));
  });

  it('rewinds all the way to the opening position, one move at a time', () => {
    const played = playSome('undo-all', 9);
    const opening = played.snapshots[0]!;
    let live = played.live;
    for (let guard = 0; guard < 50 && live.record.actions.length > 0; guard++) {
      live = undoLast(splendorDuel, live)!.match;
    }
    expect(live.version).toBe(0);
    expect(JSON.stringify(live.state)).toBe(opening.state);
    // Nothing left to take back.
    expect(undoLast(splendorDuel, live)).toBeNull();
  });

  it('un-ends a match whose last move ended it', () => {
    // Play to a genuine finish, then take the winning move back.
    let live = createMatch(splendorDuel, {
      matchId: 'm-undo-over',
      code: 'UNDO02',
      seed: 'undo-over',
      seats: [0, 1],
      options: { maxTurnsWithoutPurchase: 80 },
      now: 1_000,
    });
    const rng = new RandomCursor('undo-over:pol', 0);
    for (let i = 0; i < 3000; i++) {
      const seat = splendorDuel.currentActors(live.state)[0];
      if (seat === undefined) break;
      const { actions } = splendorDuel.legalActions(live.state, seat);
      if (actions.length === 0) break;
      const result = step(splendorDuel, live, seat, actions[rng.int(actions.length)]!, 2_000 + i);
      if (!result.ok) break;
      live = result.match;
    }
    expect(splendorDuel.outcome(live.state).status).toBe('over');
    expect(live.record.finishedAt).toBeDefined();
    expect(live.record.outcome).toBeDefined();

    const undone = undoLast(splendorDuel, live)!;
    expect(splendorDuel.outcome(undone.match.state).status).toBe('active');
    // The record must not go on claiming the match is finished, or a resumed copy of it would come
    // back over while the board says otherwise.
    expect(undone.match.record.finishedAt).toBeUndefined();
    expect(undone.match.record.outcome).toBeUndefined();
  });
});
