import { SPIRAL } from '../spiral.js';
import type { TokenColor } from '../types.js';
import { Gem } from './Card.tsx';

/**
 * The 5x5 token board.
 *
 * The spiral is drawn faintly behind the cells, both because it is on the physical board and
 * because it tells the player where the next replenish will put tokens — which is real information
 * they use.
 */

const CELL = 52;
const GAP = 6;
const PAD = 10;
const SIZE = PAD * 2 + CELL * 5 + GAP * 4;

function cellXY(cell: number): { x: number; y: number } {
  const row = Math.floor(cell / 5);
  const col = cell % 5;
  return { x: PAD + col * (CELL + GAP), y: PAD + row * (CELL + GAP) };
}

export interface TokenBoardProps {
  board: (TokenColor | null)[];
  /** Cells currently chosen by the player. */
  selected: number[];
  /** Cells that can be clicked right now. */
  selectable: Set<number>;
  onCellClick: (cell: number) => void;
  /** Highlight the next N cells the spiral will fill, when a replenish is available. */
  replenishPreview?: number;
}

export function TokenBoard({
  board,
  selected,
  selectable,
  onCellClick,
  replenishPreview = 0,
}: TokenBoardProps) {
  const previewCells = new Set<number>();
  if (replenishPreview > 0) {
    let left = replenishPreview;
    for (const cell of SPIRAL) {
      if (left <= 0) break;
      if (board[cell] === null) {
        previewCells.add(cell);
        left -= 1;
      }
    }
  }

  // The path the spiral traces, for the faint guide line.
  const path = SPIRAL.map((cell, i) => {
    const { x, y } = cellXY(cell);
    return `${i === 0 ? 'M' : 'L'} ${x + CELL / 2} ${y + CELL / 2}`;
  }).join(' ');

  return (
    // No width/height attributes: CSS sizes it from the viewport height so the board shrinks with
    // everything else on a short screen instead of forcing the page to scroll.
    <svg className="token-board" viewBox={`0 0 ${SIZE} ${SIZE}`} role="grid" aria-label="Token board">
      <rect x={0} y={0} width={SIZE} height={SIZE} rx={12} fill="#241d1a" stroke="#3b302a" />
      <path d={path} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={2} strokeLinecap="round" />

      {board.map((token, cell) => {
        const { x, y } = cellXY(cell);
        const isSelected = selected.includes(cell);
        const canClick = selectable.has(cell);
        const isPreview = previewCells.has(cell);
        const order = SPIRAL.indexOf(cell);
        return (
          <g
            key={cell}
            transform={`translate(${x} ${y})`}
            className={[
              'cell',
              canClick ? 'cell-selectable' : '',
              isSelected ? 'cell-selected' : '',
              isPreview ? 'cell-preview' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="gridcell"
            tabIndex={canClick ? 0 : undefined}
            aria-label={`Cell ${cell}${token ? `, ${token}` : ', empty'}${canClick ? ', selectable' : ''}`}
            onClick={canClick ? () => onCellClick(cell) : undefined}
            onKeyDown={
              canClick
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onCellClick(cell);
                    }
                  }
                : undefined
            }
          >
            <rect
              width={CELL}
              height={CELL}
              rx={8}
              fill={token ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.03)'}
              stroke={isSelected ? '#f0c860' : isPreview ? 'rgba(240,200,96,0.45)' : 'rgba(255,255,255,0.10)'}
              strokeWidth={isSelected ? 2.5 : 1}
            />
            {!token && (
              <text x={CELL / 2} y={CELL / 2} textAnchor="middle" dominantBaseline="central" fontSize={10} fill="rgba(255,255,255,0.22)">
                {order + 1}
              </text>
            )}
            {token && <Gem color={token} size={34} x={CELL / 2} y={CELL / 2} />}
          </g>
        );
      })}
    </svg>
  );
}
