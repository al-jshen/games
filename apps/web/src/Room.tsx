import { useEffect, useState } from 'react';
import { loadBoard, type BoardModule } from './games.js';
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
function MoveLog({ describe }: { describe?: (effect: Record<string, unknown>) => string }) {
  const match = useMatch();
  const entries = [...match.log].reverse().slice(0, 40);
  const render = describe ?? describeEffect;
  if (entries.length === 0) return null;

  return (
    <section className="panel compact log">
      <h3>Move log</h3>
      <ol>
        {entries.map((entry) => (
          <li key={entry.version}>
            <span className={`dot seat-${entry.seat}`} />
            <span>{entry.effects.map(render).filter(Boolean).join(' · ') || '—'}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Game-agnostic fallback. Anything game-specific belongs in that game's own describer. */
function describeEffect(effect: Record<string, unknown>): string {
  const k = String(effect.k);
  switch (k) {
    case 'tookTokens':
      return `took ${(effect.colors as string[]).join(', ')}`;
    case 'privilegeUsed':
      return `spent a privilege for ${String(effect.color)}`;
    case 'replenished':
      return `replenished ${(effect.placed as unknown[]).length} token(s)`;
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
    case 'privilegeGranted':
      return effect.from === 'none' ? '' : 'gained a privilege';
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
