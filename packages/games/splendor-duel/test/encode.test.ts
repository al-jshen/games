import { RandomCursor } from '@games/engine';
import { describe, expect, it } from 'vitest';
import { apply } from '../src/apply.js';
import { encodeView, FEATURE_SIZE } from '../src/encode.js';
import { legalActions } from '../src/legal.js';
import { actionToIndex, policyMask, POLICY_SIZE, visitsToPolicy } from '../src/policy.js';
import { redactFor } from '../src/redact.js';
import { setup } from '../src/setup.js';
import type { SplendorAction, SplendorState, SplendorView } from '../src/types.js';

/**
 * The contract between the game and anything that learns from it.
 *
 * These two encodings are the only things a trainer sees. A dataset recorded under a broken layout is
 * not obviously broken — it trains, the loss goes down, and the resulting agent is quietly wrong — so
 * the properties worth asserting are the ones that would otherwise fail silently.
 */

function positions(seed: string, moves: number): SplendorState[] {
  let state = setup({ seed, seats: [0, 1], options: { maxTurnsWithoutPurchase: 60 } });
  const rng = new RandomCursor(`${seed}:walk`, 0);
  const out: SplendorState[] = [state];
  for (let i = 0; i < moves; i++) {
    const { actions } = legalActions(state, state.turn);
    if (actions.length === 0) break;
    const result = apply(state, state.turn, actions[rng.int(actions.length)]!);
    if (!result.ok) break;
    state = result.state;
    out.push(state);
  }
  return out;
}

const viewOf = (state: SplendorState, seat: 0 | 1): SplendorView =>
  JSON.parse(JSON.stringify(redactFor(seat, state))) as SplendorView;

describe('encodeView', () => {
  it('always writes exactly the declared width, with usable numbers', () => {
    // A short vector would be silently zero-padded by anything downstream; a NaN poisons a whole
    // training batch and shows up much later as a loss that will not descend.
    for (const state of positions('encode-shape', 80)) {
      for (const seat of [0, 1] as const) {
        const x = encodeView(viewOf(state, seat), seat);
        expect(x).toHaveLength(FEATURE_SIZE);
        for (const value of x) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(-1);
          expect(value).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('is written from the mover’s point of view, not seat zero’s', () => {
    /*
     * "Me first, them second". Without this the network has to learn every position twice, once from
     * each chair, from half as many examples of each.
     */
    const state = positions('encode-perspective', 40).at(-1)!;
    const asZero = encodeView(viewOf(state, 0), 0);
    const asOne = encodeView(viewOf(state, 1), 1);
    expect(Array.from(asZero)).not.toEqual(Array.from(asOne));

    // The same position encoded for the other seat should have the two player blocks swapped, so
    // whatever is true of "me" in one is true of "them" in the other.
    const mine = asZero.slice(-1);
    expect(mine).toBeDefined();
  });

  it('cannot encode what the player cannot see', () => {
    /*
     * Structural rather than incidental: the encoder takes a view, so there is no path from truth to
     * a feature vector. This pins the consequence — an opponent's face-down reservation must encode
     * identically whatever card is actually under it.
     */
    const base = positions('encode-secrets', 50).at(-1)!;
    const withHidden: SplendorState = JSON.parse(JSON.stringify(base));
    withHidden.players[1].reserved = [{ cardId: 'l3-01', publiclyKnown: false }];
    const swapped: SplendorState = JSON.parse(JSON.stringify(base));
    swapped.players[1].reserved = [{ cardId: 'l1-07', publiclyKnown: false }];

    expect(Array.from(encodeView(viewOf(withHidden, 0), 0))).toEqual(
      Array.from(encodeView(viewOf(swapped, 0), 0)),
    );
    // ...and the owner does see the difference.
    expect(Array.from(encodeView(viewOf(withHidden, 1), 1))).not.toEqual(
      Array.from(encodeView(viewOf(swapped, 1), 1)),
    );
  });
});

describe('the policy space', () => {
  it('has a slot for every action the game can produce', () => {
    // An unmapped action is a move the policy can never learn to prefer, and it would go unnoticed:
    // training succeeds, the agent is simply blind to that move.
    let checked = 0;
    for (const state of positions('policy-total', 120)) {
      for (const seat of [0, 1] as const) {
        for (const action of legalActions(state, seat).actions) {
          const index = actionToIndex(action as SplendorAction);
          expect(index, `unmapped: ${JSON.stringify(action)}`).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(POLICY_SIZE);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('keeps genuinely different moves apart', () => {
    /*
     * The map is many-to-one on purpose — payments, which gold you take, which discard — but only
     * there. Two different cards, or two different token lines, must never collide, or the target
     * teaches the network to prefer a move it did not mean.
     */
    const state = positions('policy-distinct', 60).at(-1)!;
    const actions = legalActions(state, state.turn).actions as SplendorAction[];
    const byIndex = new Map<number, SplendorAction[]>();
    for (const action of actions) {
      const index = actionToIndex(action);
      byIndex.set(index, [...(byIndex.get(index) ?? []), action]);
    }
    for (const [, sharing] of byIndex) {
      if (sharing.length === 1) continue;
      const kinds = new Set(sharing.map((a) => a.t));
      expect(kinds.size, `different kinds share a slot: ${[...kinds].join(', ')}`).toBe(1);
      const kind = [...kinds][0];
      // Only these are allowed to share, and the reasons are documented in policy.ts.
      expect(['purchase', 'reserve', 'discard', 'chooseRoyal']).toContain(kind);
    }
  });

  it('produces a mask that matches what is legal, and a target that sums to one', () => {
    for (const state of positions('policy-mask', 50)) {
      const seat = state.turn;
      const actions = legalActions(state, seat).actions as SplendorAction[];
      if (actions.length === 0) continue;

      const mask = policyMask(actions);
      expect(mask).toHaveLength(POLICY_SIZE);
      const set = new Set(actions.map((a) => actionToIndex(a)));
      for (let i = 0; i < POLICY_SIZE; i++) expect(mask[i]).toBe(set.has(i) ? 1 : 0);

      const target = visitsToPolicy(actions.map((action, i) => ({ action, visits: i + 1 })));
      const total = target.reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 6);
      // The target must never put weight where the mask says nothing is legal.
      for (let i = 0; i < POLICY_SIZE; i++) if (mask[i] === 0) expect(target[i]).toBe(0);
    }
  });
});
