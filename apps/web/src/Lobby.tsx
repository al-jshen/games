import { normalizeCode } from '@games/protocol';
import { CODE_LENGTH } from '@games/protocol';
import { useEffect, useState } from 'react';
import { hasBoard } from './games.js';
import { listResumable, type ResumableMatch } from './resumable.js';
import { client, useMatch } from './store.js';

const NAME_KEY = 'games:name';

export function Lobby({ deepLinkedCode }: { deepLinkedCode: string | null }) {
  const match = useMatch();
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const [code, setCode] = useState(deepLinkedCode ?? '');
  const ready = match.status === 'connected';

  useEffect(() => {
    localStorage.setItem(NAME_KEY, name);
  }, [name]);

  // Games this browser already holds a seat in. Looked up once, without blocking the lobby.
  const [resumable, setResumable] = useState<ResumableMatch[] | null>(null);
  useEffect(() => {
    let live = true;
    void listResumable().then((matches) => {
      if (live) setResumable(matches);
    });
    return () => {
      live = false;
    };
  }, []);

  const create = (gameId: string) => client.createMatch(gameId, name || undefined);

  const join = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeCode(code);
    if (normalized.length !== CODE_LENGTH) return;
    client.joinMatch(normalized, name || undefined);
  };

  return (
    <main className="lobby">
      <section className="panel">
        <h1>Play a board game with a friend</h1>
        <p className="muted">
          Pick a game to get a code, then send that code to whoever you are playing with. They paste
          it below and land in the room with you.
        </p>

        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 32))}
            placeholder="optional"
            autoComplete="nickname"
          />
        </label>
      </section>

      <ResumePanel matches={resumable} games={match.games} />

      <section className="panel">
        <h2>Start a match</h2>
        <div className="game-grid">
          {match.games.length === 0 && <p className="muted">Loading games…</p>}
          {match.games.map((game) => (
            <article key={game.id} className="game-card">
              <h3>{game.title}</h3>
              <p className="muted">{game.blurb}</p>
              <p className="meta">
                {game.minPlayers === game.maxPlayers
                  ? `${game.minPlayers} players`
                  : `${game.minPlayers}–${game.maxPlayers} players`}{' '}
                · {game.estMinutes[0]}–{game.estMinutes[1]} min
              </p>
              <button type="button" disabled={!ready || !hasBoard(game.id)} onClick={() => create(game.id)}>
                {hasBoard(game.id) ? 'Create match' : 'No UI yet'}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Join with a code</h2>
        <form className="join" onSubmit={join}>
          <input
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value).slice(0, CODE_LENGTH))}
            placeholder="ABC234"
            spellCheck={false}
            autoCapitalize="characters"
            className="code-input"
            aria-label="Match code"
          />
          <button type="submit" disabled={!ready || normalizeCode(code).length !== CODE_LENGTH}>
            Join
          </button>
        </form>
        {match.error && (
          <p className="error">
            {match.error.message} <span className="muted">({match.error.code})</span>
          </p>
        )}
      </section>
    </main>
  );
}

/**
 * Matches you are already in. Hidden entirely when there are none, so a first-time visitor sees the
 * lobby they saw before.
 */
function ResumePanel({
  matches,
  games,
}: {
  matches: ResumableMatch[] | null;
  games: { id: string; title: string }[];
}) {
  const unfinished = matches?.filter((m) => m.status !== 'finished') ?? [];
  if (unfinished.length === 0) return null;
  const titleOf = (gameId: string) => games.find((g) => g.id === gameId)?.title ?? gameId;

  return (
    <section className="panel">
      <h2>Your games in progress</h2>
      <p className="muted">
        Still on this browser. Pick one up where you left it — your opponent can do the same from
        theirs, whenever they get to it.
      </p>
      <ul className="resume-list">
        {unfinished.map((m) => (
          <li key={m.code}>
            <a className="resume-item" href={`/g/${m.code}`}>
              <span className="resume-title">{titleOf(m.gameId)}</span>
              <span className="resume-code">{m.code}</span>
              <span className="muted">
                {m.seatsFilled < m.maxSeats
                  ? 'waiting for an opponent'
                  : m.moves === 0
                    ? 'not started'
                    : `${m.moves} move${m.moves === 1 ? '' : 's'} in`}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
