import {
  TOKEN_COLORS,
  cardLabel,
  describeAction,
  type SplendorAction,
  type SplendorView,
  type TokenColor,
} from '@games/splendor-duel';
import type { Located } from './locate.js';
import type { BgaToken } from './snapshot.js';

/**
 * One move, as something a person can carry out on the BGA page.
 *
 * `text` is the move in the game's own words, from the same `describeAction` the coach panel uses.
 * `steps` is what to click, in order, in BGA's terms: BGA makes two clicks out of several things
 * that are one action to us, and an instruction that stopped after the first would leave the table
 * in a state the adapter has to wait out. `highlight` is the DOM ids of the pieces involved, so the
 * page can outline them — "row 2, column 4" is findable, an outlined token is unmissable.
 *
 * Board positions are given as BGA draws them. BGA's board is ours turned half a turn (see
 * `ids.ts`), so our cell numbers would point at the wrong corner; the token's own `row` and
 * `column`, as BGA sent them, cannot.
 */
export interface Instruction {
  text: string;
  steps: string[];
  highlight: string[];
}

function tokenAt(at: Located, cell: number): BgaToken {
  const token = at.boardToken.get(cell);
  if (!token) throw new Error(`instruct: no token on cell ${cell}`);
  return token;
}

const where = (token: BgaToken): string => `row ${String(token.row)}, column ${String(token.column)}`;

function tally(counts: Partial<Record<TokenColor, number>>): string {
  const parts = TOKEN_COLORS.filter((color) => (counts[color] ?? 0) > 0).map((color) => `${counts[color]} ${color}`);
  return parts.join(', ');
}

/** The lowest-id tokens of each colour, which is as good a choice as any: tokens of a colour are alike. */
function pickHeld(pool: Record<TokenColor, number[]>, counts: Partial<Record<TokenColor, number>>): number[] {
  return TOKEN_COLORS.flatMap((color) => pool[color].slice(0, counts[color] ?? 0));
}

export function instruct(action: SplendorAction, view: SplendorView, at: Located): Instruction {
  const text = describeAction(action, view);

  switch (action.t) {
    case 'takeTokens': {
      const tokens = action.cells.map((cell) => tokenAt(at, cell));
      const steps = tokens.map((token, i) => `Select the ${String(view.board[action.cells[i] as number])} token at ${where(token)}.`);
      steps.push('Confirm the selection.');
      return { text, steps, highlight: tokens.map((token) => `token-${token.id}`) };
    }

    case 'usePrivilege': {
      const token = tokenAt(at, action.cell);
      return {
        text,
        steps: [
          'Click "Use up to … privilege(s) to take gem(s)".',
          `Select only the ${String(view.board[action.cell])} token at ${where(token)}, and confirm. One token: the next move is advised after it.`,
        ],
        highlight: [`token-${token.id}`],
      };
    }

    case 'replenish':
      return {
        text,
        steps: ['Click "Replenish the board", and accept the warning that your opponent gains a privilege.'],
        highlight: [],
      };

    case 'reserve': {
      const gold = tokenAt(at, action.goldCell);
      const takeGold = `Select the gold token at ${where(gold)}, and confirm.`;
      if (action.from.t === 'deck') {
        return {
          text,
          steps: [takeGold, `Click the level ${action.from.level} deck to reserve its top card.`],
          highlight: [`token-${gold.id}`, `card-deck-${action.from.level}`],
        };
      }
      const cardId = view.pyramid[action.from.level][action.from.slot] ?? null;
      const bga = cardId ? at.cardBgaId.get(cardId) : undefined;
      return {
        text,
        steps: [
          takeGold,
          `Reserve ${cardLabel(cardId)}: level ${action.from.level}, card ${action.from.slot + 1} counting from the left.`,
        ],
        highlight: [`token-${gold.id}`, ...(bga === undefined ? [] : [`card-${bga}`])],
      };
    }

    case 'purchase': {
      const cardId =
        action.from.t === 'pyramid' ? (view.pyramid[action.from.level][action.from.slot] ?? null) : action.from.cardId;
      const place =
        action.from.t === 'pyramid'
          ? `level ${action.from.level}, card ${action.from.slot + 1} counting from the left`
          : 'among your reserved cards';
      const bga = cardId ? at.cardBgaId.get(cardId) : undefined;
      const paying = tally(action.payment);
      const steps = [
        `Click ${cardLabel(cardId)} (${place}).`,
        paying ? `Pay with exactly: ${paying}.` : 'It is free: pay nothing.',
      ];
      if (action.wildColor) steps.push(`Place it on your ${action.wildColor} column.`);
      return { text, steps, highlight: bga === undefined ? [] : [`card-${bga}`] };
    }

    case 'chooseMatchingToken': {
      const token = tokenAt(at, action.cell);
      return {
        text,
        steps: [`Take the ${String(view.board[action.cell])} token at ${where(token)}.`],
        highlight: [`token-${token.id}`],
      };
    }

    case 'chooseSteal': {
      const [id] = at.theirTokens[action.color];
      return {
        text,
        steps: [`Take a ${action.color} token from your opponent.`],
        highlight: id === undefined ? [] : [`token-${id}`],
      };
    }

    case 'chooseRoyal': {
      const bga = at.royalBgaId.get(action.royalId);
      return {
        text,
        steps: [`Take the royal card: ${cardLabel(action.royalId)}.`],
        highlight: bga === undefined ? [] : [`royal-card-${bga}`],
      };
    }

    case 'discard':
      return {
        text,
        steps: [`Select these of your own tokens: ${tally(action.tokens)}.`, 'Click "Discard selected token(s)".'],
        highlight: pickHeld(at.myTokens, action.tokens).map((id) => `token-${id}`),
      };

    case 'pass':
      throw new Error('instruct: pass has no move on BGA; the loop stops before asking for one');
  }
}
