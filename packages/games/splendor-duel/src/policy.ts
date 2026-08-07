import { ALL_LINES } from './spiral.js';
import type { SplendorAction } from './types.js';
import { LEVELS, PAY_COLORS, PYRAMID_WIDTH } from './types.js';

/**
 * Where each action sits in a policy vector.
 *
 * The other half of the contract. A network's policy head is a fixed-width vector, so every action
 * the game can produce needs a slot — and the mapping has to be stable, because a dataset recorded
 * under one layout is meaningless under another.
 *
 * **The map is many-to-one, deliberately.** Some choices are combinatorial and mostly immaterial, and
 * giving each variant its own slot would blow the vector up to no purpose:
 *
 *  - *Payments.* Which gold you substitute for which gem is a detail; `legalActions` already
 *    canonicalises it and truncates the rest.
 *  - *Which gold token you take when reserving.* One gold is much like another; only the source card
 *    really matters.
 *  - *Discards.* Forced, near-always uncontroversial, and combinatorial in the number of colours.
 *
 * Sharing a slot is harmless because the *search* never works from these indices — it works from
 * `legalActions`. An index only supplies a prior, and the training target sums the visit counts of
 * everything that shares a slot. There is no inverse function, and there deliberately isn't one:
 * nothing needs to turn an index back into a move, so nothing can get that wrong.
 */

const LINE_INDEX: ReadonlyMap<string, number> = new Map(ALL_LINES.map((line, i) => [line.join(','), i]));

const TAKE = 0;
const PRIVILEGE = TAKE + ALL_LINES.length;
const REPLENISH = PRIVILEGE + 25;
const RESERVE = REPLENISH + 1;
/** 12 pyramid slots plus one per deck. */
const RESERVE_SOURCES = LEVELS.reduce((n, l) => n + PYRAMID_WIDTH[l], 0) + LEVELS.length;
const PURCHASE = RESERVE + RESERVE_SOURCES;
/** 12 pyramid slots plus the three reservation slots. */
const PURCHASE_REFS = LEVELS.reduce((n, l) => n + PYRAMID_WIDTH[l], 0) + 3;
const MATCHING = PURCHASE + PURCHASE_REFS;
const STEAL = MATCHING + 25;
const ROYAL = STEAL + PAY_COLORS.length;
const DISCARD = ROYAL + 4;
const PASS = DISCARD + 1;

/** Length of a policy vector. Assert against this when loading weights. */
export const POLICY_SIZE = PASS + 1;

/** Where a pyramid slot sits among the flattened twelve, level 1 first. */
function pyramidOffset(level: 1 | 2 | 3, slot: number): number {
  let base = 0;
  for (const l of LEVELS) {
    if (l === level) break;
    base += PYRAMID_WIDTH[l];
  }
  return base + slot;
}

/**
 * The policy slot for an action, or `-1` if it has none.
 *
 * `-1` should never happen for anything `legalActions` produced; it is there so a malformed action
 * is dropped rather than silently landing on some other move's slot.
 */
export function actionToIndex(action: SplendorAction): number {
  switch (action.t) {
    case 'takeTokens': {
      const line = LINE_INDEX.get([...action.cells].join(','));
      return line === undefined ? -1 : TAKE + line;
    }
    case 'usePrivilege':
      return action.cell >= 0 && action.cell < 25 ? PRIVILEGE + action.cell : -1;
    case 'replenish':
      return REPLENISH;
    case 'reserve': {
      // The gold cell is not encoded: one gold is much like another, and the source is the choice.
      if (action.from.t === 'deck') {
        return RESERVE + LEVELS.reduce((n, l) => n + PYRAMID_WIDTH[l], 0) + LEVELS.indexOf(action.from.level);
      }
      return RESERVE + pyramidOffset(action.from.level, action.from.slot);
    }
    case 'purchase': {
      if (action.from.t === 'pyramid') return PURCHASE + pyramidOffset(action.from.level, action.from.slot);
      // Reservations have no stable position, so they share the three trailing slots by holding
      // order. Which reservation is which matters less than that buying one is distinguishable.
      return PURCHASE + LEVELS.reduce((n, l) => n + PYRAMID_WIDTH[l], 0);
    }
    case 'chooseMatchingToken':
      return action.cell >= 0 && action.cell < 25 ? MATCHING + action.cell : -1;
    case 'chooseSteal': {
      const i = PAY_COLORS.indexOf(action.color);
      return i < 0 ? -1 : STEAL + i;
    }
    case 'chooseRoyal':
      return ROYAL;
    case 'discard':
      return DISCARD;
    case 'pass':
      return PASS;
    default:
      return -1;
  }
}

/**
 * A 0/1 mask over the policy space: which slots are reachable from here.
 *
 * Built from the legal actions rather than re-derived, so it cannot disagree with what the search is
 * allowed to do.
 */
export function policyMask(actions: readonly SplendorAction[]): Float32Array {
  const mask = new Float32Array(POLICY_SIZE);
  for (const action of actions) {
    const index = actionToIndex(action);
    if (index >= 0) mask[index] = 1;
  }
  return mask;
}

/**
 * A training target: the search's visit counts, normalised, folded onto the policy space.
 *
 * Actions that share a slot have their visits summed, which is the right thing — the slot means
 * "this kind of move", and the search's total interest in it is exactly the sum.
 */
export function visitsToPolicy(ranking: readonly { action: SplendorAction; visits: number }[]): Float32Array {
  const target = new Float32Array(POLICY_SIZE);
  let total = 0;
  for (const entry of ranking) {
    const index = actionToIndex(entry.action);
    if (index < 0) continue;
    target[index] = (target[index] ?? 0) + entry.visits;
    total += entry.visits;
  }
  if (total > 0) {
    for (let i = 0; i < POLICY_SIZE; i++) target[i] = (target[i] ?? 0) / total;
  }
  return target;
}

/** For the sidecar written beside a dataset, so a trainer can check it is reading what it expects. */
export const POLICY_LAYOUT = {
  size: POLICY_SIZE,
  sections: {
    takeTokens: [TAKE, PRIVILEGE],
    usePrivilege: [PRIVILEGE, REPLENISH],
    replenish: [REPLENISH, RESERVE],
    reserve: [RESERVE, PURCHASE],
    purchase: [PURCHASE, MATCHING],
    chooseMatchingToken: [MATCHING, STEAL],
    chooseSteal: [STEAL, ROYAL],
    chooseRoyal: [ROYAL, DISCARD],
    discard: [DISCARD, PASS],
    pass: [PASS, POLICY_SIZE],
  },
} as const;
