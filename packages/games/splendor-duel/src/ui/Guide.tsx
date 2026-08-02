import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tryCard } from '../cards.js';
import type { GemColor, PlayerView, SplendorAction, SplendorView } from '../types.js';
import { GEM_COLORS, TOKEN_LIMIT, WIN_COLOR_PRESTIGE, WIN_CROWNS, WIN_PRESTIGE } from '../types.js';

/**
 * New-player support: say what you can do right now, and keep a cheatsheet one click away.
 *
 * The turn guide is derived from the same `legalActions` list that drives the clickable
 * affordances, so it cannot tell you about a move the server would refuse, and it cannot go stale
 * when the rules change.
 */

export interface Suggestion {
  title: string;
  detail: string;
  /** Draw attention to the thing the player must resolve before anything else. */
  urgent?: boolean;
}

export function describeTurn(view: SplendorView, seat: number, legal: SplendorAction[]): Suggestion[] {
  const me = view.players[seat as 0 | 1];
  const out: Suggestion[] = [];
  const kinds = new Set(legal.map((a) => a.t));

  // A pending decision blocks everything else, so it is the only thing worth saying.
  if (view.pending) {
    switch (view.pending.k) {
      case 'matchingToken':
        return [
          {
            title: `Take a ${view.pending.color} token from the board`,
            detail:
              'The card you just bought gives you a free token of its own colour. Pick which one — removing it changes which lines are available later.',
            urgent: true,
          },
        ];
      case 'steal':
        return [
          {
            title: "Steal a token from your opponent",
            detail: 'Any gem or pearl they hold. Gold can never be stolen.',
            urgent: true,
          },
        ];
      case 'royal':
        return [
          {
            title: 'Claim a royal card',
            detail:
              'You reached a crown threshold. Royal cards give prestige and an immediate ability, but no crowns and no bonus colour.',
            urgent: true,
          },
        ];
      case 'discard':
        return [
          {
            title: `Discard ${view.pending.count} token${view.pending.count > 1 ? 's' : ''}`,
            detail: `You may only hold ${TOKEN_LIMIT} between turns. Discarded tokens go back into the bag, which makes a future replenish possible.`,
            urgent: true,
          },
        ];
    }
  }

  if (kinds.has('pass')) {
    return [
      {
        title: 'No legal move — you must pass',
        detail:
          'The board holds only gold, the bag is empty, and nothing is affordable. The official rules do not cover this, so passing ends your turn; the end-of-turn discard refills the bag and play resumes.',
        urgent: true,
      },
    ];
  }

  if (kinds.has('takeTokens')) {
    out.push({
      title: 'Take up to 3 tokens',
      detail:
        'Click adjacent tokens in a straight line — across, down, or diagonally — then press Take. A gap or a gold token breaks the line, and you may take just 1 or 2 if you prefer.',
    });
  }

  const purchasable = new Set(
    legal
      .filter((a): a is Extract<SplendorAction, { t: 'purchase' }> => a.t === 'purchase')
      .map((a) => (a.from.t === 'pyramid' ? view.pyramid[a.from.level][a.from.slot] : a.from.cardId))
      .filter((id): id is string => Boolean(id)),
  );
  if (purchasable.size > 0) {
    const best = [...purchasable].reduce((top, id) => {
      const card = tryCard(id);
      const topCard = tryCard(top);
      return card && topCard && card.points > topCard.points ? id : top;
    });
    const bestCard = tryCard(best);
    const reservedIds = new Set(
      view.players.flatMap((p) => p.reserved.flatMap((r) => ('cardId' in r ? [r.cardId] : []))),
    );
    const reservedBuyable = [...purchasable].some((id) => reservedIds.has(id));
    out.push({
      title: `Buy a card — ${purchasable.size} you can afford`,
      detail: `Click a card to see what it costs after your bonuses.${
        reservedBuyable ? ' That includes a card you reserved — click it in your own row below.' : ''
      }${
        bestCard && bestCard.points > 0 ? ` The best on offer is worth ${bestCard.points} prestige.` : ''
      } Every card you own permanently discounts that colour.`,
    });
  } else {
    out.push({
      title: 'No card is affordable yet',
      detail: 'Collect tokens, or reserve a card to keep it away from your opponent while you save up.',
    });
  }

  if (kinds.has('reserve')) {
    out.push({
      title: 'Take a gold token and reserve a card',
      detail:
        'The only way to get gold, which is wild for any gem or pearl. The reserved card is yours to buy later — from a deck it is even hidden from your opponent. Maximum 3 reserved.',
    });
  }

  if (kinds.has('usePrivilege')) {
    out.push({
      title: `Spend a privilege scroll (you have ${me.privileges})`,
      detail:
        'Take any single non-gold token from anywhere on the board — no line needed. Must be done before replenishing, so decide now.',
    });
  }

  if (kinds.has('replenish')) {
    out.push({
      title: 'Replenish the board',
      detail: `Refills empty spaces from the bag (${view.bag.total} token${view.bag.total === 1 ? '' : 's'}), starting at the centre and spiralling out. Your opponent gains a privilege scroll, and you cannot spend scrolls afterwards this turn.`,
    });
  }

  // Things worth warning about rather than offering.
  if (kinds.has('takeTokens')) {
    out.push({
      title: 'Watch out',
      detail:
        'Taking 3 tokens of the same colour, or both pearls in one go, hands your opponent a privilege scroll. Taking 2 of a colour is free.',
    });
  }
  if (me.tokenTotal > TOKEN_LIMIT) {
    out.push({
      title: `You are holding ${me.tokenTotal} tokens`,
      detail: `Over the limit is fine mid-turn, but you will discard down to ${TOKEN_LIMIT} when your turn ends.`,
    });
  }

  return out;
}

