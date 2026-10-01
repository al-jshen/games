/**
 * Telling a person: the bot decides, somebody else moves.
 *
 * Nothing is ever submitted from here. The move is put in front of whoever is at the terminal, and
 * then this waits for the table to change -- by any means. If something else is played, the next
 * snapshot is of the position that produced, and the next suggestion is about that.
 *
 * This is the whole strategy of `advise`, where the person at the terminal is the one who clicks,
 * and equally of `watch`, where nobody at the terminal clicks at all. It is one function on purpose:
 * what `watch` shows at a live table is, to the letter, what `advise` would have shown.
 */

import { fingerprint } from './loop.mjs';

export function makeAdvise({ present }) {
  return async ({ before, waitWhile, pulse: _pulse, at: _at, view: _view, ...suggestion }) => {
    // `suggestion` is who is to move (`seat`, `playerId`, `name`), the move (`action`, `value`), and
    // its wording (`instruction`, and the same `text`, `steps`, `highlight` laid flat).
    await present(suggestion);
    const was = fingerprint(before);
    await waitWhile((pulse) => fingerprint(pulse) === was);
    return { ok: true };
  };
}
