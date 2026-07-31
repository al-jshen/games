import { tryCard } from '../cards.js';
import type { CardDef, GemColor, PayColor } from '../types.js';

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

export interface CardViewProps {
  cardId: string | null;
  size?: CardSize;
  /** Cost after the viewer's bonuses, when known; falls back to the printed cost. */
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

  const cost = effectiveCost ?? def.cost;
  const costEntries = Object.entries(cost).filter(([, n]) => (n ?? 0) > 0) as [PayColor, number][];
  const bonusColor = def.wild ? assignedColor ?? null : def.bonusColor;

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
    costEntries.length ? `cost ${costEntries.map(([c, n]) => `${n} ${c}`).join(', ')}` : 'free',
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
          {(() => {
            const n = costEntries.length;
            const pitch = Math.min(30, 98 / n);
            const size = pitch * 0.94;
            const start = 52 - ((n - 1) * pitch) / 2;
            return costEntries.map(([color, amount], i) => (
              <Gem key={color} color={color} size={size} label={String(amount)} x={start + i * pitch} y={130} />
            ));
          })()}
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
