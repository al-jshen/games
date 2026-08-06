import type { Seat } from '@games/engine';
import splendorDuel, { determinize, evaluate, redactFor, sampleAction } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { withConfig } from '../src/config.js';
import { createSearcher, type SearchDeps } from '../src/search.js';

/**
 * Reusing the tree between moves, under imperfect information.
 *
 * The hazard is specific and it bit for real: a retained node pools statistics from many *sampled*
 * worlds, and a chance event between two searches makes those worlds diverge in public state. After
 * the opponent replenishes — which draws different tokens in every sample — the node holds moves that
 * were legal against boards that never happened. Self-play died on one: a reserve against a cell that
 * held gold only in the search's imagination.
 */

const deps = {
  mod: splendorDuel,
  determinize,
  sampleAction,
  evaluate: (state, seat) => evaluate(state, seat),
} as unknown as SearchDeps<unknown, unknown, unknown, unknown>;

const viewFor = (state: unknown, seat: Seat) =>
  JSON.parse(JSON.stringify(redactFor(seat, state as never)));

describe('tree reuse', () => {
  it('never proposes a move the position refuses, over a full game', () => {
    /*
     * Played out rather than unit-tested, because the failure needs a chance event to sit between two
     * searches of the same tree. A single position cannot reproduce it.
     */
    const config = withConfig({ iterations: 60, reuseTree: true, seed: 'reuse' });
    for (let game = 0; game < 6; game++) {
      const searchers = [createSearcher(deps, { ...config, seed: `r${game}:0` }), createSearcher(deps, { ...config, seed: `r${game}:1` })];
      let state: unknown = splendorDuel.setup({
        seed: `reuse-${game}`,
        seats: [0, 1],
        options: { maxTurnsWithoutPurchase: 60 },
      });

      for (let move = 0; move < 200; move++) {
        if (splendorDuel.outcome(state as never).status === 'over') break;
        const seat = splendorDuel.currentActors(state as never)[0];
        if (seat === undefined) break;
        const action = searchers[seat]!.choose(viewFor(state, seat), seat).action;
        const result = splendorDuel.apply(state as never, seat, action as never);
        // The assertion that matters: everything the search returns is playable.
        expect(result.ok, `game ${game} move ${move}: ${JSON.stringify(action)}`).toBe(true);
        if (!result.ok) break;
        state = result.state;
        for (const searcher of searchers) searcher.observe(action);
      }
    }
  });

  it('actually inherits work, rather than silently starting fresh', () => {
    // A reuse that never finds its way forward would pass the test above by doing nothing.
    const config = withConfig({ iterations: 80, reuseTree: true, seed: 'inherit' });
    const searchers = [createSearcher(deps, { ...config, seed: 'i0' }), createSearcher(deps, { ...config, seed: 'i1' })];
    let state: unknown = splendorDuel.setup({ seed: 'inherit', seats: [0, 1], options: {} });
    let inheritedTotal = 0;
    let searches = 0;

    for (let move = 0; move < 40; move++) {
      if (splendorDuel.outcome(state as never).status === 'over') break;
      const seat = splendorDuel.currentActors(state as never)[0];
      if (seat === undefined) break;
      const result = searchers[seat]!.choose(viewFor(state, seat), seat);
      inheritedTotal += result.inherited;
      searches += 1;
      const applied = splendorDuel.apply(state as never, seat, result.action as never);
      if (!applied.ok) break;
      state = applied.state;
      for (const searcher of searchers) searcher.observe(result.action);
    }

    expect(searches).toBeGreaterThan(20);
    expect(inheritedTotal, 'nothing was ever carried between moves').toBeGreaterThan(0);
  });

  it('carries nothing when reuse is off', () => {
    const config = withConfig({ iterations: 40, reuseTree: false, seed: 'off' });
    const searcher = createSearcher(deps, config);
    let state: unknown = splendorDuel.setup({ seed: 'off', seats: [0, 1], options: {} });
    for (let move = 0; move < 8; move++) {
      const seat = splendorDuel.currentActors(state as never)[0];
      if (seat === undefined) break;
      const result = searcher.choose(viewFor(state, seat), seat);
      expect(result.inherited).toBe(0);
      const applied = splendorDuel.apply(state as never, seat, result.action as never);
      if (!applied.ok) break;
      state = applied.state;
      searcher.observe(result.action);
    }
  });
});
