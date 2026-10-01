/**
 * `play`: the bot decides, and the bot moves.
 *
 * The move is turned into BGA's own action calls and sent through the page, in order, waiting for
 * the page to reach the state each next call needs. Any refusal from BGA ends the adapter's part in
 * the game: a move BGA turned down is a disagreement about the position, and the answer to that is
 * a person, not a second attempt.
 */

import { toBgaCalls } from '@games/bga-splendor-duel';
import { describeAction } from '@games/splendor-duel';
import { fingerprint } from './loop.mjs';

const refused = (detail) => ({ ok: false, refusal: { reason: 'refused', detail } });
const signed = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

export function makePlay({ perform, say, actTimeoutMs = 15_000 }) {
  return async ({ action, value, view, at, before, pulse, waitWhile }) => {
    const plan = toBgaCalls(action, view, at);
    if (!plan.ok) return plan;
    say(`▶ ${describeAction(action, view)}    (search value ${signed(value)})`);

    const seconds = Math.round(actTimeoutMs / 1000);
    const last = plan.calls.at(-1);
    // Where the table stood just before the last call. That call ends the move, so the table must
    // move on from here; for a one-call move this is the pulse the decision was made at.
    let was = fingerprint(before);
    for (const call of plan.calls) {
      if (call === last && call !== plan.calls[0]) was = fingerprint(await pulse());
      try {
        await perform(call);
      } catch (error) {
        return refused(`BGA refused ${call.name}: ${error.message}`);
      }
      if (call.then && !(await waitWhile((p) => p.name !== call.then, actTimeoutMs))) {
        return refused(`After ${call.name}, the table did not reach "${call.then}" within ${seconds}s.`);
      }
    }

    // The page learns the new state a moment after the call returns. Give it that moment. If it
    // never shows a change, the call was accepted and did nothing -- not something to try again.
    if (!(await waitWhile((p) => fingerprint(p) === was, actTimeoutMs))) {
      return refused(`BGA accepted ${last.name}, but the table did not change within ${seconds}s.`);
    }
    return { ok: true };
  };
}
