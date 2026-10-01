/**
 * BGA's state machine for this game, sorted by what it means to us.
 *
 * Names are from `states.inc.php` in thoun/splendorduel. Three of BGA's states are the *middle* of
 * something our engine treats as one action — pick a gold then pick the card it reserves, buy a wild
 * card then pick its column, press "use privilege" then pick the token. There is no `SplendorView`
 * for those, so they are never a decision point: `play` walks through them itself, and `advise`
 * waits for the operator to come out the other side.
 */
export type StateKind = 'decision' | 'mid-action' | 'over' | 'unknown';

const DECISION = new Set(['playAction', 'takeBoardToken', 'takeOpponentToken', 'takeRoyalCard', 'discardTokens']);
const MID_ACTION = new Set(['usePrivilege', 'reserveCard', 'placeJoker']);

export function stateKind(name: string): StateKind {
  if (DECISION.has(name)) return 'decision';
  if (MID_ACTION.has(name)) return 'mid-action';
  if (name === 'gameEnd') return 'over';
  // Everything else: BGA's own transient states, the expansion's states, and whatever comes later.
  return 'unknown';
}
