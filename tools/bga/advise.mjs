/**
 * `advise`: the bot decides, a person moves.
 *
 * Nothing is ever submitted from here. The move is put in front of the operator, and then this
 * waits for the table to change -- by any means. If the operator plays something else, the next
 * snapshot is of the position that produced, and the next advice is about that.
 */

import { instruct } from '@games/bga-splendor-duel';
import { fingerprint } from './loop.mjs';

export function makeAdvise({ present }) {
  return async ({ action, value, view, at, before, waitWhile }) => {
    await present({ instruction: instruct(action, view, at), action, value });
    const was = fingerprint(before);
    await waitWhile((pulse) => fingerprint(pulse) === was);
    return { ok: true };
  };
}
