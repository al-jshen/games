/**
 * One table, from the first snapshot to the end of the game or to a stop.
 *
 *   settle   wait until the page rests on a decision we cover, on someone else's turn, or at the end
 *   look     take a fresh, full snapshot and fold it into memory
 *   decide   translate it, check our rules against BGA's, search
 *   act      hand the move to a strategy -- tell a person, or perform it
 *
 * **There is one loop, and `watch`, `advise` and `play` are all it.** They differ in three settings
 * and nothing else:
 *
 *   - whose decisions are covered: our own seat's (`advise`, `play`), or both players' from the
 *     stands (`watch`, `spectating`);
 *   - what a doubt does: stops and hands the game to the operator (`advise`, `play`), or is said
 *     aloud and skipped, since the game is not ours to stop (`watch`);
 *   - the strategy: tell a person and wait for the table to move (`watch` and `advise`, the very
 *     same one), or perform the move (`play`).
 *
 * That is deliberate. Reading the page, remembering, translating, cross-checking, searching,
 * wording the move and waiting for the table are the parts that can be wrong about BGA, and they are
 * the same code whichever mode is running. So a `watch` that works at a live table has exercised
 * nearly all of `advise`; what it has not is listed in README.md.
 *
 * Everything that touches a page is passed in as `table`, which is why this can be run against a
 * table made of our own engine in a test.
 *
 * Two rules shape it. Every decision starts from a fresh snapshot, never from what we expect the
 * last move to have done -- so it does not matter whether the last move was ours, the operator's,
 * or not the one advised. And nothing unsure is ever acted on: the loop never retries a guess.
 */

import { asSeat, crossCheck, emptyMemory, isSeated, locate, parseSnapshot, remember, stateKind, toView } from '@games/bga-splendor-duel';
import { describeSuggestion } from './suggest.mjs';

/** Everything the page says about where the game is, without a reload. Changes when anything is done. */
export const fingerprint = (pulse) => `${pulse.name}|${pulse.active}|${pulse.args}`;

/** The pulse the page would have given at the moment this snapshot was taken. */
export const pulseOf = (snapshot) => ({
  name: snapshot.gamestate.name,
  active: Number(snapshot.gamestate.active_player ?? 0),
  args: JSON.stringify(snapshot.gamestate.args ?? null),
});

/** What an error said, with its kind when that is more than plain `Error` -- a `TypeError` is a bug here, not BGA. */
function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
}

/**
 * Follow a table. `runTable` and `watchTable` are this with their settings filled in.
 *
 * A throw from anywhere inside -- a reload that failed, a page that moved to another table, a
 * strategy or a search that threw -- leaves a game in progress, and the stop path is what deals with
 * that: the bell, the saved snapshot and the result row for our own game, a plain reason for one we
 * were watching. A rejection would skip all of it, so it becomes a stop.
 */
export async function followTable(options) {
  const counts = { moves: 0, raw: null };
  try {
    return await follow(options, counts);
  } catch (error) {
    return {
      outcome: 'stopped',
      refusal: { reason: 'page-error', detail: `Stopped on an error: ${describeError(error)}` },
      moves: counts.moves,
      raw: counts.raw,
    };
  }
}

/** Our own seat: every doubt is a stop, and the game is handed to the operator. */
export function runTable(options) {
  return followTable({ ...options, spectating: false, onDoubt: 'stop' });
}

