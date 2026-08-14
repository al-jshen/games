import { tryCard } from '../cards.js';
import type { CardDef, GemColor, PayColor } from '../types.js';
import { PAY_COLORS } from '../types.js';

/**
 * A Splendor Duel card, drawn as SVG from the card data.
 *
 * Rendering rather than shipping the printed art keeps the payload tiny (no image requests at all),
 * stays crisp at any zoom, and sidesteps the artwork's copyright. The layout mirrors the physical
 * card so the information sits where players expect: prestige top-left, crowns top-centre, bonus
 * top-right, cost bottom-left.
 */

export const GEM_FILL: Record<GemColor | 'pearl' | 'gold', string> = {
  white: '#e9e3d5',
  blue: '#3f7fd0',
  green: '#3f9e6a',
  red: '#c8463f',
  black: '#3b3a44',
  pearl: '#e9b6c4',
  gold: '#d9a53a',
};

const GEM_STROKE: Record<GemColor | 'pearl' | 'gold', string> = {
  white: '#b7ae99',
  blue: '#2a5c9c',
  green: '#2c7350',
  red: '#94322d',
  black: '#22222a',
  pearl: '#c98da0',
  gold: '#a97c22',
};

const ABILITY_LABEL: Record<string, string> = {
  playAgain: 'Take another turn',
  takeMatchingToken: 'Take a matching token from the board',
  stealToken: 'Take a gem or pearl from your opponent',
  takePrivilege: 'Take a privilege scroll',
  wildBonus: 'Joins a colour you already own',
};

const ABILITY_GLYPH: Record<string, string> = {
  playAgain: '↻',
  takeMatchingToken: '↓',
  stealToken: '✋',
  takePrivilege: '✦',
  wildBonus: '◈',
};

/** A gem token / bonus pip. */
export function Gem({
  color,
  size = 18,
  x = 0,
  y = 0,
  label,
}: {
  color: GemColor | 'pearl' | 'gold';
  size?: number;
  x?: number;
  y?: number;
  label?: string;
}) {
  const r = size / 2;
  const isPearl = color === 'pearl';
  return (
    <g transform={`translate(${x} ${y})`}>
      {isPearl ? (
        <circle cx={0} cy={0} r={r} fill={GEM_FILL.pearl} stroke={GEM_STROKE.pearl} strokeWidth={1} />
      ) : (
        // A rotated square reads as a cut gem at small sizes and stays legible in monochrome.
        <rect
          x={-r * 0.78}
          y={-r * 0.78}
          width={r * 1.56}
          height={r * 1.56}
          rx={r * 0.22}
          transform="rotate(45)"
          fill={GEM_FILL[color]}
          stroke={GEM_STROKE[color]}
          strokeWidth={1}
        />
      )}
      {label !== undefined && (
        <text
          x={0}
          y={size * 0.02}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={size * 0.62}
          fontWeight={700}
          fill={color === 'white' || color === 'pearl' || color === 'gold' ? '#22222a' : '#fff'}
        >
          {label}
        </text>
      )}
    </g>
  );
}

export function Crown({ size = 14, x = 0, y = 0 }: { size?: number; x?: number; y?: number }) {
  const s = size / 2;
  return (
    <g transform={`translate(${x} ${y})`} aria-hidden>
      <path
        d={`M ${-s} ${s * 0.55} L ${-s} ${-s * 0.35} L ${-s * 0.42} ${s * 0.12} L 0 ${-s * 0.72} L ${s * 0.42} ${s * 0.12} L ${s} ${-s * 0.35} L ${s} ${s * 0.55} Z`}
        fill="#e8c169"
        stroke="#a97c22"
        strokeWidth={0.9}
        strokeLinejoin="round"
      />
    </g>
  );
}

const LEVEL_TINT: Record<number, string> = {
  0: '#4b3f6b',
  1: '#2f4a52',
  2: '#4a3f2f',
  3: '#4a2f3a',
};

/**
 * Card sizes are named rather than numeric, and the actual pixel width comes from CSS.
 *
 * That is what lets the whole board scale with the viewport height: the sizes are `vh`-based clamps,
 * so on a short screen every card shrinks together and the layout keeps fitting without scrolling.
 * A numeric width prop would have pinned the geometry in JS where CSS cannot reach it.
 */
export type CardSize = 'pyramid' | 'royal' | 'small' | 'detail';

