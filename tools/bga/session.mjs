/**
 * How every command that sits at or watches a table begins.
 *
 * One look at the table, and a line per player: who they are, what they are rated, and which of
 * them, if either, is us. `watch`, `advise` and `play` all start here, with the same snapshot read
 * the same way -- so the first thing a live `watch` proves is the first thing `advise` does.
 *
 * What it read is handed back, for the caller to decide what it may do at this table.
 */

import { isSeated, parseSnapshot } from '@games/bga-splendor-duel';
import { whoIs } from './suggest.mjs';

export async function introduce({ table, say }) {
  const parsed = parseSnapshot(await table.snapshot());
  if (!parsed.ok) return { ok: false, why: parsed.refusal.detail };
  const snapshot = parsed.snapshot;
  const players = Object.values(snapshot.gamedatas.players).sort((a, b) => a.playerNo - b.playerNo);

  // A rating is for the person reading and for the results log; nothing is decided by it. So a
  // table that will not say is still a table, with its ratings marked as not shown.
  const facts = await table.facts(players.map((player) => player.id)).catch((error) => {
    say(`  could not ask BGA about this table: ${error instanceof Error ? error.message : String(error)}`);
    return { info: null, ratings: {} };
  });

  for (const player of players) {
    const rating = facts.ratings[player.id];
    say(
      `  ${whoIs({ name: player.name, playerId: player.id, seat: player.playerNo - 1 })}` +
        ` — ${Number.isFinite(rating) ? `rated ${rating}` : 'rating not shown'}` +
        ` — BGA player ${player.id}` +
        (player.id === snapshot.me ? ' — you' : ''),
    );
  }
  return { ok: true, snapshot, facts, seated: isSeated(snapshot) };
}