/** Progress toward each of the three ways to win. */
export function VictoryTracker({ player }: { player: PlayerView }) {
  const bestColor = GEM_COLORS.reduce<GemColor>(
    (best, color) => (player.colorPoints[color] > player.colorPoints[best] ? color : best),
    'white',
  );
  const rows: { label: string; value: number; target: number; hint: string }[] = [
    { label: 'Prestige', value: player.points, target: WIN_PRESTIGE, hint: 'jewel + royal cards' },
    { label: 'Crowns', value: player.crowns, target: WIN_CROWNS, hint: 'jewel cards only' },
    {
      label: `Best colour (${bestColor})`,
      value: player.colorPoints[bestColor],
      target: WIN_COLOR_PRESTIGE,
      hint: 'prestige within one bonus colour',
    },
  ];

  return (
    <div className="sd-victory">
      <span className="sd-label">Any one of these wins</span>
      {rows.map((row) => (
        <div className="sd-victory-row" key={row.label} title={row.hint}>
          <span className="sd-victory-label">{row.label}</span>
          <span className="sd-bar">
            <span
              className={`sd-bar-fill ${row.value >= row.target ? 'done' : ''}`}
              style={{ width: `${Math.min(100, (row.value / row.target) * 100)}%` }}
            />
          </span>
          <span className="sd-victory-num">
            {row.value}/{row.target}
          </span>
        </div>
      ))}
    </div>
  );
}

export function TurnGuide({
  suggestions,
  myTurn,
  onOpenHelp,
}: {
  suggestions: Suggestion[];
  myTurn: boolean;
  onOpenHelp: () => void;
}) {
  return (
    <div className="sd-guide">
      <header>
        <strong>{myTurn ? 'Your turn — you can:' : 'Waiting for your opponent'}</strong>
        <button type="button" className="mini" onClick={onOpenHelp}>
          Rules &amp; help
        </button>
      </header>
      {myTurn && (
        <>
          <p className="sd-guide-note">
            Pick <em>one</em> of the first three. Scrolls and replenishing are optional extras you may
            do first, in that order.
          </p>
          <ScrollableList suggestions={suggestions} />
        </>
      )}
    </div>
  );
}

