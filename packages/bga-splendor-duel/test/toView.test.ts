import {
  apply,
  legalActions,
  legalActionsFromView,
  redactFor,
  setup,
  type SplendorState,
  type SplendorView,
} from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { emptyMemory, remember, type Memory } from '../src/memory.js';
import { parseSnapshot } from '../src/snapshot.js';
import { toView } from '../src/toView.js';
import { PLAYER_ID, snap, synthSnapshot, unrefilled } from './support/synth.js';
import { walk } from './support/play.js';
import { canonical } from './support/canonical.js';

/**
 * Our own redaction, as BGA would show it at this moment.
 *
 * BGA refills the table at the end of the turn and our engine at once, so after a purchase or
 * reservation from the table, every later decision of the same turn sees that slot empty on BGA and
 * its deck one card larger (see `unrefilled`). That is a difference of timing, not of position, and
 * `determinizeBga` closes it before the search; the translation itself reports what BGA shows.
 */
function viewOf(state: SplendorState, seat: 0 | 1, before: SplendorState | undefined): SplendorView {
  const view = JSON.parse(JSON.stringify(redactFor(seat, state))) as SplendorView;
  for (const { level, slot } of unrefilled(state, before)) {
    view.pyramid[level][slot] = null;
    view.decks[level] += 1;
  }
  return view;
}

/**
 * The whole contract in one property.
 *
 * Play a game in our engine. At every decision, dress the position up as BGA would send it to the
 * player deciding, translate that back, and the result has to be the view our own redaction gives
 * that player -- as BGA shows it at that moment (`viewOf`). If it is, the bot on BGA is looking at
 * the same thing the bot in the arena looked at — which is the only reason to believe a number
 * measured there says anything about a game here. "The same" is up to `canonical`.
 */
describe('toView', () => {
  it('gives back exactly the view our own redaction produces, at every decision of a game', () => {
    const pendingSeen = new Set<string>();
    let checked = 0;
    let unrefilledSeen = 0;
    for (const seed of ['toview-a', 'toview-b', 'toview-c']) {
      const memory: [Memory, Memory] = [emptyMemory(), emptyMemory()];
      walk(seed, 400, (state, before) => {
        if (state.stage === 'over') return;
        for (const viewer of [0, 1] as const) {
          const snapshot = snap(state, viewer, before);
          memory[viewer] = remember(memory[viewer], snapshot);
          if (state.turn !== viewer) continue;

          const result = toView(snapshot, memory[viewer]);
          expect(result.ok, result.ok ? '' : `${result.refusal.reason}: ${result.refusal.detail}`).toBe(true);
          if (!result.ok) return;
          const expected = viewOf(state, viewer, before);
          expect(result.seat).toBe(viewer);
          expect(canonical(result.view)).toEqual(canonical(expected));
          expect(result.warnings).toEqual([]);
          // Implied by the equality above, and stated anyway: it is the property the bot lives on.
          // As a set, because the order moves are listed in follows the orderings `canonical` ignores.
          const moves = (view: SplendorView) =>
            legalActionsFromView(view, viewer).actions.map((a) => JSON.stringify(a)).sort();
          expect(moves(result.view)).toEqual(moves(expected));
          pendingSeen.add(state.pending?.k ?? 'none');
          if (unrefilled(state, before).length > 0) unrefilledSeen += 1;
          checked += 1;
        }
      });
    }
    expect(checked).toBeGreaterThan(300);
    // And the timing difference was exercised, not just allowed for.
    expect(unrefilledSeen).toBeGreaterThan(5);
    // The property is only as good as the states it visited.
    for (const kind of ['none', 'discard', 'royal', 'matchingToken', 'steal']) {
      expect(pendingSeen.has(kind), `no position with pending "${kind}" was reached; add a seed`).toBe(true);
    }
  });

  it('falls back to hidden for an opponent reservation it never saw face-up', () => {
    // Memory that starts only now: the reservation was made while nobody was watching.
    const opening = setup({ seed: 'toview-late', seats: [0, 1], options: {} });
    const opponent = opening.turn as 0 | 1;
    const viewer = (1 - opponent) as 0 | 1;
    const reserve = legalActions(opening, opponent).actions.find((a) => a.t === 'reserve' && a.from.t === 'pyramid');
    if (!reserve) throw new Error('the opening always offers a table reservation');
    const after = apply(opening, opponent, reserve);
    if (!after.ok) throw new Error(after.error.message);

    const snapshot = snap(after.state, viewer);
    const result = toView(snapshot, remember(emptyMemory(), snapshot));
    if (!result.ok) throw new Error(result.refusal.detail);
    expect(result.view.players[opponent].reserved).toEqual([{ hidden: true }]);
  });
});

describe('what toView refuses', () => {
  const opening = setup({ seed: 'toview-refusals', seats: [0, 1], options: {} });
  const mover = opening.turn as 0 | 1;
  const raw = () => JSON.parse(JSON.stringify(synthSnapshot(opening, mover))) as any;
  const run = (mutate: (snapshot: any) => void) => {
    const edited = raw();
    mutate(edited);
    const parsed = parseSnapshot(edited);
    if (!parsed.ok) throw new Error(parsed.refusal.detail);
    return toView(parsed.snapshot, remember(emptyMemory(), parsed.snapshot));
  };
  const reasonOf = (mutate: (snapshot: any) => void) => {
    const result = run(mutate);
    return result.ok ? 'accepted' : result.refusal.reason;
  };

  it('accepts the unedited opening, so each refusal below is about the edit', () => {
    expect(reasonOf(() => {})).toBe('accepted');
  });

  it('the expansion', () => {
    expect(reasonOf((s) => (s.gamedatas.expansion = true))).toBe('expansion');
  });

  it('a state it has no translation for, and one that is the middle of an action', () => {
    expect(reasonOf((s) => (s.gamestate.name = 'beforeEndTurn'))).toBe('unknown-state');
    expect(reasonOf((s) => (s.gamestate.name = 'reserveCard'))).toBe('mid-action');
  });

  it('a table the logged-in account is not seated at', () => {
    expect(reasonOf((s) => (s.me = 999))).toBe('spectator');
  });

  it("the opponent's turn", () => {
    expect(reasonOf((s) => (s.gamestate.active_player = PLAYER_ID[(1 - mover) as 0 | 1]))).toBe('not-our-turn');
  });

  it('a token colour this game does not have', () => {
    // Type 2 as well: BGA marks gold by type, so a gold token's colour field is never read.
    expect(reasonOf((s) => Object.assign(s.gamedatas.board[0], { type: 2, color: 6 }))).toBe('unmapped');
  });

  it('a board that contradicts itself: two tokens on one cell', () => {
    expect(reasonOf((s) => (s.gamedatas.board[1].locationArg = s.gamedatas.board[0].locationArg))).toBe('inconsistent');
  });

  it('a card it has seen twice', () => {
    // The same face in two table slots: no deal of this deck looks like that.
    expect(
      reasonOf((s) => {
        s.gamedatas.tableCards[1][1].index = s.gamedatas.tableCards[1][0].index;
      }),
    ).toBe('inconsistent');
  });

  it('insists on being given memory that has seen this snapshot', () => {
    const snapshot = snap(opening, mover);
    expect(() => toView(snapshot, emptyMemory())).toThrow(/remember/);
  });
});
