import { useEffect, useMemo, useRef, useState } from 'react';
import { card, tryCard } from '../cards.js';
import { legalActionsFromView } from '../predict.js';
import { effectiveCost, minimalPayment } from '../score.js';
import type {
  GemColor,
  Level,
  PayColor,
  PlayerView,
  SplendorAction,
  SplendorView,
  TokenColor,
} from '../types.js';
import { GEM_COLORS, PAY_COLORS, TOKEN_COLORS, TOKEN_LIMIT } from '../types.js';
import { CardDefs, CardView, Crown, Gem } from './Card.tsx';
import { HelpPanel, TurnGuide, VictoryTracker, describeTurn } from './Guide.tsx';
import { COL_GAP, ROW_GAP, useBoardMetrics } from './metrics.js';
import { TokenBoard } from './TokenBoard.tsx';
import './splendor.css';

// Re-exported so the app shell can render a move log in this game's own vocabulary rather than
// printing raw card ids.
export { describeEffect, cardLabel } from './Guide.tsx';

/**
 * The Splendor Duel board.
 *
 * Affordances come from the game's own `legalActionsFromView`, so what the UI offers and what the
 * server will accept cannot drift apart. Anything not in that set is simply not clickable.
 */

interface BoardProps {
  view: unknown;
  seat: number | null;
  actors: number[];
  submit: (action: unknown) => void;
  pending: boolean;
}

const SEEN_HELP = 'sd:seen-help';

/**
 * `localStorage` throws in private-browsing modes and when storage is disabled, and is simply absent
 * outside a browser. Remembering whether the help panel was dismissed is not worth taking the whole
 * board down for, so both directions are guarded.
 */
function readFlag(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Nothing to do; the panel just opens again next time.
  }
}

type ReserveSource = { t: 'pyramid'; level: Level; slot: number } | { t: 'deck'; level: Level };
type BuyRef = { t: 'pyramid'; level: Level; slot: number } | { t: 'reserved'; cardId: string };

type Mode =
  | { k: 'idle' }
  | { k: 'privilege' }
  | { k: 'reserve'; from: ReserveSource }
  | { k: 'buy'; ref: BuyRef };

