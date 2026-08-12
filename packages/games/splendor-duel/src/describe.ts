/**
 * Naming things, in the game's own vocabulary.
 *
 * Outside `ui/` on purpose, and this is not a filing decision. The coach panel runs its search in a
 * web worker and needs to name the moves it found before posting them back — a worker cannot render,
 * but it can write a sentence. Importing from `./ui` to get that would drag React, the whole board
 * component and a stylesheet into a worker bundle whose job is matrix multiplication.
 *
 * Nothing here reads state or produces JSX. `describeEffect` stays in `ui/Guide.tsx` because it is
 * only ever called from a rendered log; these two are called from both sides.
 */

import { tryCard } from './cards.js';
import type { SplendorAction, SplendorView } from './types.js';

/** A compact, human-readable name for a card, for the move log and tooltips. */
export function cardLabel(cardId: string | null): string {
  if (!cardId) return 'a card';
  const def = tryCard(cardId);
  if (!def) return 'a card';
  if (def.kind === 'royal') return `a royal (${def.points} ${def.points === 1 ? 'pt' : 'pts'})`;

  const colour = def.wild ? 'wild' : (def.bonusColor ?? 'no-bonus');
  const parts = [`L${def.level} ${colour}`];
  if (def.bonusCount > 1) parts.push(`x${def.bonusCount}`);
  const extras: string[] = [];
  if (def.points > 0) extras.push(`${def.points} ${def.points === 1 ? 'pt' : 'pts'}`);
  if (def.crowns > 0) extras.push(`${def.crowns} crown${def.crowns > 1 ? 's' : ''}`);
  return extras.length > 0 ? `${parts.join(' ')} (${extras.join(', ')})` : parts.join(' ');
}

/**
 * Turn one *action* into a phrase.
 *
 * The mirror of `describeEffect`, and needed for the opposite direction: an effect is something that
 * already happened, and this is a move somebody is considering. The coach panel is the caller — it
 * ranks moves the network likes, and "purchase from pyramid level 2 slot 1" is not a recommendation
 * anyone can act on without counting slots.
 *
 * Takes the view because an action names positions, not things: `{level: 2, slot: 1}` is only a card
 * if you know what is sitting there, and a token cell is only a colour if you know what is on it.
 * Where the view cannot say — a face-down deck reservation — the phrase says so rather than
 * inventing a card, exactly as the log does.
 */
export function describeAction(action: SplendorAction, view: SplendorView): string {
  const cellColour = (cell: number): string => view.board[cell] ?? 'a token';
  switch (action.t) {
    case 'takeTokens':
      return `Take ${action.cells.map(cellColour).join(', ')}`;
    case 'usePrivilege':
      return `Spend a scroll for ${cellColour(action.cell)}`;
    case 'replenish':
      return 'Replenish the board';
    case 'reserve':
      return action.from.t === 'deck'
        ? `Reserve from the level ${action.from.level} deck, with a gold`
        : `Reserve ${cardLabel(view.pyramid[action.from.level][action.from.slot] ?? null)}, with a gold`;
    case 'purchase': {
      const card =
        action.from.t === 'pyramid'
          ? cardLabel(view.pyramid[action.from.level][action.from.slot] ?? null)
          : 'a reserved card';
      const wild = action.wildColor ? ` as ${action.wildColor}` : '';
      return `Buy ${card}${wild}`;
    }
    case 'chooseMatchingToken':
      return `Take the free ${cellColour(action.cell)}`;
    case 'chooseSteal':
      return `Steal a ${action.color}`;
    case 'chooseRoyal':
      return `Claim ${cardLabel(action.royalId)}`;
    case 'discard': {
      const tokens = Object.entries(action.tokens)
        .filter(([, n]) => (n ?? 0) > 0)
        .map(([colour, n]) => `${n} ${colour}`);
      return `Discard ${tokens.join(', ')}`;
    }
    case 'pass':
      return 'Pass';
    default:
      return 'a move';
  }
}
