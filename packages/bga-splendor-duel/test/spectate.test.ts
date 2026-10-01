import { RandomCursor } from '@games/engine';
import { legalActionsFromView, redactFor, setup, type SplendorState, type SplendorView } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { crossCheck } from '../src/crosscheck.js';
import { determinizeBga } from '../src/determinizeBga.js';
import { emptyMemory, remember, type Memory } from '../src/memory.js';
import { asSeat, isSeated } from '../src/spectate.js';
import { toView } from '../src/toView.js';
import { canonical } from './support/canonical.js';
import { PLAYER_ID, SPECTATOR_ID, snap, unrefilled } from './support/synth.js';
import { walk } from './support/play.js';

/**
 * Watching a game from the stands.
 *
 * A spectator is shown neither player's face-down reservations, so what can be said about a position
 * is what the bot would play *knowing only what is public*. The translation for that is the ordinary
 * one, taken from the seat of whoever is to move, with that seat's own unseen reservations hidden as
 * an opponent's would be.
 */

/** What our own redaction gives a spectator, taken from `seat`'s side, as BGA shows it mid-turn. */
function publicViewOf(state: SplendorState, seat: 0 | 1, before: SplendorState | undefined): SplendorView {
  const view = JSON.parse(JSON.stringify(redactFor(null, state))) as SplendorView;
  for (const { level, slot } of unrefilled(state, before)) {
    view.pyramid[level][slot] = null;
    view.decks[level] += 1;
  }
  return { ...view, you: seat };
}

describe('asSeat', () => {
  const opening = setup({ seed: 'spectate-seat', seats: [0, 1], options: {} });

  it('lets a spectator take up the point of view of either player', () => {
    const watching = snap(opening, null);
    expect(isSeated(watching)).toBe(false);
    expect(watching.me).toBe(SPECTATOR_ID);
    for (const id of PLAYER_ID) {
      const seated = asSeat(watching, id);
      expect(seated.me).toBe(id);
      expect(seated.gamedatas).toBe(watching.gamedatas);
    }
  });

  it('refuses to turn a player’s own snapshot into the opponent’s', () => {
    // That snapshot carries our hidden reservations face-up. Relabelled, they would become cards
    // the opponent "knows", which is a position nobody at the table is in.
    const ours = snap(opening, 0);
    expect(isSeated(ours)).toBe(true);
    expect(asSeat(ours, PLAYER_ID[0])).toBe(ours);
    expect(() => asSeat(ours, PLAYER_ID[1])).toThrow(/seated/);
  });

  it('refuses a player who is not at the table', () => {
    expect(() => asSeat(snap(opening, null), 31337)).toThrow(/not at this table/);
  });
});