async function follow(
  {
    table,
    brain,
    act,
    say,
    sleep,
    spectating = false,
    onDoubt = 'stop',
    memory = emptyMemory(),
    onMemory = () => {},
    pollMs = 500,
    patienceMs = 30_000,
    midActionPatienceMs = Infinity,
  },
  counts,
) {
  const stopped = (refusal) => ({ outcome: 'stopped', refusal, moves: counts.moves, raw: counts.raw });
  const look = async () => {
    counts.raw = await table.snapshot();
    return parseSnapshot(counts.raw);
  };

  const first = await look();
  if (!first.ok) return stopped(first.refusal);
  const me = first.snapshot.me;
  const seated = isSeated(first.snapshot);
  // Each way of following a table is for one kind of table, and refuses the other. From the stands
  // nothing is sent and nobody is told, which is right only for a game that is not ours; our own
  // seat goes through the caller's guard, which is what `advise` and `play` exist to pass.
  if (spectating && seated) {
    return stopped({
      reason: 'seated',
      detail: 'The logged-in account is seated at this table. `watch` is for games you are not in; your own seat goes through `advise`.',
    });
  }
  if (!spectating && !seated) {
    return stopped({ reason: 'spectator', detail: 'The logged-in account is not seated at this table.' });
  }

  // One memory per seat we cover, each fed the snapshot as seen from that seat: what a player owned
  // when their turn began, and which cards they have seen face-up, are facts about a seat. From our
  // own seat that is one memory, the caller's; from the stands it is one for each player.
  const memories = new Map(
    spectating ? Object.values(first.snapshot.gamedatas.players).map((player) => [player.id, emptyMemory()]) : [[me, memory]],
  );

  /** What a pulse means: a decision `ours` to cover, `theirs`, `wait` (mid-action), `over`, or `unknown`. */
  const where = (pulse) => {
    const kind = stateKind(pulse.name);
    if (kind === 'over') return 'over';
    if (!memories.has(pulse.active)) return 'theirs';
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
   *
   * The middle of an action is given `midActionPatienceMs`. Where a person makes the clicks that is
   * for ever: they may sit between the two clicks of one move as long as they like. In `play` the
   * program made the first click itself, so a table still waiting for the second means the second
   * never landed, and waiting longer will not change that.
   */
  const settle = async () => {
    let last = null;
    let lost = 0;
    let midway = 0;
    for (;;) {
      const pulse = await table.pulse();
      const at = where(pulse);
      lost = at === 'unknown' ? lost + pollMs : 0;
      if (lost >= patienceMs) return { at, pulse };
      midway = at === 'wait' ? midway + pollMs : 0;
      if (midway >= midActionPatienceMs) return { at, pulse };
      const print = fingerprint(pulse);
      if ((at === 'ours' || at === 'theirs' || at === 'over') && print === last) return { at, pulse };
      last = print;
      await sleep(pollMs);
    }
  };

  /**
   * A position that cannot be vouched for. At our own seat that is a stop. From the stands it is
   * said aloud and waited out: resolves to `null`, once the table has moved on from `position`.
   */
  const doubt = async (refusal, position) => {
    if (onDoubt === 'stop') return stopped(refusal);
    say(`  nothing to suggest here (${refusal.reason}): ${refusal.detail}`);
    if (position === null) await sleep(pollMs);
    else await waitWhile((pulse) => fingerprint(pulse) === position);
    return null;
  };

  for (;;) {
    const { at, pulse } = await settle();
    if (at === 'unknown' || at === 'wait') {
      const refusal =
        at === 'unknown'
          ? {
              reason: 'unknown-state',
              detail: `The table has sat in BGA state "${pulse.name}" for ${Math.round(patienceMs / 1000)}s, and there is no translation for it.`,
            }
          : {
              reason: 'mid-action',
              detail: `The table has sat in BGA state "${pulse.name}", the middle of one of our actions, for ${Math.round(midActionPatienceMs / 1000)}s. Finish or cancel it by hand.`,
            };
      const stop = await doubt(refusal, fingerprint(pulse));
      if (stop) return stop;
      continue;
    }

    const parsed = await look();
    if (!parsed.ok) {
      const stop = await doubt(parsed.refusal, null);
      if (stop) return stop;
      continue;
    }
    const snapshot = parsed.snapshot;
    if (stateKind(snapshot.gamestate.name) === 'over') {
      return { outcome: 'finished', moves: counts.moves, snapshot, raw: counts.raw };
    }

    // Every snapshot is remembered, including one taken on a turn that is not ours to cover: that
    // one is what tells memory how the next turn began.
    for (const [id, held] of memories) {
      const next = remember(held, asSeat(snapshot, id));
      memories.set(id, next);
      if (id === me) onMemory(next);
    }

    // The position the decision is about, as a pulse: taken from the snapshot itself, so there is no
    // moment between the two for the table to move in.
    const before = pulseOf(snapshot);
    const position = fingerprint(before);
    const mover = snapshot.gamestate.active_player;
    if (!memories.has(mover)) {
      await waitWhile((p) => where(p) === 'theirs');
      continue;
    }
    // Reloaded into the middle of an action, or into a state with no name: `settle` waits those out.
    if (stateKind(snapshot.gamestate.name) !== 'decision') continue;

    const seat = asSeat(snapshot, mover);
    const translated = toView(seat, memories.get(mover), { spectating });
    if (!translated.ok) {
      const stop = await doubt(translated.refusal, position);
      if (stop) return stop;
      continue;
    }
    const problems = crossCheck(translated.view, translated.seat, seat, { spectating });
    if (problems.length > 0) {
      const stop = await doubt({ reason: 'disagreement', detail: problems.join(' ') }, position);
      if (stop) return stop;
      continue;
    }
    for (const warning of translated.warnings) say(`  note: ${warning}`);

    const { action, value } = brain(translated.view, translated.seat, counts.moves);
    // A search takes a second or more. If the table moved in that time, what was found is about a
    // position that is gone: say nothing, send nothing, and look again.
    if (fingerprint(await table.pulse()) !== position) continue;
    counts.moves += 1;

    const at2 = locate(seat);
    const instruction = describeSuggestion(action, translated.view, translated.seat, at2);
    const outcome = await act({
      action,
      value,
      view: translated.view,
      seat: translated.seat,
      playerId: mover,
      name: Object.values(snapshot.gamedatas.players).find((player) => player.id === mover)?.name ?? null,
      instruction,
      ...instruction,
      at: at2,
      before,
      pulse: () => table.pulse(),
      waitWhile,
    });
    if (!outcome.ok) return stopped(outcome.refusal);
  }
}
