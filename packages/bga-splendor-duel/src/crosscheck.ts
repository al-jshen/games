import { LEVELS, legalActionsFromView, type SplendorView } from '@games/splendor-duel';
import { locate } from './locate.js';
import { buyableIds, zPlayActionArgs, type BgaSnapshot } from './snapshot.js';

/**
 * Ask both rule sets what is allowed here, and report every difference.
 *
 * BGA sends the active player a summary of their options with each state. Our engine derives the
 * same things from the translated view. They are independent computations over what should be the
 * same position, so a difference means the position was mistranslated — or the two implementations
 * disagree about a rule — and in neither case should the bot move.
 *
 * Returns one sentence per disagreement. Empty means agreement, which is the only case the loop
 * continues in.
 *
 * Two of BGA's rules are deliberately not modelled and land here as stops rather than as moves:
 * its forced refill when a player has nothing else (we have `pass` for the residue of that), and
 * its option to end the game against an opponent hoarding every gold and pearl.
 */
export function crossCheck(view: SplendorView, seat: 0 | 1, snapshot: BgaSnapshot): string[] {
  const problems: string[] = [];
  const { actions } = legalActionsFromView(view, seat);

  if (actions.length === 0) problems.push('Our rules find no legal move in this position.');
  if (actions.length === 1 && actions[0]?.t === 'pass') {
    problems.push('Our rules say this seat is stuck and can only pass, which BGA has no move for.');
  }

  const name = snapshot.gamestate.name;

  if (name === 'takeRoyalCard' && actions.length !== snapshot.gamedatas.royalCards.length) {
    problems.push(`BGA shows ${snapshot.gamedatas.royalCards.length} royal card(s) to choose from; we count ${actions.length}.`);
  }

  if (name !== 'playAction') return problems;

  const parsed = zPlayActionArgs.safeParse(snapshot.gamestate.args);
  if (!parsed.success) return [...problems, 'BGA sent arguments for this state that this adapter does not recognise.'];
  const args = parsed.data;

  const weReplenish = actions.some((a) => a.t === 'replenish');
  if (weReplenish !== args.canRefill) {
    problems.push(`Replenish: BGA says ${args.canRefill ? 'allowed' : 'not allowed'}, we say ${weReplenish ? 'allowed' : 'not allowed'}.`);
  }

  // BGA offers privileges whenever the board is not empty; they can only ever take a non-gold token.
  const nonGold = view.board.some((token) => token !== null && token !== 'gold');
  const wePrivilege = actions.some((a) => a.t === 'usePrivilege');
  if (wePrivilege !== (args.privileges > 0 && nonGold)) {
    problems.push(`Privileges: BGA offers ${args.privileges}, we ${wePrivilege ? 'can' : 'cannot'} spend one.`);
  }

  const gold = view.board.includes('gold');
  const somethingToReserve = LEVELS.some((level) => view.decks[level] > 0 || view.pyramid[level].some((id) => id !== null));
  const weReserve = actions.some((a) => a.t === 'reserve');
  if (weReserve !== (args.canReserve && gold && somethingToReserve)) {
    problems.push(`Reserve: BGA says ${args.canReserve ? 'allowed' : 'not allowed'}, we say ${weReserve ? 'allowed' : 'not allowed'}.`);
  }

  // The sharpest check there is: the exact set of affordable cards depends on every token we hold,
  // every bonus we own, every cost, and every card id being mapped correctly.
  const ours = new Set<string>();
  for (const action of actions) {
    if (action.t !== 'purchase') continue;
    const id = action.from.t === 'pyramid' ? view.pyramid[action.from.level][action.from.slot] : action.from.cardId;
    if (id) ours.add(id);
  }
  const at = locate(snapshot);
  const theirs = new Set<string>();
  for (const bga of buyableIds(args)) theirs.add(at.ourCardId.get(bga) ?? `BGA card ${bga}`);
  const onlyOurs = [...ours].filter((id) => !theirs.has(id)).sort();
  const onlyTheirs = [...theirs].filter((id) => !ours.has(id)).sort();
  if (onlyOurs.length > 0) problems.push(`We think we can afford ${onlyOurs.join(', ')}; BGA does not.`);
  if (onlyTheirs.length > 0) problems.push(`BGA thinks we can afford ${onlyTheirs.join(', ')}; we do not.`);

  return problems;
}
