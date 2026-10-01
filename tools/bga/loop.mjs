/**
 * One table, from the first snapshot to the end of the game or to a stop.
 *
 *   settle   wait until the page rests on our decision, on the opponent's turn, or at the end
 *   look     take a fresh, full snapshot and fold it into memory
 *   decide   translate it, check our rules against BGA's, search
 *   act      hand the move to a strategy -- tell the operator, or perform it
 *
 * The strategy is the only difference between `advise` and `play`, and it is passed in. Everything
 * that touches a page is passed in as `table`, which is why this can be run against a table made of
 * our own engine in a test.
 *
 * Two rules shape it. Every decision starts from a fresh snapshot, never from what we expect the
 * last move to have done -- so it does not matter whether the last move was ours, the operator's,
 * or not the one advised. And every way of being unsure is a stop, returned to the caller with the
 * snapshot that caused it: the loop never retries a guess.
 */

import { crossCheck, locate, parseSnapshot, remember, stateKind, toView } from '@games/bga-splendor-duel';

/** Everything the page says about where the game is, without a reload. Changes when anything is done. */
export const fingerprint = (pulse) => `${pulse.name}|${pulse.active}|${pulse.args}`;

export async function runTable({ table, brain, act, say, sleep, memory, onMemory = () => {}, pollMs = 500, patienceMs = 30_000 }) {
  let moves = 0;
  let raw = null;
  const stopped = (refusal) => ({ outcome: 'stopped', refusal, moves, raw });
  const look = async () => {
    raw = await table.snapshot();
    return parseSnapshot(raw);
  };

  let parsed = await look();
  if (!parsed.ok) return stopped(parsed.refusal);
  const me = parsed.snapshot.me;
  if (!Object.values(parsed.snapshot.gamedatas.players).some((p) => p.id === me)) {
    return stopped({ reason: 'spectator', detail: 'The logged-in account is not seated at this table.' });
  }

  /** What a pulse means for us: `ours` to decide, `theirs`, `wait` (mid-action), `over`, or `unknown`. */
  const where = (pulse) => {
    const kind = stateKind(pulse.name);
    if (kind === 'over') return 'over';
    if (pulse.active !== me) return 'theirs';
    if (kind === 'decision') return 'ours';
    return kind === 'mid-action' ? 'wait' : 'unknown';
  };

  /** Poll until `holds(pulse)` stops being true. Resolves false if `timeoutMs` passes first. */
  const waitWhile = async (holds, timeoutMs = Infinity) => {
    for (let waited = 0; ; waited += pollMs) {
      if (!holds(await table.pulse())) return true;
      if (waited >= timeoutMs) return false;
      await sleep(pollMs);
    }
  };

  /**
   * Wait for the page to rest somewhere we can act on, and to have rested there for two polls
   * running -- BGA passes through transient states between turns, and a reload in the middle of one
   * is a snapshot of nothing. A state we have no name for is given `patienceMs` to pass.
   */
  const settle = async () => {
    let last = null;
    let lost = 0;
    for (;;) {
      const pulse = await table.pulse();
      const at = where(pulse);
      lost = at === 'unknown' ? lost + pollMs : 0;
      if (lost >= patienceMs) return { at, pulse };
      const print = fingerprint(pulse);
      if ((at === 'ours' || at === 'theirs' || at === 'over') && print === last) return { at, pulse };
      last = print;
      await sleep(pollMs);
    }
  };

  for (;;) {
    const { at, pulse } = await settle();
    if (at === 'unknown') {
      return stopped({
        reason: 'unknown-state',
        detail: `The table has sat in BGA state "${pulse.name}" for ${Math.round(patienceMs / 1000)}s, and there is no translation for it.`,
      });
    }

    parsed = await look();
    if (!parsed.ok) return stopped(parsed.refusal);
    const snapshot = parsed.snapshot;
    if (stateKind(snapshot.gamestate.name) === 'over') return { outcome: 'finished', moves, snapshot, raw };

    // Every snapshot is remembered, including the one taken on the opponent's turn: that one is
    // what tells memory how our next turn began.
    memory = remember(memory, snapshot);
    onMemory(memory);

    // The pulse the decision is made at. Taken before the search, so that anything done to the
    // table while we think shows up as a change afterwards.
    const before = await table.pulse();
    const ours =
      snapshot.gamestate.active_player === me &&
      stateKind(snapshot.gamestate.name) === 'decision' &&
      before.name === snapshot.gamestate.name &&
      before.active === me;
    if (!ours) {
      await waitWhile((p) => where(p) === 'theirs');
      continue;
    }

    const translated = toView(snapshot, memory);
    if (!translated.ok) return stopped(translated.refusal);
    const problems = crossCheck(translated.view, translated.seat, snapshot);
    if (problems.length > 0) return stopped({ reason: 'disagreement', detail: problems.join(' ') });
    for (const warning of translated.warnings) say(`  note: ${warning}`);

    const { action, value } = brain(translated.view, translated.seat, moves);
    moves += 1;
    const outcome = await act({ action, value, view: translated.view, seat: translated.seat, at: locate(snapshot), before, waitWhile });
    if (!outcome.ok) return stopped(outcome.refusal);
  }
}