export default function SplendorDuelBoard({ view: raw, seat, actors, submit, pending }: BoardProps) {
  const view = raw as SplendorView | null;
  const [selectedCells, setSelectedCells] = useState<number[]>([]);
  const [mode, setMode] = useState<Mode>({ k: 'idle' });
  const [wildColor, setWildColor] = useState<GemColor | null>(null);
  const [goldSwaps, setGoldSwaps] = useState<Partial<Record<PayColor, number>>>({});
  const [discardPick, setDiscardPick] = useState<Partial<Record<TokenColor, number>>>({});
  /*
   * The middle row's height is decided by flex and does not depend on its contents, so measuring it
   * and sizing the cards and board to fit is not circular. This is what lets the board use spare
   * *width* as well as spare height -- a viewport-height clamp alone left the cards small with a few
   * hundred pixels sitting empty beside the board. See metrics.ts.
   */
  const middleRef = useRef<HTMLDivElement>(null);
  const metrics = useBoardMetrics(middleRef);

  /**
   * Whose turn it is, according to the view being rendered.
   *
   * Deliberately *not* the server's `actors`. While an optimistic move is unconfirmed the two
   * disagree — the server still lists you as the actor, while the predicted view has already passed
   * the turn — and mixing them produces a board that says "your turn" while offering nothing to do.
   * The view is what is on screen, so the view decides. `actors` is still what the server enforces,
   * and `pending` locks input until it confirms.
   */
  const myTurn = seat !== null && view !== null && view.turn === seat && view.stage !== 'over';

  const legal = useMemo(() => {
    if (!view || seat === null || !myTurn) return [];
    try {
      return legalActionsFromView(view, seat).actions;
    } catch (error) {
      // Never let this take the board down -- but do not hide it either. An empty list here means
      // the player is told it is their turn with nothing to do, which is worse than a visible error.
      console.error('legalActionsFromView failed', error, JSON.stringify(view));
      return [];
    }
  }, [view, seat, myTurn]);

  // Any change of turn, stage, or pending decision invalidates a half-built selection.
  useEffect(() => {
    setSelectedCells([]);
    setMode({ k: 'idle' });
    setWildColor(null);
    setGoldSwaps({});
    setDiscardPick({});
  }, [view?.turn, view?.stage, view?.pending?.k]);

  if (!view || seat === null) return <p className="muted">Waiting for the board…</p>;

  const me = view.players[seat as 0 | 1];
  const them = view.players[(1 - seat) as 0 | 1];
  const decided = view.pending;
  const locked = pending || !myTurn;

  /* ------------------------------------------------------------ derived affordances */

  const has = (predicate: (a: SplendorAction) => boolean) => legal.some(predicate);

  const takeLines = legal.filter((a): a is Extract<SplendorAction, { t: 'takeTokens' }> => a.t === 'takeTokens');
  const privilegeCells = new Set(
    legal.filter((a) => a.t === 'usePrivilege').map((a) => (a as { cell: number }).cell),
  );
  const matchingCells = new Set(
    legal.filter((a) => a.t === 'chooseMatchingToken').map((a) => (a as { cell: number }).cell),
  );
  const goldCells = new Set(
    legal.filter((a) => a.t === 'reserve').map((a) => (a as { goldCell: number }).goldCell),
  );

  /** Cells that could still extend the current take-tokens selection into a legal line. */
  const extendableCells = new Set<number>();
  if (mode.k === 'idle' && !decided) {
    for (const line of takeLines) {
      if (selectedCells.every((c) => line.cells.includes(c))) {
        for (const c of line.cells) if (!selectedCells.includes(c)) extendableCells.add(c);
      }
    }
  }

  const selectedIsCompleteLine =
    selectedCells.length > 0 &&
    takeLines.some(
      (line) => line.cells.length === selectedCells.length && selectedCells.every((c) => line.cells.includes(c)),
    );

  let selectable = new Set<number>();
  let onCellClick = (_cell: number) => undefined as void;

  if (decided?.k === 'matchingToken') {
    selectable = matchingCells;
    onCellClick = (cell) => submit({ t: 'chooseMatchingToken', cell } satisfies SplendorAction);
  } else if (mode.k === 'privilege') {
    selectable = privilegeCells;
    onCellClick = (cell) => {
      submit({ t: 'usePrivilege', cell } satisfies SplendorAction);
      setMode({ k: 'idle' });
    };
  } else if (mode.k === 'reserve') {
    selectable = goldCells;
    onCellClick = (cell) => {
      submit({ t: 'reserve', goldCell: cell, from: mode.from } satisfies SplendorAction);
      setMode({ k: 'idle' });
    };
  } else if (!decided && !locked) {
    selectable = new Set([...extendableCells, ...selectedCells]);
    onCellClick = (cell) =>
      setSelectedCells((prev) => (prev.includes(cell) ? prev.filter((c) => c !== cell) : [...prev, cell]));
  }

  /* ------------------------------------------------------------ purchase helpers */

  const buyRef = mode.k === 'buy' ? mode.ref : null;
  const buyCardId = buyRef
    ? buyRef.t === 'pyramid'
      ? view.pyramid[buyRef.level][buyRef.slot] ?? null
      : buyRef.cardId
    : null;
  const buyCard = buyCardId ? tryCard(buyCardId) : undefined;

  // `effectiveCost`/`minimalPayment` take a PlayerState; a PlayerView is a structural superset of
  // the fields they read (tokens, stacks, colorless, royals), so this is safe and avoids duplicating
  // the discount rules in the UI.
  const asPlayerState = me as unknown as Parameters<typeof effectiveCost>[0];
  const buyCost = buyCardId ? effectiveCost(asPlayerState, buyCardId) : {};
  const basePayment = buyCardId ? minimalPayment(asPlayerState, buyCost) : null;

  const payment: Partial<Record<TokenColor, number>> = {};
  if (basePayment) {
    for (const [c, n] of Object.entries(basePayment)) payment[c as TokenColor] = n;
    for (const [colorRaw, swapRaw] of Object.entries(goldSwaps)) {
      const color = colorRaw as PayColor;
      const swap = swapRaw ?? 0;
      if (swap <= 0) continue;
      const current = payment[color] ?? 0;
      const applied = Math.min(current, swap);
      if (applied <= 0) continue;
      if (current - applied === 0) delete payment[color];
      else payment[color] = current - applied;
      payment.gold = (payment.gold ?? 0) + applied;
    }
  }
  const paymentValid = basePayment !== null && (payment.gold ?? 0) <= me.tokens.gold;
  const needsWild = Boolean(buyCard?.wild);
  const wildOptions = me.stacks.map((s) => s.color);
  const canConfirmBuy =
    paymentValid && (!needsWild || (wildColor !== null && wildOptions.includes(wildColor)));

  const confirmBuy = () => {
    if (!buyRef || !canConfirmBuy) return;
    submit({
      t: 'purchase',
      from: buyRef,
      payment,
      ...(needsWild && wildColor ? { wildColor } : {}),
    } satisfies SplendorAction);
    setMode({ k: 'idle' });
    setWildColor(null);
    setGoldSwaps({});
  };

  /** Cards this player could buy right now, for highlighting. */
  const affordable = new Set<string>();
  for (const action of legal) {
    if (action.t !== 'purchase') continue;
    const id = action.from.t === 'pyramid' ? view.pyramid[action.from.level][action.from.slot] : action.from.cardId;
    if (id) affordable.add(id);
  }

  const reservableRefs = legal.filter((a) => a.t === 'reserve') as Extract<SplendorAction, { t: 'reserve' }>[];
  const canReserveFrom = (from: { t: 'pyramid'; level: Level; slot: number } | { t: 'deck'; level: Level }) =>
    reservableRefs.some((a) => JSON.stringify(a.from) === JSON.stringify(from));

  const discardTotal = TOKEN_COLORS.reduce((t, c) => t + (discardPick[c] ?? 0), 0);

  /* ------------------------------------------------------------ render */

  return (
    <div
      className="sd"
      style={
        {
          '--card-w': `${metrics.cardW}px`,
          // Published from metrics.ts so the arithmetic there and the layout here cannot disagree.
          '--row-gap': `${ROW_GAP}px`,
          '--col-gap': `${COL_GAP}px`,
          '--royal-w': `${metrics.royalW}px`,
          '--board-size': `${metrics.boardSize}px`,
        } as React.CSSProperties
      }
    >
      <CardDefs />

      <PlayerStrip player={them} label="Opponent" isTurn={actors.includes(them.seat)} />

      <div className="sd-middle" ref={middleRef}>
        <div className="sd-pyramid">
          {([3, 2, 1] as Level[]).map((level) => (
            <div className="sd-row" key={level}>
              <div className="sd-deck" title={`${view.decks[level]} cards left in the level ${level} deck`}>
                <span className="sd-deck-level">L{level}</span>
                <span className="sd-deck-count">{view.decks[level]}</span>
                {/* An icon, not the word: the deck column is only ~0.56 of a card wide, so "reserve"
                    was clipped to "eserve". The label lives in the tooltip and the aria-label. */}
                <button
                  type="button"
                  className="mini sd-deck-reserve"
                  disabled={locked || !canReserveFrom({ t: 'deck', level })}
                  onClick={() => setMode({ k: 'reserve', from: { t: 'deck', level } })}
                  title={`Take a gold token and reserve the top card of the level ${level} deck, face down`}
                  aria-label={`Reserve the top card of the level ${level} deck`}
                >
                  ↓
                </button>
              </div>
              {/* No per-card reserve button: clicking a card opens a panel offering both buy and
                  reserve. Twelve extra buttons cost three rows of height, which is the difference
                  between the board fitting on a laptop screen and not. */}
              {view.pyramid[level].map((cardId, slot) => (
                <CardView
                  key={`${level}-${slot}`}
                  cardId={cardId}
                  size="pyramid"
                  effectiveCost={cardId && tryCard(cardId) ? effectiveCost(asPlayerState, cardId) : undefined}
                  affordable={cardId ? affordable.has(cardId) : false}
                  selected={buyRef?.t === 'pyramid' && buyRef.level === level && buyRef.slot === slot}
                  onClick={
                    cardId && tryCard(cardId) && !locked
                      ? () => setMode({ k: 'buy', ref: { t: 'pyramid', level, slot } })
                      : undefined
                  }
                />
              ))}
            </div>
          ))}
        </div>

        <div className="sd-right">
          <TokenBoard
            board={view.board}
            selected={selectedCells}
            selectable={selectable}
            onCellClick={onCellClick}
            replenishPreview={mode.k === 'idle' && has((a) => a.t === 'replenish') ? view.bag.total : 0}
          />

          {/* Under the board, in the board column: they get a real size here, and the column is as
              wide as the board so four of them fit comfortably. */}
          <div className="sd-royals">
            <span className="sd-label">Royals</span>
            <div className="sd-royal-row">
              {view.royals.map((royalId, i) => (
                <CardView
                  key={i}
                  cardId={royalId}
                  size="royal"
                  affordable={decided?.k === 'royal' && royalId !== null}
                  onClick={
                    decided?.k === 'royal' && royalId && !locked
                      ? () => submit({ t: 'chooseRoyal', royalId } satisfies SplendorAction)
                      : undefined
                  }
                />
              ))}
            </div>
          </div>
        </div>

      </div>

      {/*
        Bag, scrolls and the victory tracker, as one full-width strip. It was briefly a column beside
        the board, which used more of the spare width but made the whole board resize whenever the
        turn changed: the turn guide is ~150px taller on your turn than while waiting, which moved the
        height budget enough to flip the column in and out. A stable board beats a slightly fuller one.
      */}
      <div className="sd-info">
        <div className="sd-bag" title="The bag's contents are public; only its order is secret">
          <span className="sd-label">Bag ({view.bag.total})</span>
          <div className="sd-bag-gems">
            {TOKEN_COLORS.filter((c) => view.bag.counts[c] > 0).map((c) => (
              <svg key={c} className="gem-chip" viewBox="-13 -13 26 26">
                <title>{`${view.bag.counts[c]} ${c} in the bag`}</title>
                <Gem color={c} size={22} label={String(view.bag.counts[c])} />
              </svg>
            ))}
            {view.bag.total === 0 && <span className="muted">empty</span>}
          </div>
        </div>
        <div className="sd-privileges" title="Privilege scrolls held by neither player">
          <span className="sd-label">Scrolls above the board</span>
          <span className="sd-scrolls">{'✦'.repeat(view.privilegePool) || '—'}</span>
        </div>
        {/* Here rather than in the sidebar: this strip is wide and short, and the sidebar's height is
            better spent on the turn guide. */}
        <VictoryTracker player={me} />
      </div>

      <div className="sd-bottom">
        <PlayerStrip player={me} label="You" isTurn={myTurn} />
      </div>

      {/* ------------------------------------------------ action bar */}
      <div className="sd-actions">
        {!myTurn && <span className="muted">Waiting for your opponent…</span>}
        {pending && <span className="muted">Sending…</span>}

        {myTurn && decided?.k === 'matchingToken' && (
          <span className="prompt">Take a {decided.color} token from the board.</span>
        )}
        {myTurn && decided?.k === 'royal' && <span className="prompt">Claim a royal card.</span>}
        {myTurn && decided?.k === 'steal' && (
          <span className="prompt">
            Steal a token:
            {PAY_COLORS.filter((c) => them.tokens[c] > 0).map((c) => (
              <button key={c} type="button" className="mini" onClick={() => submit({ t: 'chooseSteal', color: c } satisfies SplendorAction)}>
                {c}
              </button>
            ))}
          </span>
        )}

        {myTurn && decided?.k === 'discard' && (
          <span className="prompt">
            <span>
              Discard {decided.count} token{decided.count > 1 ? 's' : ''} — {discardTotal}/{decided.count} chosen
            </span>
            {/* An explicit +/- per colour rather than a click-to-cycle counter. Cycling looks tidier
                but silently wraps back to zero once you reach your holdings, which makes some valid
                discards unreachable and leaves the player stuck with no way to finish their turn. */}
            {TOKEN_COLORS.filter((c) => me.tokens[c] > 0).map((c) => {
              const picked = discardPick[c] ?? 0;
              const canAdd = picked < me.tokens[c] && discardTotal < decided.count;
              return (
                <span className="sd-stepper" key={c}>
                  <button
                    type="button"
                    className="mini"
                    aria-label={`One fewer ${c}`}
                    disabled={picked === 0}
                    onClick={() => setDiscardPick((prev) => ({ ...prev, [c]: Math.max(0, (prev[c] ?? 0) - 1) }))}
                  >
                    −
                  </button>
                  <span className="sd-stepper-label">
                    {c} {picked}/{me.tokens[c]}
                  </span>
                  <button
                    type="button"
                    className="mini"
                    aria-label={`One more ${c}`}
                    disabled={!canAdd}
                    onClick={() =>
                      setDiscardPick((prev) => {
                        const current = prev[c] ?? 0;
                        const total = TOKEN_COLORS.reduce((t, k) => t + (prev[k] ?? 0), 0);
                        // Derived from `prev`, not from the render-time total, which would be stale.
                        if (current >= me.tokens[c] || total >= decided.count) return prev;
                        return { ...prev, [c]: current + 1 };
                      })
                    }
                  >
                    +
                  </button>
                </span>
              );
            })}
            <button
              type="button"
              disabled={discardTotal !== decided.count}
              title={
                discardTotal === decided.count
                  ? 'Return these tokens to the bag'
                  : `Choose exactly ${decided.count}`
              }
              onClick={() => submit({ t: 'discard', tokens: discardPick } satisfies SplendorAction)}
            >
              Discard
            </button>
          </span>
        )}

        {myTurn && !decided && (
          <>
            <button
              type="button"
              disabled={locked || !selectedIsCompleteLine}
              title={
                selectedCells.length === 0
                  ? 'Click 1-3 adjacent tokens in a straight line on the board first'
                  : selectedIsCompleteLine
                    ? takeWarning(selectedCells.map((c) => view.board[c] ?? null))
                    : 'Those tokens are not in an unbroken straight line'
              }
              onClick={() => {
                submit({ t: 'takeTokens', cells: selectedCells } satisfies SplendorAction);
                setSelectedCells([]);
              }}
            >
              Take {selectedCells.length || ''} token{selectedCells.length === 1 ? '' : 's'}
            </button>
            {selectedIsCompleteLine && takeGivesScroll(selectedCells.map((c) => view.board[c] ?? null)) && (
              <span className="sd-warn">gives your opponent a scroll</span>
            )}
            {selectedCells.length > 0 && (
              <button type="button" className="mini" onClick={() => setSelectedCells([])}>
                clear
              </button>
            )}
            <button
              type="button"
              disabled={locked || privilegeCells.size === 0}
              className={mode.k === 'privilege' ? 'active' : ''}
              onClick={() => setMode(mode.k === 'privilege' ? { k: 'idle' } : { k: 'privilege' })}
              title="Return a scroll to take any single non-gold token"
            >
              Spend scroll ({me.privileges})
            </button>
            <button
              type="button"
              disabled={locked || !has((a) => a.t === 'replenish')}
              onClick={() => submit({ t: 'replenish' } satisfies SplendorAction)}
              title="Refill the board from the bag. Your opponent gains a scroll, and you cannot spend scrolls afterwards this turn."
            >
              Replenish
            </button>
            {has((a) => a.t === 'pass') && (
              <button type="button" onClick={() => submit({ t: 'pass' } satisfies SplendorAction)} title="No legal move is available">
                Pass (stuck)
              </button>
            )}
            {mode.k === 'reserve' && (
              <span className="prompt">
                Click a gold token to reserve.
                <button type="button" className="mini" onClick={() => setMode({ k: 'idle' })}>
                  cancel
                </button>
              </span>
            )}
          </>
        )}
      </div>

      {/* ------------------------------------------------ purchase panel */}
      {buyCard && buyCardId && (
        <div className="sd-buy" role="dialog" aria-label={`Card options: ${buyCard.name}`}>
          <CardView cardId={buyCardId} size="detail" effectiveCost={buyCost} />
          <div className="sd-buy-body">
            <h4>{buyCard.name}</h4>
            {basePayment === null ? (
              <p className="error">You cannot afford this card.</p>
            ) : (
              <>
                <p className="muted">Paying:</p>
                <div className="sd-pay">
                  {(Object.entries(payment) as [TokenColor, number][])
                    .filter(([, n]) => n > 0)
                    .map(([color, n]) => (
                      <svg key={color} width={30} height={30} viewBox="-15 -15 30 30">
                        <Gem color={color} size={26} label={String(n)} />
                      </svg>
                    ))}
                  {Object.keys(payment).length === 0 && <span className="muted">nothing — it is free</span>}
                </div>
                {me.tokens.gold > 0 && (
                  <div className="sd-swaps">
                    <span className="muted">Substitute gold:</span>
                    {(Object.keys(buyCost) as PayColor[]).map((color) => (
                      <button
                        key={color}
                        type="button"
                        className="mini"
                        onClick={() =>
                          setGoldSwaps((prev) => {
                            const next = (prev[color] ?? 0) + 1;
                            const cap = Math.min(basePayment[color] ?? 0, me.tokens.gold - (payment.gold ?? 0) + (prev[color] ?? 0));
                            return { ...prev, [color]: next > cap ? 0 : next };
                          })
                        }
                      >
                        {color} {goldSwaps[color] ? `→${goldSwaps[color]} gold` : ''}
                      </button>
                    ))}
                  </div>
                )}
                {needsWild && (
                  <div className="sd-wild">
                    <span className="muted">This wild card joins:</span>
                    {wildOptions.length === 0 ? (
                      <span className="error">You own no bonus card, so it cannot be bought.</span>
                    ) : (
                      wildOptions.map((color) => (
                        <button
                          key={color}
                          type="button"
                          className={`mini ${wildColor === color ? 'active' : ''}`}
                          onClick={() => setWildColor(color)}
                        >
                          {color}
                        </button>
                      ))
                    )}
                    <span className="muted small">Permanent — it counts as this colour for the rest of the game.</span>
                  </div>
                )}
              </>
            )}
            <div className="row">
              <button type="button" disabled={locked || !canConfirmBuy} onClick={confirmBuy}>
                Buy
              </button>
              {buyRef?.t === 'pyramid' && (
                <button
                  type="button"
                  disabled={locked || !canReserveFrom({ t: 'pyramid', level: buyRef.level, slot: buyRef.slot })}
                  title="Take a gold token and keep this card for later, out of your opponent's reach"
                  onClick={() =>
                    setMode({ k: 'reserve', from: { t: 'pyramid', level: buyRef.level, slot: buyRef.slot } })
                  }
                >
                  Reserve
                </button>
              )}
              <button type="button" className="mini" onClick={() => setMode({ k: 'idle' })}>
                cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Only the mandatory take action can hand the opponent a scroll, and only for three of one colour
 * or for both pearls. Surfaced before the click, because it is the rule new players trip over most.
 */
function takeGivesScroll(colors: (TokenColor | null)[]): boolean {
  const taken = colors.filter((c): c is TokenColor => c !== null);
  const threeAlike = taken.length === 3 && taken.every((c) => c === taken[0]);
  const bothPearls = taken.filter((c) => c === 'pearl').length === 2;
  return threeAlike || bothPearls;
}

function takeWarning(colors: (TokenColor | null)[]): string {
  return takeGivesScroll(colors)
    ? 'Careful: three of one colour or both pearls gives your opponent a privilege scroll'
    : 'Take these tokens';
}

/* ------------------------------------------------------------------ player strip */

function PlayerStrip({
  player,
  label,
  isTurn,
}: {
  player: PlayerView;
  label: string;
  isTurn: boolean;
}) {
  return (
    <section className={`sd-player ${isTurn ? 'sd-player-turn' : ''}`}>
      <header>
        <strong>{label}</strong>
        <span className="sd-score" title="Prestige points (jewel + royal cards)">
          {player.points} pts
        </span>
        <span className="sd-score" title="Crowns (jewel cards only)">
          <svg width={16} height={16} viewBox="-8 -8 16 16">
            <Crown size={14} />
          </svg>
          {player.crowns}
        </span>
        <span className={`sd-score ${player.tokenTotal > TOKEN_LIMIT ? 'over' : ''}`} title="Tokens held; the limit of 10 applies between turns">
          {player.tokenTotal}/{TOKEN_LIMIT}
        </span>
        <span className="sd-score" title="Privilege scrolls held">
          ✦{player.privileges}
        </span>
      </header>

      <div className="sd-player-body">
        <div className="sd-group">
          <span className="sd-label">Tokens held</span>
          <div className="sd-tokens">
            {TOKEN_COLORS.filter((c) => player.tokens[c] > 0).map((c) => (
              <svg key={c} width={30} height={30} viewBox="-15 -15 30 30">
                <title>{`${player.tokens[c]} ${c}`}</title>
                <Gem color={c} size={26} label={String(player.tokens[c])} />
              </svg>
            ))}
            {player.tokenTotal === 0 && <span className="muted">none</span>}
          </div>
        </div>

        <div className="sd-group">
          {/* Bonus count is the discount; the number beside it is prestige in that colour, which is
              what the same-colour victory condition counts. */}
          <span className="sd-label">Bonuses / colour points</span>
          <div className="sd-stacks">
            {GEM_COLORS.filter((c) => player.bonuses[c] > 0 || player.colorPoints[c] > 0).map((color) => (
              <div
                className="sd-stack"
                key={color}
                title={`${player.bonuses[color]} ${color} bonus (discount), ${player.colorPoints[color]} prestige in ${color}`}
              >
                <svg width={22} height={22} viewBox="-11 -11 22 22">
                  <Gem color={color} size={20} label={String(player.bonuses[color])} />
                </svg>
                <span className={player.colorPoints[color] >= 10 ? 'win-close' : ''}>
                  {player.colorPoints[color]}
                </span>
              </div>
            ))}
            {player.colorless.length > 0 && (
              <div className="sd-stack" title="Cards with no bonus colour: prestige only">
                <span className="sd-nobonus">◻</span>
                <span>{player.colorless.reduce((t, id) => t + card(id).points, 0)}</span>
              </div>
            )}
            {player.stacks.length === 0 && player.colorless.length === 0 && (
              <span className="muted">none yet</span>
            )}
          </div>
        </div>

        <div className="sd-reserved">
          <span className="sd-label">Reserved</span>
          <div className="row">
            {player.reserved.length === 0 && <span className="muted">none</span>}
            {player.reserved.map((held, i) =>
              'cardId' in held ? (
                <CardView key={i} cardId={held.cardId} size="small" />
              ) : (
                <div key={i} className="sd-facedown" title="Reserved from a deck — only its owner knows what it is">
                  ?
                </div>
              ),
            )}
          </div>
        </div>

        {player.royals.length > 0 && (
          <div className="sd-reserved">
            <span className="sd-label">Royals</span>
            <div className="row">
              {player.royals.map((id) => (
                <CardView key={id} cardId={id} size="small" />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}


/* ------------------------------------------------------------------ sidebar panel */

/**
 * The turn guide, the rules cheatsheet and the victory tracker, rendered in the app's sidebar.
 *
 * These used to sit above the board. The guide is roughly 150px taller on your turn than while you
 * are waiting, so in the board column it moved the height budget every single move and the cards and
 * token board visibly resized each time. Out here it costs the board nothing and never jumps.
 */
export function Sidebar({ view: raw, seat, actors, pending }: BoardProps) {
  const view = raw as SplendorView | null;
  const [helpOpen, setHelpOpen] = useState(() => readFlag(SEEN_HELP) !== '1');

  const myTurn = seat !== null && view !== null && view.turn === seat && view.stage !== 'over';
  const legal = useMemo(() => {
    if (!view || seat === null || !myTurn) return [];
    try {
      return legalActionsFromView(view, seat).actions;
    } catch {
      return [];
    }
  }, [view, seat, myTurn]);

  if (!view || seat === null) return null;

  const closeHelp = () => {
    setHelpOpen(false);
    writeFlag(SEEN_HELP, '1');
  };

  return (
    <div className="sd-sidebar">
      {helpOpen && <HelpPanel onClose={closeHelp} />}
      <TurnGuide
        suggestions={myTurn ? describeTurn(view, seat, legal) : []}
        myTurn={myTurn}
        onOpenHelp={() => setHelpOpen(true)}
      />
      {pending && <span className="muted">Sending…</span>}
      {actors.length === 0 && <span className="muted">Match over.</span>}
    </div>
  );
}
