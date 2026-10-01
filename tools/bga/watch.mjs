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
 * Unlike the playing loop, nothing here is a stop. A position it cannot translate, or one where our
 * rules and BGA's disagree, is said out loud and skipped: the game goes on without us either way,
 * and those are exactly the positions worth hearing about while the adapter is being calibrated.
 */

import {
  asSeat,
  crossCheck,
  emptyMemory,
  instruct,
  isSeated,
  locate,
  parseSnapshot,
  remember,
  stateKind,
  toView,
} from '@games/bga-splendor-duel';
import { fingerprint } from './loop.mjs';

/** The fingerprint a pulse would have at the moment this snapshot was taken. */
const fingerprintOf = (snapshot) =>
  fingerprint({
    name: snapshot.gamestate.name,
    active: Number(snapshot.gamestate.active_player ?? 0),
    args: JSON.stringify(snapshot.gamestate.args ?? null),
  });

/**
 * The suggestion, in words.
 *
 * `instruct` does the work, with one exception. The search plans in sampled worlds, where the
 * mover's face-down reservations have been dealt a card each; a suggestion to buy one of those
 * names a guess, and saying the guess aloud would read as knowledge nobody watching has.
 */
export function describeSuggestion(action, view, seat, at) {
  if (action.t === 'purchase' && action.from.t === 'reserved') {
    const known = view.players[seat].reserved.some((held) => 'cardId' in held && held.cardId === action.from.cardId);
    if (!known) {
      return {
        text: 'Buy one of their face-down reserved cards',
        steps: ['Which card that is cannot be seen from the stands; the search only knows it would be worth buying.'],
        highlight: [],
      };
    }
  }
  return instruct(action, view, at);
}

/** Who is to move, as a person watching would say it: by the name on the table, or failing that BGA's number. */
export function whoIs({ name, playerId, seat }) {
  const shown = typeof name === 'string' && name.trim() !== '' ? name.trim() : `player ${playerId}`;
  return `${shown} (seat ${seat + 1})`;
}

export async function watchTable({ table, brain, present, say, sleep, pollMs = 500 }) {
  const first = parseSnapshot(await table.snapshot());
  if (!first.ok) return { outcome: 'refused', why: first.refusal.detail };
  if (isSeated(first.snapshot)) {
    return {
      outcome: 'refused',
      why: 'The logged-in account is seated at this table. `watch` is for games you are not in; your own seat goes through `advise`.',
    };
  }

  const seats = Object.values(first.snapshot.gamedatas.players).sort((a, b) => a.playerNo - b.playerNo);
  for (const player of seats) {
    say(`  ${whoIs({ name: player.name, playerId: player.id, seat: player.playerNo - 1 })} is BGA player ${player.id}`);
  }

  // One memory per player, each fed the snapshot as seen from that player's seat: what they owned
  // when their turn began, and which cards have been face-up, are facts about a seat.
  const memories = new Map(Object.values(first.snapshot.gamedatas.players).map((player) => [player.id, emptyMemory()]));
  let suggestions = 0;

  const waitWhile = async (holds) => {
    while (holds(await table.pulse())) await sleep(pollMs);
  };

  /** Wait until the page has rested, for two polls running, on somebody's decision or on the end. */
  const settle = async () => {
    let last = null;
    for (;;) {
      const pulse = await table.pulse();
      const kind = stateKind(pulse.name);
      const print = fingerprint(pulse);
      if ((kind === 'decision' || kind === 'over') && print === last) return;
      last = print;
      await sleep(pollMs);
    }
  };

  for (;;) {
    await settle();
    const parsed = parseSnapshot(await table.snapshot());
    if (!parsed.ok) {
      say(`  cannot read this position: ${parsed.refusal.detail}`);
      await sleep(pollMs);
      continue;
    }
    const snapshot = parsed.snapshot;
    if (stateKind(snapshot.gamestate.name) === 'over') return { outcome: 'finished', suggestions, snapshot };

    const position = fingerprintOf(snapshot);
    const mover = snapshot.gamestate.active_player;
    for (const [id, memory] of memories) memories.set(id, remember(memory, asSeat(snapshot, id)));

    if (stateKind(snapshot.gamestate.name) === 'decision' && memories.has(mover)) {
      const seated = asSeat(snapshot, mover);
      const translated = toView(seated, memories.get(mover), { spectating: true });
      if (!translated.ok) {
        say(`  nothing to suggest here (${translated.refusal.reason}): ${translated.refusal.detail}`);
      } else {
        const { view, seat, warnings } = translated;
        const problems = crossCheck(view, seat, seated, { spectating: true });
        if (problems.length > 0) {
          say(`  nothing to suggest here: our rules and BGA's differ. ${problems.join(' ')}`);
        } else {
          for (const warning of warnings) say(`  note: ${warning}`);
          const { action, value } = brain(view, seat, suggestions);
          suggestions += 1;
          const name = Object.values(snapshot.gamedatas.players).find((player) => player.id === mover)?.name ?? null;
          await present({ seat, playerId: mover, name, action, value, ...describeSuggestion(action, view, seat, locate(seated)) });
        }
      }
    }

    // Until the table moves on from the position just looked at, there is nothing new to say.
    await waitWhile((pulse) => fingerprint(pulse) === position);
  }
}
