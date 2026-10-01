import { TOKEN_COLORS, type SplendorAction, type SplendorView, type TokenColor } from '@games/splendor-duel';
import { colorToBga } from './ids.js';
import type { Located } from './locate.js';
import type { Refusal } from './refusal.js';

/**
 * One of our actions, as the calls BGA's page would make for it.
 *
 * Names and arguments are BGA's own, from `ActionTrait.php` and the page's `performAction` calls in
 * thoun/splendorduel. Three of our actions are two calls on BGA, with a state in between that the
 * page has to reach before the second is accepted: `then` names it, and the caller waits for it.
 *
 * There is no call for `pass`. BGA has no such move, and the loop stops before it would ask.
 */
export interface BgaCall {
  name: string;
  args: Record<string, string | number>;
  /** The BGA state to wait for before sending the next call. */
  then?: string;
}

export type CallPlan = { ok: true; calls: BgaCall[] } | { ok: false; refusal: Refusal };

/** The page sends id lists comma-joined and ascending. So do we. */
const list = (ids: number[]): string => [...ids].sort((a, b) => a - b).join(',');

const plan = (...calls: BgaCall[]): CallPlan => ({ ok: true, calls });
const cannot = (detail: string): CallPlan => ({ ok: false, refusal: { reason: 'unmapped', detail } });

/** Which of the tokens in `pool` to hand over: the lowest ids of each colour. Tokens of a colour are alike. */
function held(pool: Record<TokenColor, number[]>, counts: Partial<Record<TokenColor, number>>): number[] | null {
  const out: number[] = [];
  for (const color of TOKEN_COLORS) {
    const wanted = counts[color] ?? 0;
    if (wanted === 0) continue;
    if (pool[color].length < wanted) return null;
    out.push(...pool[color].slice(0, wanted));
  }
  return out;
}

export function toBgaCalls(action: SplendorAction, view: SplendorView, at: Located): CallPlan {
  const tokenOn = (cell: number): number | undefined => at.boardToken.get(cell)?.id;

  switch (action.t) {
    case 'takeTokens': {
      const ids = action.cells.map(tokenOn);
      if (ids.some((id) => id === undefined)) return cannot(`No BGA token on one of cells ${action.cells.join(', ')}.`);
      return plan({ name: 'actTakeTokens', args: { ids: list(ids as number[]) } });
    }

    case 'usePrivilege': {
      const id = tokenOn(action.cell);
      if (id === undefined) return cannot(`No BGA token on cell ${action.cell}.`);
      return plan(
        { name: 'actUsePrivilege', args: {}, then: 'usePrivilege' },
        { name: 'actTakeTokens', args: { ids: String(id) } },
      );
    }

    case 'replenish':
      return plan({ name: 'actRefillBoard', args: {} });

    case 'reserve': {
      const gold = tokenOn(action.goldCell);
      const cardId = action.from.t === 'pyramid' ? view.pyramid[action.from.level][action.from.slot] : null;
      const target = action.from.t === 'deck' ? at.deckTop[action.from.level] : cardId ? at.cardBgaId.get(cardId) : undefined;
      if (gold === undefined || target === undefined || target === null) return cannot('Cannot find the gold token or the card to reserve.');
      return plan(
        { name: 'actTakeTokens', args: { ids: String(gold) }, then: 'reserveCard' },
        { name: 'actReserveCard', args: { id: target } },
      );
    }

    case 'purchase': {
      const cardId = action.from.t === 'pyramid' ? view.pyramid[action.from.level][action.from.slot] : action.from.cardId;
      const target = cardId ? at.cardBgaId.get(cardId) : undefined;
      const payment = held(at.myTokens, action.payment);
      if (target === undefined || payment === null) return cannot('Cannot find the card to buy, or the tokens to pay for it.');
      const buy: BgaCall = { name: 'actBuyCard', args: { id: target, tokensIds: list(payment) } };
      if (!action.wildColor) return plan(buy);
      return plan({ ...buy, then: 'placeJoker' }, { name: 'actPlaceJoker', args: { color: colorToBga(action.wildColor) } });
    }

    case 'chooseMatchingToken': {
      const id = tokenOn(action.cell);
      if (id === undefined) return cannot(`No BGA token on cell ${action.cell}.`);
      return plan({ name: 'actTakeTokens', args: { ids: String(id) } });
    }

    case 'chooseSteal': {
      const [id] = at.theirTokens[action.color];
      if (id === undefined) return cannot(`The opponent holds no ${action.color} token.`);
      return plan({ name: 'actTakeOpponentToken', args: { id } });
    }

    case 'chooseRoyal': {
      const id = at.royalBgaId.get(action.royalId);
      if (id === undefined) return cannot(`Royal ${action.royalId} is not on the table.`);
      return plan({ name: 'actTakeRoyalCard', args: { id } });
    }

    case 'discard': {
      const ids = held(at.myTokens, action.tokens);
      if (ids === null) return cannot('We do not hold the tokens this discard names.');
      return plan({ name: 'actDiscardTokens', args: { ids: list(ids) } });
    }

    case 'pass':
      return { ok: false, refusal: { reason: 'disagreement', detail: 'Our rules say pass; BGA has no such move.' } };
  }
}
