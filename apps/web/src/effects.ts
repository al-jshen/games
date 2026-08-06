/**
 * Narrating effects when a game has not said how.
 *
 * Every game may export its own `describeEffect` — only it knows that `l1-09` is a level-1 white card
 * — and this is what stands in when one does not. It lives here rather than inside the move log so the
 * replay viewer can use the same words: tic-tac-toe ships no describer, and without this its whole
 * replay read as a column of dashes.
 */

export function describeEffect(effect: Record<string, unknown>, actorSeat: number): string {
  const k = String(effect.k);
  switch (k) {
    case 'tookTokens':
      return `took ${(effect.colors as string[]).join(', ')}`;
    case 'privilegeUsed':
      return `spent a privilege for ${String(effect.color)}`;
    case 'replenished':
      {
        const placed = (effect.placed as unknown[]).length;
        return `replenished ${placed} token${placed === 1 ? '' : 's'}`;
      }
    case 'purchased':
      return `bought ${String(effect.cardId)}${effect.wildColor ? ` as ${String(effect.wildColor)}` : ''}`;
    case 'reserved':
      return `reserved ${effect.cardId ? String(effect.cardId) : 'a hidden card'}`;
    case 'stolen':
      return `stole a ${String(effect.color)}`;
    case 'matchingTokenTaken':
      return `took a bonus ${String(effect.color)}`;
    case 'royalTaken':
      return `claimed ${String(effect.royalId)}`;
    case 'discarded':
      return `discarded ${Object.entries(effect.tokens as Record<string, number>).map(([c, n]) => `${n} ${c}`).join(', ')}`;
    case 'privilegeGranted': {
      // Whoever gained it is not always whoever moved -- replenishing hands one to the opponent.
      if (effect.from === 'none') return '';
      return effect.seat === actorSeat ? 'gained a privilege' : 'opponent gained a privilege';
    }
    case 'abilityResolved':
      return String(effect.ability) === 'playAgain' ? 'takes another turn' : '';
    case 'abilitySkipped':
      return '';
    case 'passed':
      return 'passed (no legal move)';
    case 'placed':
      return `played ${String(effect.mark)} at ${String(effect.cell)}`;
    case 'gameOver':
      return 'game over';
    default:
      return '';
  }
}
