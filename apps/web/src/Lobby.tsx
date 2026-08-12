import { normalizeCode } from '@games/protocol';
import { CODE_LENGTH } from '@games/protocol';
import { useEffect, useRef, useState } from 'react';
import { BOT_GAME, BOT_LEVELS, type BotLevelId } from './bot/bot.js';
import { clearPendingBot, pendingBot, setPendingBot } from './bot/seats.js';
import { hasBoard } from './games.js';
import { closeMatch, listResumable, type ResumableMatch } from './resumable.js';
import { client, useMatch } from './store.js';

const NAME_KEY = 'games:name';
const BOT_LEVEL_KEY = 'games:botLevel';

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

  /*
   * Every way into a room that is *not* "play the bot" clears the parked intent first.
   *
   * Otherwise a click that never produced a match -- the server refused, the socket dropped -- leaves
   * an intent behind, and the next room this browser walks into gets a bot seated in it. Which room
   * that is could easily be a friend's.
   */
  const create = (gameId: string) => {
    clearPendingBot();
    client.createMatch(gameId, name || undefined);
  };

  /**
   * Start a match and mark it as one the bot should join.
   *
   * The order matters and cannot be otherwise: the room does not have a code until the server names
   * it, so the intent is parked and `useBot` claims it when the room opens. See `seats.ts`.
   */
  const [level, setLevel] = useState<BotLevelId>(
    () => (localStorage.getItem(BOT_LEVEL_KEY) as BotLevelId | null) ?? 'normal',
  );
  const playBot = (chosen: BotLevelId) => {
    localStorage.setItem(BOT_LEVEL_KEY, chosen);
    // After `create`, which clears any earlier one -- the order matters.
    create(BOT_GAME);
    setPendingBot({ level: chosen });
  };

  /*
   * "Play again" at the end of a bot game navigates here rather than asking for a rematch, and this
   * is the other half of that. A rematch needs two players to agree and re-seats them both; a bot has
   * no opinion to offer and the whole exchange would exist only to preserve a seat token through a
   * page load. Creating a fresh match is the same thing without the ceremony.
   */
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!ready || autoStarted.current) return;
    const pending = pendingBot();
    if (!pending?.autoStart) return;
    autoStarted.current = true;
    clearPendingBot();
    playBot(pending.level);
    // `playBot` re-parks the intent without `autoStart`, which is what `useBot` will claim.
  }, [ready]);

  const join = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeCode(code);
    if (normalized.length !== CODE_LENGTH) return;
    clearPendingBot();
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

      <ResumePanel
        matches={resumable}
        games={match.games}
        onClosed={(code) => setResumable((prev) => (prev ?? []).filter((m) => m.code !== code))}
      />

      <FinishedPanel matches={resumable} games={match.games} />

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
              {game.id === BOT_GAME && hasBoard(game.id) && (
                <BotStarter level={level} onLevel={setLevel} disabled={!ready} onPlay={playBot} />
              )}
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
 * Play on your own, against the network from the self-play loop.
 *
 * On the game's own card rather than in a section of its own, because it is a way to start *this*
 * game and there is exactly one game that has a trained network. A second row here is honest about
 * that; a "Bots" section listing one entry would not be.
 *
 * The level is a `select` and not three buttons because it is a setting rather than three ways to
 * start — and because it is remembered, so the common case is one click on a choice made once.
 */
function BotStarter({
  level,
  onLevel,
  disabled,
  onPlay,
}: {
  level: BotLevelId;
  onLevel: (level: BotLevelId) => void;
  disabled: boolean;
  onPlay: (level: BotLevelId) => void;
}) {
  const chosen = BOT_LEVELS.find((l) => l.id === level) ?? BOT_LEVELS[1];
  return (
    <div className="bot-start">
      <div className="row">
        <button type="button" disabled={disabled} onClick={() => onPlay(level)}>
          Play the bot
        </button>
        <select
          className="bot-level"
          aria-label="Bot difficulty"
          value={level}
          onChange={(e) => onLevel(e.target.value as BotLevelId)}
        >
          {BOT_LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <p className="muted small">{chosen?.blurb}</p>
    </div>
  );
}

/**
 * Matches you are already in. Hidden entirely when there are none, so a first-time visitor sees the
 * lobby they saw before.
 */
function ResumePanel({
  matches,
  games,
  onClosed,
}: {
  matches: ResumableMatch[] | null;
  games: { id: string; title: string }[];
  onClosed: (code: string) => void;
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
          <ResumeEntry key={m.code} match={m} title={titleOf(m.gameId)} onClosed={onClosed} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Games of yours that are over. The seat tokens are still in this browser, and the record is still on
 * the server, so the only thing missing was somewhere to click.
 */
function FinishedPanel({
  matches,
  games,
}: {
  matches: ResumableMatch[] | null;
  games: { id: string; title: string }[];
}) {
  const finished = (matches ?? []).filter((m) => m.status === 'finished').slice(0, 6);
  if (finished.length === 0) return null;
  const titleOf = (gameId: string) => games.find((g) => g.id === gameId)?.title ?? gameId;

  return (
    <section className="panel">
      <h2>Finished games</h2>
      <p className="muted">Step back through one move at a time, from either side of the table.</p>
      <ul className="resume-list">
        {finished.map((m) => (
          <li key={m.code} className="resume-row">
            <a className="resume-item" href={`/r/${m.code}`}>
              <span className="resume-title">{titleOf(m.gameId)}</span>
              <span className="resume-code">{m.code}</span>
              <span className="muted">
                {m.moves} move{m.moves === 1 ? '' : 's'}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One game you can go back to, and a way to be done with it.
 *
 * Closing asks first. It cannot be undone and it does not only affect the person clicking: the match
 * ends for the opponent too, wherever they are, so a stray click on a row you meant to open should
 * not be able to do it.
 */
function ResumeEntry({
  match,
  title,
  onClosed,
}: {
  match: ResumableMatch;
  title: string;
  onClosed: (code: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = async () => {
    setBusy(true);
    setError(null);
    const result = await closeMatch(match.code);
    if (result.ok) {
      onClosed(match.code);
      return;
    }
    setBusy(false);
    setConfirming(false);
    setError(result.message ?? 'Could not close that match.');
  };

  return (
    <li className="resume-row">
      <a className="resume-item" href={`/g/${match.code}`}>
        <span className="resume-title">{title}</span>
        <span className="resume-code">{match.code}</span>
        <span className="muted">
          {match.seatsFilled < match.maxSeats
            ? 'waiting for an opponent'
            : match.moves === 0
              ? 'not started'
              : `${match.moves} move${match.moves === 1 ? '' : 's'} in`}
        </span>
      </a>

      {confirming ? (
        <span className="resume-confirm">
          <span className="muted small">Close for both players?</span>
          <button type="button" className="mini" disabled={busy} onClick={() => void close()}>
            {busy ? 'Closing…' : 'Close it'}
          </button>
          <button type="button" className="mini" disabled={busy} onClick={() => setConfirming(false)}>
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="mini"
          aria-label={`Close the ${title} match ${match.code}`}
          title="End this match for both players and remove it from this list"
          onClick={() => setConfirming(true)}
        >
          Close
        </button>
      )}
      {error && <span className="error small">{error}</span>}
    </li>
  );
}