/**
 * The bullet list, with a fade when it has more content than fits.
 *
 * This list is what gives up height so the board can keep its own, so on a shorter screen it scrolls.
 * Detecting that in JS rather than always drawing the fade means the hint appears only when it is
 * true — a permanent gradient over the last line just looks like a rendering bug.
 */
function ScrollableList({ suggestions }: { suggestions: Suggestion[] }) {
  const listRef = useRef<HTMLUListElement>(null);
  const [scrollable, setScrollable] = useState(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => setScrollable(list.scrollHeight > list.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [suggestions]);

  return (
    <div className="sd-guide-list-wrap" data-scrollable={scrollable}>
      <ul ref={listRef}>
        {suggestions.map((s) => (
          <li key={s.title} className={s.urgent ? 'urgent' : ''}>
            <strong>{s.title}</strong>
            <span className="muted"> — {s.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ cheatsheet */

const CHEATSHEET: { heading: string; items: string[] }[] = [
  {
    heading: 'How to win (checked at the end of your turn)',
    items: [
      `${WIN_PRESTIGE}+ prestige points, counting jewel and royal cards.`,
      `${WIN_CROWNS}+ crowns. Crowns only ever come from jewel cards.`,
      `${WIN_COLOR_PRESTIGE}+ prestige within a single bonus colour. Wild cards count in the colour they joined.`,
      'The game stops immediately — your opponent does not get a final turn.',
    ],
  },
  {
    heading: 'Your turn, in order',
    items: [
      'Optional: spend any number of your privilege scrolls. Each takes one non-gold token from anywhere on the board.',
      'Optional, once: replenish the board from the bag. Your opponent then gains a scroll — and you can no longer spend scrolls this turn.',
      'Then exactly one of: take tokens, reserve a card, or buy a card.',
      'Resolve the bought card’s ability, claim a royal if you crossed 3 or 6 crowns, then discard down to 10 tokens.',
    ],
  },
  {
    heading: 'Taking tokens',
    items: [
      '1 to 3 tokens in an unbroken straight line: across, down, or either diagonal.',
      'An empty space or a gold token inside the line makes it illegal — you cannot jump over either.',
      'Taking 3 of the same colour, or both pearls, gives your opponent a privilege scroll.',
      'Gold can only be obtained by reserving a card.',
    ],
  },
  {
    heading: 'Buying cards',
    items: [
      'Each card you own reduces the cost of that colour by 1 for every bonus gem it shows. Five cards show two gems.',
      'Discounts are compulsory and stop at zero — you never gain tokens.',
      'There are no pearl bonuses, so pearls must be paid with pearls or gold.',
      'Gold is wild for any gem or pearl. Spent tokens go into the bag.',
      'You can buy a card you reserved earlier: click its thumbnail in your own row.',
    ],
  },
  {
    heading: 'Card abilities',
    items: [
      '↻ Take another turn, immediately after this one finishes.',
      '↓ Take a board token matching this card’s colour. Skipped if none are left.',
      '✋ Take a gem or pearl from your opponent. Never gold.',
      '✦ Take a privilege scroll — from above the board, or from your opponent if there are none.',
      '◈ Wild card: it joins a colour you already own and counts as that colour forever. You cannot buy one with an empty tableau.',
    ],
  },
  {
    heading: 'Privilege scrolls',
    items: [
      'There are exactly 3 in the game, moving between the board and the two players.',
      'You start with one if you are going second.',
      'If you are owed one and none are above the board, you take one from your opponent. If you already hold all 3, nothing happens.',
    ],
  },
  {
    heading: 'Reserving',
    items: [
      'Take a gold token from the board, then either a face-up card or the top of a deck.',
      'Up to 3 at a time. A card taken from a deck stays hidden from your opponent.',
      'Reserved cards do nothing — no points, no bonuses, no abilities — until you buy them. No penalty for unbought ones.',
    ],
  },
  {
    heading: 'Limits',
    items: [
      `${TOKEN_LIMIT} tokens between turns, counting gold and pearls. You may exceed it mid-turn and discard at the end.`,
      'Discarded and spent tokens go into the bag, which is what makes the next replenish possible.',
      'The bag starts empty: all 25 tokens begin on the board.',
      'You are told how many tokens the bag holds, but not which — track what has been spent if you want to know what a replenish will bring.',
    ],
  },
];

/* ------------------------------------------------------------------ readable names */

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
 * Turn one effect into a log line, in the game's own vocabulary.
 *
 * Lives with the game rather than in the platform shell, because only the game knows that `l1-09` is
 * a level-1 white card worth nothing. The shell falls back to a generic description for games that
 * do not provide this.
 *
 * Every line is written in the voice of `actorSeat` — the player the log attributes the move to.
 * That matters because an effect's own `seat` is not always the mover's: replenishing gives the
 * *opponent* a privilege scroll, and reading that as "gained a scroll" under the mover's name says
 * the opposite of what happened. Deliberately phrased relative to the mover rather than to whoever
 * is reading, so both players' logs say the same thing about the same move.
 */
export function describeEffect(effect: Record<string, unknown>, actorSeat: number): string {
  const kind = String(effect.k);
  switch (kind) {
    case 'tookTokens':
      return `took ${(effect.colors as string[]).join(', ')}`;
    case 'privilegeUsed':
      return `spent a scroll for ${String(effect.color)}`;
    case 'replenished':
      {
        const placed = (effect.placed as unknown[]).length;
        return `replenished ${placed} token${placed === 1 ? '' : 's'}`;
      }
    case 'purchased': {
      const wild = effect.wildColor ? ` as ${String(effect.wildColor)}` : '';
      return `bought ${cardLabel(effect.cardId as string)}${wild}`;
    }
    case 'reserved':
      return effect.cardId
        ? `reserved ${cardLabel(effect.cardId as string)}`
        : `reserved a hidden level-${String(effect.level)} card`;
    case 'stolen':
      return `stole a ${String(effect.color)}`;
    case 'matchingTokenTaken':
      return `took a free ${String(effect.color)}`;
    case 'royalTaken':
      return `claimed ${cardLabel(effect.royalId as string)}`;
    case 'discarded': {
      const tokens = Object.entries(effect.tokens as Record<string, number>)
        .filter(([, n]) => n > 0)
        .map(([colour, n]) => `${n} ${colour}`);
      return `discarded ${tokens.join(', ')}`;
    }
    case 'privilegeGranted': {
      // `from` says where the scroll came from: the pool, or off the other player when the pool is
      // empty. `seat` says who ended up with it, which is the opponent whenever this came from a
      // replenish.
      if (effect.from === 'none') return '';
      const toMover = effect.seat === actorSeat;
      if (effect.from === 'opponent') {
        return toMover ? 'took a scroll from the opponent' : 'opponent took a scroll back';
      }
      return toMover ? 'gained a scroll' : 'opponent gained a scroll';
    }
    case 'abilityResolved':
      return String(effect.ability) === 'playAgain' ? 'takes another turn' : '';
    case 'passed':
      return 'passed - no legal move';
    case 'gameOver':
      return 'game over';
    default:
      // pyramidRefilled, abilitySkipped and friends are mechanics, not moves worth narrating.
      return '';
  }
}

export function HelpPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sd-help-backdrop" role="presentation" onClick={onClose}>
      <div
        className="sd-help"
        role="dialog"
        aria-modal="true"
        aria-label="Splendor Duel rules summary"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h3>Splendor Duel — quick reference</h3>
          <button type="button" className="mini" onClick={onClose} aria-label="Close help">
            Close
          </button>
        </header>
        <div className="sd-help-body">
          {CHEATSHEET.map((section) => (
            <section key={section.heading}>
              <h4>{section.heading}</h4>
              <ul>
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <footer className="muted">Press Escape to close. Hover any card or token for details.</footer>
      </div>
    </div>
  );
}
