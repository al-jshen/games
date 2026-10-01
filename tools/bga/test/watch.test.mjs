import { RandomCursor } from '@games/engine';
import { apply, legalActionsFromView } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { FakeTable } from '../../../packages/bga-splendor-duel/test/support/fakeTable.ts';
import { pick } from '../../../packages/bga-splendor-duel/test/support/play.ts';
import { describeSuggestion, watchTable } from '../watch.mjs';

/**
 * Watching a game we are not in.
 *
 * The fake table here has nobody of ours at it: both seats play themselves, and the account looking
 * on is shown what BGA shows a spectator. What is under test is that every decision by either player
 * gets a suggestion, made from that player's side of the public position, and put in front of the
 * person watching while the position is still the one on the table.
 */

const randomBrain = (seed) => {
  const rng = new RandomCursor(`${seed}:brain`, 0);
  return (view, seat) => ({ action: pick(legalActionsFromView(view, seat).actions, rng), value: 0 });
};

const quiet = { say: () => {}, sleep: async () => {} };

describe('watchTable', () => {
  it('suggests a move for every decision of a whole game, for both players, before it is played', async () => {
    const table = new FakeTable('watch-a', null);
    const seen = [];
    const result = await watchTable({
      table,
      brain: randomBrain('watch-a'),
      present: async ({ seat, action, text }) => {
        // The position is still the one the suggestion is about: nothing has moved since the
        // snapshot, and the suggested move is one the engine accepts from that player right now.
        expect(table.state.turn).toBe(seat);
        expect(apply(table.state, seat, action).ok, text).toBe(true);
        seen.push(seat);
      },
      ...quiet,
    });

    expect(result.outcome).toBe('finished');
    expect(table.state.stage).toBe('over');
    expect(result.suggestions).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(30);
    expect(seen.filter((seat) => seat === 0).length).toBeGreaterThan(10);
    expect(seen.filter((seat) => seat === 1).length).toBeGreaterThan(10);
  });

  it('will not watch a table the logged-in account is playing at', async () => {
    const table = new FakeTable('watch-seated', 0);
    let presented = 0;
    const result = await watchTable({ table, brain: randomBrain('x'), present: async () => void (presented += 1), ...quiet });
    expect(result.outcome).toBe('refused');
    expect(result.why).toMatch(/seated/);
    expect(presented).toBe(0);
  });

  it('says why it has nothing to suggest for a position, and keeps watching', async () => {
    const table = new FakeTable('watch-skip', null);
    const real = table.snapshot.bind(table);
    let calls = 0;
    // The second snapshot is the first decision. Report the expansion there, and only there.
    table.snapshot = async () => {
      const raw = await real();
      calls += 1;
      if (calls === 2) raw.gamedatas.expansion = true;
      return raw;
    };
    const said = [];
    let presented = 0;
    const result = await watchTable({
      table,
      brain: randomBrain('watch-skip'),
      present: async () => void (presented += 1),
      say: (line) => said.push(line),
      sleep: async () => {},
    });
    expect(said.join('\n')).toMatch(/expansion/i);
    expect(result.outcome).toBe('finished');
    expect(presented).toBeGreaterThan(30);
  });
});

describe('describeSuggestion', () => {
  it('does not name a card for a purchase from the mover’s face-down reservations', () => {
    // The search plans in sampled worlds, so "buy reserved card l2-07" names a guess. A spectator
    // cannot see which card it is, and neither can the bot.
    const view = { players: [{ reserved: [{ hidden: true }, { cardId: 'l1-05' }] }, { reserved: [] }] };
    const hidden = describeSuggestion({ t: 'purchase', from: { t: 'reserved', cardId: 'l2-07' }, payment: { blue: 2 } }, view, 0, null);
    expect(hidden.text).toMatch(/face-down/);
    expect(JSON.stringify(hidden)).not.toMatch(/l2-07|L2/);
    expect(hidden.highlight).toEqual([]);
  });
});

describe('watchTable, with the published network', () => {
  it('searches from the stands, including when the mover holds a card nobody watching can see', async () => {
    const { loadPublished, makeBrain } = await import('../engine.mjs');
    const { PUBLISHED } = await import('../paths.mjs');
    const real = makeBrain(loadPublished(PUBLISHED), 40, 'watch-net');
    const random = randomBrain('watch-net');
    const table = new FakeTable('watch-net', null);
    let searched = 0;
    let withHidden = 0;
    const result = await watchTable({
      table,
      // The real search wherever the mover has a face-down reservation, and for the first few
      // positions regardless; the rest of the game is played out at random to keep this quick.
      brain: (view, seat, move) => {
        const hidden = view.players[seat].reserved.some((held) => 'hidden' in held);
        if (!hidden && move >= 6) return random(view, seat);
        searched += 1;
        if (hidden) withHidden += 1;
        const picked = real(view, seat, move);
        expect(picked.action).toBeDefined();
        expect(Math.abs(picked.value)).toBeLessThanOrEqual(1);
        return picked;
      },
      present: async () => {},
      ...quiet,
    });
    expect(result.outcome).toBe('finished');
    expect(searched).toBeGreaterThan(5);
    expect(withHidden).toBeGreaterThan(0);
  });
});
