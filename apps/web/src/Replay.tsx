import { replayFrames, type MatchRecord, type ReplayFrame } from '@games/engine';
import { useEffect, useMemo, useState } from 'react';
import { describeEffect } from './effects.js';
import { gameRules, loadBoard, type BoardModule } from './games.js';
import { fullMoveTime, moveTimeLabel } from './time.js';

/**
 * Step back through a finished match.
 *
 * Nothing is streamed and nothing is stored per position: the server hands over the record — a seed
 * and a list of actions — and the browser rebuilds every board in between by running the same rules
 * the server ran. That is the whole payoff of keeping the game modules pure and isomorphic. A
 * hundred-move game is a couple of kilobytes over the wire.
 *
 * The board is shown from one seat's point of view rather than with everything revealed, because
 * `redactFor` is the only path from a state to something a board can render, and it takes a viewer.
 * That turns out to be the more useful thing anyway: reviewing a game, what you want to know is what
 * you could see at the time. Switch seats to see it from the other side.
 */

/**
 * What `/replay` actually serves: the record without the chat, and with seat identities reduced to
 * names. Typing it separately rather than reusing `MatchRecord` keeps the difference honest — a cast
 * would claim a `playerId` is there when the server deliberately withheld it.
 */
type ReplayRecord = Omit<MatchRecord, 'players' | 'chat'> & {
  players?: { seat: number; name: string }[];
};

interface Loaded {
  record: ReplayRecord;
  frames: ReplayFrame<unknown>[];
  board: BoardModule;
}

export function Replay({ code, onLeave }: { code: string; onLeave: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [seat, setSeat] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/matches/${code}/replay`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(body.message ?? `The server answered ${res.status}.`);
        }
        const record = (await res.json()) as ReplayRecord;
        const rules = gameRules(record.gameId);
        if (!rules) throw new Error(`This build has no rules for "${record.gameId}".`);
        const board = await loadBoard(record.gameId);
        const frames = replayFrames(rules, record as MatchRecord) as ReplayFrame<unknown>[];
        if (!live) return;
        setLoaded({ record, frames, board });
        // Open at the end: the result is the thing you came to look at.
        setIndex(frames.length - 1);
      } catch (err) {
        if (live) setError((err as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [code]);

  // Arrow keys, because stepping a move at a time is the whole interaction.
  useEffect(() => {
    const total = loaded?.frames.length ?? 0;
    if (total === 0) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      else if (event.key === 'ArrowRight') setIndex((i) => Math.min(total - 1, i + 1));
      else if (event.key === 'Home') setIndex(0);
      else if (event.key === 'End') setIndex(total - 1);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loaded?.frames.length]);

  /*
   * Above the early returns on purpose: a hook after a conditional `return` is called on some renders
   * and not others, which React rejects outright. Redacting is not free on a large state, so it is
   * memoised on the position and the viewer rather than run on every keystroke of the scrubber.
   */
  const view = useMemo(() => {
    if (!loaded) return null;
    const rules = gameRules(loaded.record.gameId);
    const frame = loaded.frames[index];
    if (!rules || !frame) return null;
    return rules.redactFor(seat, frame.state as never) as unknown;
  }, [loaded, index, seat]);

  if (error) {
    return (
      <main className="lobby">
        <section className="panel">
          <h1>Nothing to replay</h1>
          <p className="error">{error}</p>
          <p className="muted">Replays are kept for matches that were played to a finish.</p>
          <button type="button" onClick={onLeave}>
            Back to lobby
          </button>
        </section>
      </main>
    );
  }

  if (!loaded) {
    return (
      <main className="lobby">
        <section className="panel">
          <p className="muted">Rebuilding the game…</p>
        </section>
      </main>
    );
  }

  const { record, frames, board } = loaded;
  const Board = board.default;
  const describe = board.describeEffect;
  const frame = frames[index]!;
  const last = frames.length - 1;
  const names = record.players?.length
    ? [...record.players].sort((a, b) => a.seat - b.seat).map((p) => p.name)
    : record.seats.map((s) => `Player ${s + 1}`);

  const summary = frame.effects.map((effect) => renderEffect(effect, frame.seat ?? 0, describe)).filter(Boolean);

  return (
    <main className="room replay">
      <aside className="sidebar">
        <section className="panel compact">
          <h3>Replay</h3>
          <p className="code-display">{code}</p>
          <p className="muted small">
            {names.join(' vs ')}
            {record.finishedAt ? ` · ${fullMoveTime(record.finishedAt)}` : ''}
          </p>
          <button type="button" onClick={onLeave}>
            Back to lobby
          </button>
        </section>

        <section className="panel compact">
          <h3>Seen from</h3>
          <div className="row">
            {names.map((name, s) => (
              <button
                key={name + String(s)}
                type="button"
                className={`mini ${seat === s ? 'active' : ''}`}
                onClick={() => setSeat(s)}
              >
                {name}
              </button>
            ))}
          </div>
          <p className="muted small">
            Hidden cards stay hidden, exactly as they were for that player at the time.
          </p>
        </section>

        <section className="panel compact log">
          <div className="log-head">
            <h3>Moves</h3>
            <span className="muted small">
              {index} / {last}
            </span>
          </div>
          <ol>
            {frames
              .map((f, i) => ({ f, i }))
              .filter(({ i }) => i > 0)
              .reverse()
              .slice(0, 60)
              .map(({ f, i }) => (
                <li key={f.version}>
                  <button
                    type="button"
                    className={`replay-jump ${i === index ? 'active' : ''}`}
                    onClick={() => setIndex(i)}
                  >
                    <span className={`dot seat-${f.seat ?? 0}`} />
                    <span className="log-text">
                      {f.effects.map((e) => renderEffect(e, f.seat ?? 0, describe)).filter(Boolean).join(' · ') || '—'}
                    </span>
                    {f.at !== undefined && <span className="log-at">{moveTimeLabel(f.at)}</span>}
                  </button>
                </li>
              ))}
          </ol>
        </section>
      </aside>

      <section className="board-area">
        <div className="replay-bar">
          <button type="button" className="mini" disabled={index === 0} onClick={() => setIndex(0)} aria-label="First move">
            ⏮
          </button>
          <button
            type="button"
            className="mini"
            disabled={index === 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            aria-label="Previous move"
          >
            ◀
          </button>
          <input
            type="range"
            min={0}
            max={last}
            value={index}
            onChange={(event) => setIndex(Number(event.target.value))}
            aria-label="Move"
          />
          <button
            type="button"
            className="mini"
            disabled={index === last}
            onClick={() => setIndex((i) => Math.min(last, i + 1))}
            aria-label="Next move"
          >
            ▶
          </button>
          <button
            type="button"
            className="mini"
            disabled={index === last}
            onClick={() => setIndex(last)}
            aria-label="Last move"
          >
            ⏭
          </button>
          <span className="muted small replay-caption">
            {index === 0 ? 'Opening position' : summary.join(' · ') || `Move ${index}`}
          </span>
        </div>

        {/*
          The board is read-only here: no seat is acting, `actors` is empty and `submit` does nothing,
          so every affordance the board derives from the legal-move list disappears on its own.
        */}
        <Board view={view} seat={seat} actors={[]} submit={() => undefined} pending={false} readOnly />
      </section>
    </main>
  );
}

/** The game's own words when it has them, the platform's when it does not. */
function renderEffect(effect: unknown, actorSeat: number, describe: BoardModule['describeEffect']): string {
  return (describe ?? describeEffect)(effect as Record<string, unknown>, actorSeat);
}
