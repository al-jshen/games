import { emptyMemory } from '@games/bga-splendor-duel';
import { RandomCursor } from '@games/engine';
import { apply, legalActions, legalActionsFromView } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { FakeTable } from '../../../packages/bga-splendor-duel/test/support/fakeTable.ts';
import { pick } from '../../../packages/bga-splendor-duel/test/support/play.ts';
import { makeAdvise } from '../advise.mjs';
import { runTable } from '../loop.mjs';
import { watchTable } from '../watch.mjs';

/**
 * A move made while the page is reloading.
 *
 * Every decision starts with a reload, and a reload takes seconds. Seen live: a player spends a
 * privilege, which makes us reload, and makes their real move "soon after" -- while that reload is
 * still in flight. The page that comes back shows the position it was loaded with. Whether it then
 * hears about the move it missed is up to BGA, and the two possibilities are both modelled here:
 *
 *   - the page catches up on its own, and its state changes under us; or
 *   - the page stays behind until the *next* move arrives, which is when BGA's notification queue
 *     notices the gap. On the other player's turn that can be a long time; on our own turn in a
 *     seated mode it is for ever, because the next move is ours and we are waiting to be told so.
 *
 * The loop has to come through both: it may say one thing about a position that is already gone,
 * but it must not sit there.
 */

/** A fake table where nobody moves unless told to, and one move can be timed to land mid-reload. */
function racingTable(seed, viewer, { pageCatchesUp }) {
  const table = new FakeTable(seed, viewer, 1_000_000);
  const real = { snapshot: table.snapshot.bind(table), pulse: table.pulse.bind(table), force: table.force.bind(table) };
  let frozen = null;
  let duringReload = null;
  let ended = false;
  let polls = 0;

  table.reloads = 0;
  table.moveDuringNextReload = (move) => {
    duringReload = move;
  };
  table.end = () => {
    ended = true;
  };
  // Any later move reaches the page as a notification, and with it everything the page had missed.
  table.force = (seat, action) => {
    frozen = null;
    real.force(seat, action);
  };
  table.snapshot = async () => {
    table.reloads += 1;
    frozen = null;
    const raw = await real.snapshot();
    if (ended) raw.gamestate.name = 'gameEnd';
    if (duringReload) {
      const loadedWith = await real.pulse();
      const move = duringReload;
      duringReload = null;
      move();
      if (!pageCatchesUp) frozen = loadedWith;
    }
    return raw;
  };
  table.pulse = async () => {
    polls += 1;
    if (polls > 2000) throw new Error('2000 polls: the loop is sitting on a position the table left long ago');
    if (ended) return { name: 'gameEnd', active: 0, args: 'null' };
    return frozen ?? real.pulse();
  };
  return table;
}

const randomBrain = (seed) => {
  const rng = new RandomCursor(`${seed}:brain`, 0);
  return (view, seat) => ({ action: pick(legalActionsFromView(view, seat).actions, rng), value: 0 });
};

function mover(table, seed) {
  const rng = new RandomCursor(`${seed}:moves`, 0);
  return () => {
    const seat = table.state.turn;
    table.force(seat, pick(legalActions(table.state, seat).actions, rng));
  };
}

/** Watch a game in which the second of two quick moves lands during the reload the first one caused. */
async function watchTwoQuickMoves(seed, pageCatchesUp) {
  const table = racingTable(seed, null, { pageCatchesUp });
  const moveNow = mover(table, seed);
  const shown = [];
  const said = [];
  const result = await watchTable({
    table,
    brain: randomBrain(seed),
    present: async ({ seat, action }) => {
      shown.push({ current: table.state.turn === seat && apply(table.state, seat, action).ok });
      if (shown.length === 1) {
        table.moveDuringNextReload(moveNow);
        moveNow();
      }
      // Stop once something has been said about the position the two moves actually led to.
      if (shown.length > 1 && shown.at(-1).current) table.end();
    },
    say: (line) => said.push(line),
    sleep: async () => {},
  });
  return { result, shown, said: said.join('\n'), table };
}

describe('a move made while the page was reloading, watched', () => {
  it('is no trouble when the page catches up by itself', async () => {
    const { result, shown, said } = await watchTwoQuickMoves('behind-a', true);
    expect(result.outcome).toBe('finished');
    // Nothing was ever said about a position that was already gone.
    expect(shown.every((s) => s.current)).toBe(true);
    expect(said).not.toMatch(/fallen behind/);
  });

  it('is noticed, and caught up with, when the page stays behind', async () => {
    const { result, shown, said } = await watchTwoQuickMoves('behind-a', false);
    expect(result.outcome).toBe('finished');
    // One suggestion about the position the page was stuck on is unavoidable: the page said so.
    expect(shown.filter((s) => !s.current)).toHaveLength(1);
    // And then it finds out, says so, and carries on with the table as it really is.
    expect(shown.at(-1).current).toBe(true);
    expect(said).toMatch(/fallen behind/);
  });
});

describe('a move made while the page was reloading, at our own seat', () => {
  it('does not leave us waiting for an opponent who has already moved', async () => {
    const seed = 'behind-seat';
    const table = racingTable(seed, 0, { pageCatchesUp: false });
    const opponentMoves = mover(table, seed);
    while (table.state.turn !== 0) opponentMoves();

    const advised = [];
    const said = [];
    const act = makeAdvise({
      present: async ({ seat, action }) => {
        advised.push({ current: table.state.turn === seat && apply(table.state, seat, action).ok });
        if (advised.length === 1) {
          // We move; the reload that follows is still loading when the opponent replies in full.
          table.moveDuringNextReload(() => {
            while (table.state.turn !== 0 && table.state.stage !== 'over') opponentMoves();
          });
          table.play(action);
        } else {
          table.end();
        }
      },
    });
    const result = await runTable({
      table,
      // A single token: a move that always ends the turn from the opening.
      brain: (view, seat) => {
        const { actions } = legalActionsFromView(view, seat);
        return { action: actions.find((a) => a.t === 'takeTokens' && a.cells.length === 1) ?? actions[0], value: 0 };
      },
      act,
      memory: emptyMemory(),
      say: (line) => said.push(line),
      sleep: async () => {},
    });

    expect(result.outcome, JSON.stringify(result.refusal)).toBe('finished');
    // The second piece of advice is about our real next turn: it was asked for, not waited for in vain.
    expect(advised).toEqual([{ current: true }, { current: true }]);
    expect(said.join('\n')).toMatch(/fallen behind/);
  });
});