describe('toView, from the stands', () => {
  it('gives each mover the view our redaction gives a spectator, at every decision of a game', () => {
    let checked = 0;
    let ownHidden = 0;
    const pendingSeen = new Set<string>();
    for (const seed of ['spectate-a', 'spectate-b', 'spectate-c']) {
      const memory: [Memory, Memory] = [emptyMemory(), emptyMemory()];
      walk(seed, 400, (state, before) => {
        if (state.stage === 'over') return;
        const watching = snap(state, null, before);
        for (const seat of [0, 1] as const) {
          memory[seat] = remember(memory[seat], asSeat(watching, PLAYER_ID[seat]));
        }
        const mover = state.turn as 0 | 1;
        const result = toView(asSeat(watching, PLAYER_ID[mover]), memory[mover], { spectating: true });
        expect(result.ok, result.ok ? '' : `${result.refusal.reason}: ${result.refusal.detail}`).toBe(true);
        if (!result.ok) return;
        const expected = publicViewOf(state, mover, before);
        expect(result.seat).toBe(mover);
        expect(canonical(result.view)).toEqual(canonical(expected));
        expect(result.warnings).toEqual([]);
        pendingSeen.add(state.pending?.k ?? 'none');
        if (result.view.players[mover].reserved.some((held) => 'hidden' in held)) ownHidden += 1;
        checked += 1;
      });
    }
    expect(checked).toBeGreaterThan(300);
    // The case that makes a spectator's view different from a player's: the mover's own face-down card.
    expect(ownHidden).toBeGreaterThan(0);
    for (const kind of ['none', 'discard', 'royal', 'matchingToken', 'steal']) {
      expect(pendingSeen.has(kind), `no position with pending "${kind}" was reached; add a seed`).toBe(true);
    }
  });

  it('still refuses a seat’s own faceless reservation when it is not told it is spectating', () => {
    let refused = 0;
    walk('spectate-a', 400, (state, before) => {
      if (state.stage === 'over' || refused > 0) return;
      const mover = state.turn as 0 | 1;
      if (!state.players[mover].reserved.some((held) => !held.publiclyKnown)) return;
      const relabelled = asSeat(snap(state, null, before), PLAYER_ID[mover]);
      const result = toView(relabelled, remember(emptyMemory(), relabelled));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.reason).toBe('bad-snapshot');
      refused += 1;
    });
    expect(refused).toBe(1);
  });

  it('gives the search a world to plan in, with the mover’s unseen card dealt like any other', () => {
    let dealt = 0;
    const memory: [Memory, Memory] = [emptyMemory(), emptyMemory()];
    const rng = new RandomCursor('spectate-deal', 0);
    walk('spectate-a', 400, (state, before) => {
      if (state.stage === 'over') return;
      const watching = snap(state, null, before);
      for (const seat of [0, 1] as const) memory[seat] = remember(memory[seat], asSeat(watching, PLAYER_ID[seat]));
      const mover = state.turn as 0 | 1;
      const result = toView(asSeat(watching, PLAYER_ID[mover]), memory[mover], { spectating: true });
      if (!result.ok) throw new Error(result.refusal.detail);
      if (!result.view.players[mover].reserved.some((held) => 'hidden' in held)) return;
      const world = determinizeBga(result.view, mover, rng);
      for (const held of world.players[mover].reserved) expect(held.cardId).toMatch(/^l[123]-\d\d$/);
      expect(legalActionsFromView(result.view, mover).actions.length).toBeGreaterThan(0);
      dealt += 1;
    });
    expect(dealt).toBeGreaterThan(0);
  });
});

describe('crossCheck, from the stands', () => {
  it('finds nothing to object to in a whole game, though BGA’s list names cards a spectator cannot see', () => {
    let checked = 0;
    let hiddenAffordable = 0;
    for (const seed of ['spectate-a', 'spectate-b']) {
      const memory: [Memory, Memory] = [emptyMemory(), emptyMemory()];
      walk(seed, 400, (state, before) => {
        if (state.stage === 'over') return;
        const watching = snap(state, null, before);
        for (const seat of [0, 1] as const) memory[seat] = remember(memory[seat], asSeat(watching, PLAYER_ID[seat]));
        const mover = state.turn as 0 | 1;
        const seated = asSeat(watching, PLAYER_ID[mover]);
        const result = toView(seated, memory[mover], { spectating: true });
        if (!result.ok) throw new Error(result.refusal.detail);
        const { actions } = legalActionsFromView(result.view, mover);
        const stuck = actions.length === 1 && actions[0]?.t === 'pass';
        const problems = crossCheck(result.view, mover, seated, { spectating: true });
        if (stuck) expect(problems.join(' ')).toMatch(/stuck/);
        else expect(problems).toEqual([]);
        // Without being told, the same position is a disagreement whenever BGA lists a card of the
        // mover's that a spectator has no name for.
        if (!stuck && crossCheck(result.view, mover, seated).length > 0) hiddenAffordable += 1;
        checked += 1;
      });
    }
    expect(checked).toBeGreaterThan(200);
    expect(hiddenAffordable).toBeGreaterThan(0);
  });
});
