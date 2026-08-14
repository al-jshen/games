import { useEffect, useRef, useState } from 'react';
import { BOT_BASE, BOT_GAME, DEFAULT_ITERATIONS, describeStrength, type BotManifest } from './bot/bot.js';
import { Coach } from './bot/Coach.js';
import { setPendingBot } from './bot/seats.js';
import { isBotMatch, useBot, type BotStatus } from './bot/useBot.js';
import { useCoach } from './bot/useCoach.js';
import { loadBoard, type BoardModule, type EffectDescriber } from './games.js';
import { describeEffect } from './effects.js';
import { seatTransferLink } from './resumable.js';
import { fullMoveTime, isRealTimestamp, moveTimeLabel } from './time.js';
import { client, useMatch } from './store.js';

export function Room({ onLeave }: { onLeave: () => void }) {
  const match = useMatch();
  const bot = useBot(match.code, match.gameId);
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
  const bothHere = match.players.length === 2 && match.players.every((p) => p.connected);
  const yourTurn = match.seat !== null && match.actors.includes(match.seat);

  /*
   * Offered in games between people, and not against the bot. Playing the bot's own network for
   * advice on how to beat it is not analysis, it is the bot playing both sides — and a panel telling
   * you the move your opponent is about to make would empty the game out.
   */
  const coachable = match.gameId === BOT_GAME && !bot.active && !isBotMatch(match.code);
  const coach = useCoach(
    {
      // The server's confirmed position, not `match.view` -- that carries an unacknowledged local
      // move, and evaluating a position the server has not agreed to yet would be reading a board
      // that may be about to snap back.
      view: match.confirmed?.view ?? null,
      seat: match.seat,
      yourTurn,
      version: match.version,
      over,
    },
    coachable,
  );

  /*
   * The rematch arrives as a seat token, already stored. Navigating is what enters it — a full load
   * rather than a state swap, so nothing from the finished match can linger in a board that is now
   * showing a different one.
   */
  useEffect(() => {
    if (match.rematch) location.assign(`/g/${match.rematch.code}`);
  }, [match.rematch]);

  return (
    <main className="room">
      <UndoDialog describe={board?.describeEffect} />

      <aside className="sidebar">
        {bot.active ? <BotPanel bot={bot} /> : <ShareCode code={match.code} waiting={waiting} />}

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
                {match.actors.includes(player.seat) && !over && (
                  <span className="turn-flag">
                    {bot.thinking && !player.you ? 'thinking' : 'to move'}
                  </span>
                )}
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
            <div className="row">
              {bot.active ? (
                /*
                 * A fresh match rather than a rematch, deliberately. A rematch is an agreement
                 * between two people that re-seats them both in a new room; the bot has no opinion
                 * to offer and the only thing the exchange would achieve is carrying its seat token
                 * through a page load. This asks the lobby to start another one, at the same level.
                 */
                <button
                  type="button"
                  onClick={() => {
                    setPendingBot({ iterations: bot.iterations ?? DEFAULT_ITERATIONS, autoStart: true });
                    onLeave();
                  }}
                >
                  Play again
                </button>
              ) : (
                <button type="button" onClick={() => client.requestRematch()} disabled={!bothHere}>
                  Rematch
                </button>
              )}
              <button type="button" className="mini" onClick={onLeave}>
                Back to lobby
              </button>
              {match.code && (
                <a className="mini button-like" href={`/r/${match.code}`}>
                  Review the game
                </a>
              )}
            </div>
            {!bothHere && !bot.active && (
              <p className="muted small">
                A rematch needs your opponent here — it seats you both, so there is no code to send.
              </p>
            )}
          </section>
        )}

        {coachable && !over && <Coach coach={coach} yourTurn={yourTurn} />}

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
        <ChatPanel />
      </aside>

      <section className="board-area">
        {match.error && (
          <p className="error banner">
            {match.error.message} <span className="muted">({match.error.code})</span>
          </p>
        )}
        {bot.error && <p className="error banner">{bot.error}</p>}
        {waiting &&
          (bot.active ? (
            <p className="banner">
              {bot.ready ? 'Seating the bot…' : 'Loading the bot’s network…'}
            </p>
          ) : (
            <p className="banner">Waiting for your opponent to join. Send them the code.</p>
          ))}
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

/**
 * Who you are playing, and what it is doing right now.
 *
 * Sits where the match code sits in a game between people, because it answers the same question and
 * the code answers nothing here — there is nobody to send it to. What it does show is provenance:
 * this opponent is a specific trained generation with measured results, and `bot.json` is where
 * those numbers come from rather than a sentence somebody wrote in a component.
 */