/** Written in the game's canonical colour order, so the two costs always read the same way round. */
function formatCost(cost: Partial<Record<PayColor, number>>): string {
  const parts = PAY_COLORS.filter((c) => (cost[c] ?? 0) > 0).map((c) => `${cost[c]} ${c}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

export interface CardViewProps {
  cardId: string | null;
  size?: CardSize;
  /** Cost after the viewer's bonuses, when known. Feeds the tooltip; the face keeps the printed cost. */
  effectiveCost?: Partial<Record<PayColor, number>> | undefined;
  /** Colour a wild card has been assigned to. */
  assignedColor?: GemColor | null;
  selected?: boolean;
  affordable?: boolean;
  dimmed?: boolean;
  onClick?: (() => void) | undefined;
  title?: string;
}

export function CardView({
  cardId,
  size = 'pyramid',
  effectiveCost,
  assignedColor,
  selected,
  affordable,
  dimmed,
  onClick,
  title,
}: CardViewProps) {
  const def: CardDef | undefined = cardId ? tryCard(cardId) : undefined;

  // Either a genuinely empty pyramid slot, or a card the server has not revealed yet during an
  // optimistic prediction. Both render as a placeholder rather than as a guess.
  if (!def) {
    return (
      <svg
        className={`card card-empty card--${size}`}
        viewBox="0 0 104 151"
        role="img"
        aria-label={cardId ? 'Card being dealt' : 'Empty slot'}
      >
        <rect x={1} y={1} width={102} height={149} rx={8} fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
        {cardId && (
          <text x={52} y={75} textAnchor="middle" dominantBaseline="central" fontSize={11} fill="rgba(255,255,255,0.4)">
            dealing…
          </text>
        )}
      </svg>
    );
  }

  /*
   * The face shows the printed cost -- the number actually on the physical card. It is the one
   * thing about a card that does not move: it means the same to both players, it is what the card
   * is called when two people argue about who should take it, and it stays put while a tableau
   * grows underneath it. What the card costs *you* is a moving target that changes every time you
   * buy something, so it lives in the tooltip, which is read deliberately rather than glanced at.
   *
   * Every size does this, the buy panel's `detail` card included: that panel already lists the
   * exact tokens you are about to hand over immediately beside the card, so a discounted number on
   * the face would be a third copy of the same figure sitting two inches from the other two.
   */
  const costEntries = Object.entries(def.cost).filter(([, n]) => (n ?? 0) > 0) as [PayColor, number][];
  const yourCost = effectiveCost ?? def.cost;
  const discounted = PAY_COLORS.some((c) => (yourCost[c] ?? 0) !== (def.cost[c] ?? 0));
  /*
   * "free" now means printed free, and nothing else. The old face said it for both a free card and
   * one your bonuses had reduced to nothing, which are very different things to a player deciding
   * what to take; a reduced card keeps its printed gems, wearing the highlight below, and only the
   * tooltip says you pay nothing. The branch is unreachable with the shipped deck -- every jewel
   * card has a printed cost and royals render none at all -- so it is a guard, not a case.
   */
  const printedLine = costEntries.length > 0 ? `cost ${formatCost(def.cost)}` : 'free';
  const costDescription = discounted
    ? `${printedLine}; costs you ${formatCost(yourCost)} after your bonuses`
    : printedLine;
  const bonusColor = def.wild ? assignedColor ?? null : def.bonusColor;

  // Hoisted out of the cost row below because the discount highlight has to line up with it exactly.
  const costPitch = Math.min(30, 98 / Math.max(costEntries.length, 1));
  const costGemSize = costPitch * 0.94;
  const costStart = 52 - ((costEntries.length - 1) * costPitch) / 2;

  const classes = ['card', `card--${size}`];
  if (selected) classes.push('card-selected');
  if (affordable) classes.push('card-affordable');
  if (dimmed) classes.push('card-dimmed');
  if (onClick) classes.push('card-clickable');

  const describe = [
    `Level ${def.level || '-'}`,
    def.points ? `${def.points} prestige` : null,
    def.crowns ? `${def.crowns} crown${def.crowns > 1 ? 's' : ''}` : null,
    def.wild ? 'wild bonus' : bonusColor ? `${def.bonusCount}x ${bonusColor} bonus` : 'no bonus',
    costDescription,
    ...def.abilities.map((a) => ABILITY_LABEL[a] ?? a),
  ]
    .filter(Boolean)
    .join('; ');

  return (
    <svg
      className={classes.join(' ')}
      viewBox="0 0 104 151"
      role={onClick ? 'button' : 'img'}
      tabIndex={onClick ? 0 : undefined}
      aria-label={describe}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <title>{title ?? describe}</title>
      <rect x={1} y={1} width={102} height={149} rx={8} fill={LEVEL_TINT[def.level] ?? '#333'} stroke="rgba(0,0,0,0.5)" />
      <rect x={1} y={1} width={102} height={149} rx={8} fill="url(#cardSheen)" opacity={0.35} />

      {/*
        There is no artwork to leave room for, so the attributes get the whole face. Everything below
        is deliberately far larger than the printed card's proportions: at 60-110px wide, which is
        where these actually render, a faithful layout leaves a big empty middle and numbers too
        small to read.
      */}

      {/*
        Royals get their own layout. They carry only prestige and one ability -- no cost, no bonus, no
        crowns -- so laying them out like a jewel card wastes most of the face, and they are the
        smallest cards on the board. Filling it makes them legible without needing more pixels.
      */}
      {def.kind === 'royal' ? (
        <g>
          <text x={52} y={62} fontSize={54} fontWeight={800} textAnchor="middle" fill="#f6ebca">
            {def.points}
          </text>
          <text x={52} y={80} fontSize={12} textAnchor="middle" fill="rgba(255,255,255,0.5)">
            PRESTIGE
          </text>
          {def.abilities.length > 0 ? (
            <g transform="translate(52 116)">
              <circle r={24} fill="rgba(0,0,0,0.34)" stroke="rgba(255,255,255,0.32)" strokeWidth={1.4} />
              <text textAnchor="middle" dominantBaseline="central" fontSize={28} fill="#f4ecd6">
                {ABILITY_GLYPH[def.abilities[0] as string] ?? '•'}
              </text>
            </g>
          ) : (
            <text x={52} y={122} fontSize={13} textAnchor="middle" fill="#cdbfa0">
              no ability
            </text>
          )}
        </g>
      ) : null}

      {/* Prestige: the largest thing on the card. */}
      {def.kind !== 'royal' && def.points > 0 && (
        <text x={9} y={45} fontSize={44} fontWeight={800} fill="#f6ebca">
          {def.points}
        </text>
      )}

      {/* Bonus, top-right. Two gems for a double bonus, rather than a small "2" to squint at. */}
      <g>
        {def.kind === 'royal' ? null : def.wild && !bonusColor ? (
          <g transform="translate(76 30)">
            <rect x={-15} y={-15} width={30} height={30} rx={6} transform="rotate(45)" fill="#9a91b4" stroke="#5d5673" strokeWidth={1.2} />
            <text textAnchor="middle" dominantBaseline="central" fontSize={20} fontWeight={800} fill="#fff">
              ?
            </text>
          </g>
        ) : bonusColor ? (
          def.bonusCount > 1 ? (
            <g>
              <Gem color={bonusColor} size={30} x={61} y={30} />
              <Gem color={bonusColor} size={30} x={85} y={30} />
            </g>
          ) : (
            <Gem color={bonusColor} size={38} x={78} y={30} />
          )
        ) : null}
      </g>

      {/* Crowns, under the prestige number. */}
      {def.kind !== 'royal' && def.crowns > 0 && (
        <g>
          {Array.from({ length: def.crowns }, (_, i) => (
            <Crown key={i} size={24} x={16 + i * 22} y={68} />
          ))}
        </g>
      )}

      {/* Abilities, centre. Big enough to identify at a glance. */}
      <g>
        {(() => {
          if (def.kind === 'royal') return null;
          const shown = def.abilities.filter((a) => a !== 'wildBonus' || !bonusColor);
          return shown.map((ability, i) => (
            <g key={ability} transform={`translate(${52 + i * 30 - (shown.length - 1) * 15} ${def.crowns > 0 ? 100 : 92})`}>
              <circle r={17} fill="rgba(0,0,0,0.34)" stroke="rgba(255,255,255,0.3)" strokeWidth={1.2} />
              <text textAnchor="middle" dominantBaseline="central" fontSize={20} fill="#f4ecd6">
                {ABILITY_GLYPH[ability] ?? '•'}
              </text>
            </g>
          ));
        })()}
      </g>

      {/* Cost along the bottom, sized to however many colours it asks for (up to four). */}
      {costEntries.length > 0 && (
        <g>
          {/*
            A discount is worth seeing without hovering, so the row gets a capsule behind it when
            your bonuses have moved the price. Green was the obvious colour and is wrong: green is
            already the affordable outline, and a card can be discounted and still out of reach.
            Cream only says "there is something to read here", which is all this has to do.
          */}
          {discounted && (
            <rect
              x={costStart - costGemSize / 2 - 2}
              y={130 - costGemSize / 2 - 2}
              width={(costEntries.length - 1) * costPitch + costGemSize + 4}
              height={costGemSize + 4}
              rx={6}
              fill="rgba(246,235,202,0.13)"
              stroke="rgba(246,235,202,0.5)"
              strokeWidth={1.1}
            />
          )}
          {costEntries.map(([color, amount], i) => (
            <Gem
              key={color}
              color={color}
              size={costGemSize}
              label={String(amount)}
              x={costStart + i * costPitch}
              y={130}
            />
          ))}
        </g>
      )}
      {def.kind !== 'royal' && costEntries.length === 0 && (
        <text x={52} y={135} fontSize={15} textAnchor="middle" fill="#d8cbac">
          free
        </text>
      )}

      <text x={98} y={13} fontSize={11} fontWeight={700} textAnchor="end" fill="rgba(255,255,255,0.34)">
        {def.kind === 'royal' ? 'R' : `L${def.level}`}
      </text>
    </svg>
  );
}

/** Gradient definitions shared by every card on the page. */
export function CardDefs() {
  return (
    <svg width={0} height={0} aria-hidden style={{ position: 'absolute' }}>
      <defs>
        <linearGradient id="cardSheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={0.18} />
          <stop offset="55%" stopColor="#ffffff" stopOpacity={0.02} />
          <stop offset="100%" stopColor="#000000" stopOpacity={0.18} />
        </linearGradient>
      </defs>
    </svg>
  );
}
