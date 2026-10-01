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
  return async ({ action, value, view, at, before, waitWhile }) => {
    const plan = toBgaCalls(action, view, at);
    if (!plan.ok) return plan;
    say(`▶ ${describeAction(action, view)}    (search value ${signed(value)})`);

    for (const call of plan.calls) {
      try {
        await perform(call);
      } catch (error) {
        return refused(`BGA refused ${call.name}: ${error.message}`);
      }
      if (call.then && !(await waitWhile((pulse) => pulse.name !== call.then, actTimeoutMs))) {
        return refused(`After ${call.name}, the table did not reach "${call.then}" within ${Math.round(actTimeoutMs / 1000)}s.`);
      }
    }

    // The page learns the new state a moment after the call returns. Give it that moment; if it
    // never shows a change, the loop's next snapshot is a reload and settles the question anyway.
    const was = fingerprint(before);
    await waitWhile((pulse) => fingerprint(pulse) === was, actTimeoutMs);
    return { ok: true };
  };
}
