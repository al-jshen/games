import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Work out how big the cards, the token board and the royal cards should be.
 *
 * Why this is measured in JS rather than expressed as CSS clamps: the sizes depend on *both* the
 * available width and the available height, and on each other. A `vh`-only clamp — which is what
 * this replaced — ignores width entirely, so on a wide window the cards stayed small while a few
 * hundred pixels sat empty beside the board.
 *
 * The circularity that usually makes this hard is avoided by having the container's height come from
 * flex (`flex: 1 1 0`), so it does not depend on its contents at all. We measure that box and then
 * size the contents to fit inside it. Because the contents cannot change the box, the measurement
 * settles on the first pass instead of oscillating.
 */

/** Card art is 104x151. */
const CARD_ASPECT = 151 / 104;
/*
 * The gaps are exported and applied as CSS custom properties rather than duplicated in the
 * stylesheet. They were originally a constant here and a `clamp()` there, which disagreed by a pixel
 * at some viewport heights and clipped the bottom card row.
 */
export const ROW_GAP = 6;
export const COL_GAP = 16;
/** The deck column is a fraction of a card wide. */
const DECK_RATIO = 0.56;
/** Royals read as secondary to the pyramid, but must stay legible. */
const ROYAL_RATIO = 0.78;

const CARD_MIN = 42;
/** Beyond its natural size a card is just blurry upscaled SVG. */
const CARD_MAX = 151;
const BOARD_MIN = 168;
const BOARD_MAX = 540;

export interface BoardMetrics {
  cardW: number;
  boardSize: number;
  royalW: number;
}

const FALLBACK: BoardMetrics = { cardW: 92, boardSize: 290, royalW: 72 };

function clamp(min: number, value: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export function computeMetrics(width: number, height: number): BoardMetrics {
  if (!(width > 0) || !(height > 0)) return FALLBACK;

  // Three card rows plus their gaps have to fit the height. The 2px is slack for sub-pixel rounding
  // between this arithmetic and the browser's layout.
  const byHeight = (height - 2 * ROW_GAP - 2) / (3 * CARD_ASPECT);
  let cardW = clamp(CARD_MIN, byHeight, CARD_MAX);

  const pyramidWidth = (w: number) => w * DECK_RATIO + w * 5 + 5 * ROW_GAP;

  // If the pyramid at that size would not leave the board its minimum, shrink the cards instead of
  // letting the two collide.
  const widthBudget = width - COL_GAP - BOARD_MIN;
  if (pyramidWidth(cardW) > widthBudget) {
    const byWidth = (widthBudget - 5 * ROW_GAP) / (5 + DECK_RATIO);
    cardW = clamp(CARD_MIN, Math.min(cardW, byWidth), CARD_MAX);
  }

  /*
   * Board and royals are mutually dependent: the royal row sits under the board and is sized to the
   * board's width, while the board's height is what is left after the royal row. Rather than solve
   * that algebraically, iterate -- it converges in three passes and stays obvious.
   */
  const boardAvailW = width - pyramidWidth(cardW) - COL_GAP;
  let boardSize = clamp(BOARD_MIN, Math.min(boardAvailW, height), BOARD_MAX);
  let royalW = 0;
  for (let pass = 0; pass < 4; pass++) {
    royalW = Math.min(cardW * ROYAL_RATIO, (boardSize - 3 * 5) / 4);
    // 40px covers the "Royals" label plus the gaps above and below it. Under-counting here left the
    // board column a couple of pixels taller than its container, which clipped the royal row.
    boardSize = clamp(BOARD_MIN, Math.min(boardAvailW, height - royalW * CARD_ASPECT - 40), BOARD_MAX);
  }

  return { cardW: Math.round(cardW), boardSize: Math.round(boardSize), royalW: Math.round(royalW) };
}

/** Measure `ref` and keep metrics in step with it. */
export function useBoardMetrics(ref: RefObject<HTMLElement | null>): BoardMetrics {
  const [metrics, setMetrics] = useState<BoardMetrics>(FALLBACK);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      const next = computeMetrics(element.clientWidth, element.clientHeight);
      setMetrics((prev) =>
        // Only re-render on a real change, so a sub-pixel wobble cannot loop.
        prev.cardW === next.cardW && prev.boardSize === next.boardSize && prev.royalW === next.royalW
          ? prev
          : next,
      );
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return metrics;
}