function BotPanel({ bot }: { bot: BotStatus }) {
  const [manifest, setManifest] = useState<BotManifest | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`${BOT_BASE}/bot.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: BotManifest | null) => {
        if (live) setManifest(body);
      })
      .catch(() => {
        // Provenance is a nicety; the bot plays perfectly well without a paragraph about itself.
      });
    return () => {
      live = false;
    };
  }, []);

  const beatsHeuristic = manifest?.measured?.baseline?.heuristic;
  return (
    <section className="panel compact bot-panel">
      <h3>Playing the bot</h3>
      <p className="bot-line">
        <strong>{(bot.iterations ?? 0).toLocaleString()} simulations a move</strong>
        {bot.iterations !== null && (
          <span className="muted"> · {describeStrength(bot.iterations).split(' — ')[0]}</span>
        )}
      </p>
      <p className={`bot-status ${bot.thinking ? 'on' : ''}`}>
        {bot.error ? 'Stopped' : bot.thinking ? 'Thinking…' : bot.ready ? 'Waiting for your move' : 'Loading…'}
      </p>
      {manifest && (
        <p className="muted small">
          Generation {manifest.generation} of the self-play loop
          {beatsHeuristic === undefined
            ? '.'
            : `, which beat the hand-written search ${Math.round(beatsHeuristic * 100)}% of the time.`}{' '}
          It runs in this browser and sees only what you would see from its seat.
        </p>
      )}
      <p className="muted small">You move first — the bot takes the second seat.</p>
    </section>
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
      <SeatTransfer code={code} />
    </section>
  );
}

/**
 * Carry this seat to another device.
 *
 * Your seat lives in this browser's storage, which is why the games list only ever knows about this
 * browser. This hands over a link that puts the same seat on your phone — and it is a real credential
 * for the length of its life, so it says so, and it expires in minutes rather than never.
 */
function SeatTransfer({ code }: { code: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const request = async () => {
    setBusy(true);
    setError(null);
    const result = await seatTransferLink(code);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setLink(result.link);
    try {
      await navigator.clipboard.writeText(result.link);
      setCopied(true);
    } catch {
      // Denied; the link is on screen to copy by hand.
    }
  };

  if (!link) {
    return (
      <div className="seat-transfer">
        <button type="button" className="mini" disabled={busy} onClick={() => void request()}>
          {busy ? 'Preparing…' : 'Play on another device'}
        </button>
        {error && <p className="error small">{error}</p>}
      </div>
    );
  }

  return (
    <div className="seat-transfer">
      <p className="muted small">
        {copied ? 'Link copied. ' : ''}Open this on your other device within 10 minutes. Anyone who has
        it can play as you until then.
      </p>
      <input className="seat-link" readOnly value={link} aria-label="Seat transfer link" onFocus={(e) => e.target.select()} />
      <button type="button" className="mini" onClick={() => setLink(null)}>
        Done
      </button>
    </div>
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
 * Table talk.
 *
 * Deliberately plain: a bounded scrolling list and one line of input. It sits in the sidebar's fixed
 * furniture rather than growing with its contents, because the turn guide above it takes the spare
 * height and a panel that grew as people talked would resize the board mid-game.
 */
function ChatPanel() {
  const match = useMatch();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const seated = match.seat !== null;

  // Follow the conversation as it arrives. Only on a new message, so it does not fight a player who
  // has scrolled up to re-read something.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [match.chat.length]);

  const send = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    client.say(draft);
    setDraft('');
  };

  return (
    <section className="panel compact chat">
      <h3>Chat</h3>
      <ol className="chat-list" ref={listRef}>
        {match.chat.length === 0 && <li className="muted">Say hello.</li>}
        {match.chat.map((message) => (
          <li key={message.id}>
            <span className={`dot seat-${message.seat}`} />
            <span className="chat-who">{message.seat === match.seat ? 'You' : message.name}</span>
            <span className="chat-text">{message.text}</span>
            <time className="chat-at" dateTime={new Date(message.at).toISOString()} title={fullMoveTime(message.at)}>
              {moveTimeLabel(message.at, undefined, false)}
            </time>
          </li>
        ))}
      </ol>
      <form className="chat-form" onSubmit={send}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, 500))}
          placeholder={seated ? 'Message' : 'Join a match to chat'}
          aria-label="Chat message"
          disabled={!seated}
          autoComplete="off"
        />
        <button type="submit" className="mini" disabled={!seated || draft.trim().length === 0}>
          Send
        </button>
      </form>
    </section>
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

