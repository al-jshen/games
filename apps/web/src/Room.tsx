import { useEffect, useState } from 'react';
import { loadBoard, type BoardModule, type EffectDescriber } from './games.js';
import { fullMoveTime, isRealTimestamp, moveTimeLabel } from './time.js';
import { client, useMatch } from './store.js';

export function Room({ onLeave }: { onLeave: () => void }) {
  const match = useMatch();
  const [board, setBoardModule] = useState<BoardModule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const Board = board?.default ?? null;
  const GameSidebar = board?.Sidebar ?? null;

  useEffect(() => {
    if (!match.gameId) return;
    let live = true;
    loadBoard(match.gameId)
      .then((mod) => {
        if (live) setBoardModule(mod);
      })
      .catch((err: Error) => {
        if (live) setLoadError(err.message);
      });
    return () => {
      live = false;
    };
  }, [match.gameId]);

  const waiting = match.players.length < 2;
  const outcome = match.confirmed?.outcome;
  const over = outcome?.status === 'over';

  return (
    <main className="room">
      <UndoDialog describe={board?.describeEffect} />

      <aside className="sidebar">
        <ShareCode code={match.code} waiting={waiting} />

        <section className="panel compact">
          <h3>Players</h3>
          <ul className="players">
            {match.players.map((player) => (
              <li key={player.seat} className={player.connected ? '' : 'offline'}>
                <span className={`dot seat-${player.seat}`} />
                <span className="pname">
                  {player.name}
                  {player.you ? ' (you)' : ''}
                </span>
                {match.actors.includes(player.seat) && !over && <span className="turn-flag">to move</span>}
                {!player.connected && <span className="muted"> away</span>}
              </li>
            ))}
          </ul>
          {match.status === 'reconnecting' && (
            <p className="muted">Connection lost — retrying. The board below is the last state we saw.</p>
          )}
        </section>

        {over && (
          <section className="panel compact result">
            <h3>{outcome.winners.includes(match.seat ?? -1) ? 'You win' : outcome.winners.length === 0 ? 'Draw' : 'You lose'}</h3>
            <p className="muted">
              {outcome.reason === 'prestige' && '20+ prestige points.'}
              {outcome.reason === 'crowns' && '10+ crowns.'}
              {outcome.reason === 'color' && '10+ prestige in one colour.'}
              {outcome.reason === 'line' && 'Three in a row.'}
              {outcome.reason === 'draw' && 'No moves left.'}
              {outcome.reason === 'stalled' && 'Stall limit reached (house rule).'}
            </p>
            <button type="button" onClick={onLeave}>
              Back to lobby
            </button>
          </section>
        )}

        {GameSidebar && (
          <GameSidebar
            view={match.view}
            seat={match.seat}
            actors={match.actors}
            pending={match.pending}
            submit={(action) => client.submit(action)}
          />
        )}

        <MoveLog describe={board?.describeEffect} />
      </aside>

      <section className="board-area">
        {match.error && (
          <p className="error banner">
            {match.error.message} <span className="muted">({match.error.code})</span>
          </p>
        )}
        {waiting && (
          <p className="banner">Waiting for your opponent to join. Send them the code.</p>
        )}
        {loadError && <p className="error banner">{loadError}</p>}
        {Board ? (
          <Board
            view={match.view}
            seat={match.seat}
            actors={match.actors}
            pending={match.pending}
            submit={(action) => client.submit(action)}
          />
        ) : (
          !loadError && <p className="muted">Loading board…</p>
        )}
      </section>
    </main>
  );
}

