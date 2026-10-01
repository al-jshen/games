/**
 * `watch`: a game we are not in, with the bot's opinion of each position.
 *
 * Read-only from end to end. Nothing is sent to the table, nobody at it is ours, and so none of the
 * conditions `advise` and `play` run under apply -- there is no opponent to tell and no rating of
 * ours at stake. The one condition it has is the mirror of theirs: it will not run on a table the
 * logged-in account is seated at. A seat of our own goes through `advise`, and its guard.
 *
 * A spectator is shown the public position and nothing else, so what is suggested for each player
 * is what the bot would play in their seat knowing only what an onlooker knows: their face-down
 * reservations are as unknown to it as to anyone watching.
 *
 * It is the same loop `advise` runs, with the same strategy, set to cover both seats from the
 * stands (see `loop.mjs`). The one difference in behaviour is what a doubt does. A position it
 * cannot translate, or one where our rules and BGA's disagree, is said out loud and skipped: the
 * game goes on without us either way, and those are exactly the positions worth hearing about.
 */

import { makeAdvise } from './advise.mjs';
import { followTable } from './loop.mjs';

export { describeSuggestion, whoIs } from './suggest.mjs';

export async function watchTable({ table, brain, present, say, sleep, pollMs = 500 }) {
  const result = await followTable({
    table,
    brain,
    act: makeAdvise({ present }),
    say,
    sleep,
    pollMs,
    spectating: true,
    onDoubt: 'skip',
    // Nobody's game is waiting on us, so a state with no name is simply waited out.
    patienceMs: Infinity,
  });
  const watched = { ...result, suggestions: result.moves };
  if (result.outcome === 'stopped' && result.refusal.reason === 'seated') {
    return { ...watched, outcome: 'refused', why: result.refusal.detail };
  }
  return watched;
}
