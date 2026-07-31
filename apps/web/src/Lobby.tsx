import { normalizeCode } from '@games/protocol';
import { CODE_LENGTH } from '@games/protocol';
import { useEffect, useState } from 'react';
import { hasBoard } from './games.js';
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