function ShareCode({ code, waiting }: { code: string | null; waiting: boolean }) {
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  if (!code) return null;

  const copy = async (what: 'link' | 'code') => {
    const text = what === 'code' ? code : `${location.origin}/g/${code}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard permission denied; the code is on screen to read out anyway.
    }
  };

  return (
    <section className={`panel compact share ${waiting ? 'share-highlight' : ''}`}>
      <h3>Match code</h3>
      <p className="code-display">{code}</p>
      <div className="row">
        <button type="button" onClick={() => void copy('code')}>
          {copied === 'code' ? 'Copied' : 'Copy code'}
        </button>
        <button type="button" onClick={() => void copy('link')}>
          {copied === 'link' ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </section>
  );
}

/**
 * Effects arrive already redacted for this recipient, so they are safe to render verbatim.
 *
 * A game may supply its own describer to name its cards properly; otherwise the generic fallback
 * below keeps the log useful for a game that has not bothered.
 */
function MoveLog({ describe }: { describe?: EffectDescriber }) {
  const match = useMatch();
  const entries = [...match.log].reverse().slice(0, 40);
  const render = describe ?? describeEffect;

  const canUndo = match.version > 0 && !match.undo && match.players.length === 2;
  return (
    <section className="panel compact log">
      <div className="log-head">
        <h3>Move log</h3>
        <button
          type="button"
          className="mini"
          disabled={!canUndo}
          title={
            canUndo
              ? 'Ask your opponent to agree to take the last move back'
              : 'Undo needs both players here and at least one move played'
          }
          onClick={() => client.requestUndo()}
        >
          Undo
        </button>
      </div>
      {entries.length === 0 && <p className="muted">No moves yet.</p>}
      <ol>
        {entries.map((entry) => (
          <li key={entry.version}>
            <span className={`dot seat-${entry.seat}`} />
            {/* An explicit arrow, not a bare `render`: `map` would otherwise pass the array index
                as the describer's second argument, which is now the acting seat. */}
            <span className="log-text">
              {entry.effects.map((effect) => render(effect, entry.seat)).filter(Boolean).join(' · ') || '—'}
            </span>
            <MoveTime at={entry.at} />
          </li>
        ))}
      </ol>
    </section>
  );
}

/** When one move happened. See `time.ts` for what is shown and why. */
function MoveTime({ at }: { at: number }) {
  if (!isRealTimestamp(at)) return null;
  return (
    <time className="log-at" dateTime={new Date(at).toISOString()} title={fullMoveTime(at)}>
      {moveTimeLabel(at)}
    </time>
  );
}

/**
 * The undo agreement, shown to both players at once.
 *
 * Undo is mutual by design rather than by politeness: in a game with hidden information, taking back
 * a move after seeing what it revealed is a way to cheat, so the player who would be affected is the
 * one who has to say yes. That makes the dialog two-sided — one side is asking, the other deciding —
 * and it is the same dialog either way so that both players are looking at the same words.
 */
function UndoDialog({ describe }: { describe?: EffectDescriber }) {
  const match = useMatch();
  const undo = match.undo;

  // Escape is the same as declining or withdrawing: it ends the proposal rather than hiding it,
  // because a dialog you can dismiss locally would leave the other player waiting on a ghost.
  useEffect(() => {
    if (!undo) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') client.respondUndo(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  if (!undo) return null;

  const render = describe ?? describeEffect;
  const nameOf = (seat: number) => match.players.find((p) => p.seat === seat)?.name ?? `Player ${seat + 1}`;
  const what = undo.effects.map((effect) => render(effect, undo.targetSeat)).filter(Boolean).join(' · ');
  const mine = undo.by === match.seat;
  const other = match.players.find((p) => p.seat !== match.seat);

  return (
    <div className="undo-scrim">
      <div className="undo-dialog" role="dialog" aria-modal="true" aria-label="Undo the last move">
        <div className="undo-body">
          <h4>Undo the last move?</h4>
          <p className="undo-move">
            <span className={`dot seat-${undo.targetSeat}`} /> <strong>{nameOf(undo.targetSeat)}</strong>{' '}
            {what || 'made a move'}
          </p>
          {mine ? (
            <>
              <p className="muted">
                Waiting for {other?.name ?? 'your opponent'} to agree. The move stays as it is unless they do.
              </p>
              <div className="row">
                <button type="button" onClick={() => client.respondUndo(false)}>
                  Withdraw
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">{nameOf(undo.by)} would like to take this back. It happens only if you agree.</p>
              <div className="row">
                <button type="button" onClick={() => client.respondUndo(true)}>
                  Agree
                </button>
                <button type="button" className="mini" onClick={() => client.respondUndo(false)}>
                  Decline
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Game-agnostic fallback. Anything game-specific belongs in that game's own describer. */
function describeEffect(effect: Record<string, unknown>, actorSeat: number): string {
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
