import { normalizeCode } from '@games/protocol';
import { useEffect, useMemo, useState } from 'react';
import { Lobby } from './Lobby.js';
import { redeemSeatFromUrl } from './resumable.js';
import { Replay } from './Replay.js';
import { Room } from './Room.js';
import {
  client,
  codeFromLocation,
  pushHomeUrl,
  pushRoomUrl,
  replayCodeFromLocation,
  useMatch,
} from './store.js';

export function App() {
  const match = useMatch();
  const [route, setRoute] = useState<string>(() => location.pathname);
  const [transferError, setTransferError] = useState<string | null>(null);
  const replayCode = useMemo(() => replayCodeFromLocation(), [route]);

  /*
   * A replay needs no socket at all — it is one HTTP fetch and then the browser runs the rules
   * itself — so on that route we deliberately never connect. Opening a socket would put this tab in
   * the room's presence list and tell the other player somebody had arrived to play.
   */
  useEffect(() => {
    if (replayCodeFromLocation()) {
      const onPopReplay = () => setRoute(location.pathname);
      window.addEventListener('popstate', onPopReplay);
      return () => window.removeEventListener('popstate', onPopReplay);
    }
    const deepLinked = codeFromLocation();
    /*
     * Redeem a transfer link *before* connecting. Arriving at a full match without the seat token in
     * place would be answered with "that match already has both players" -- so the exchange has to
     * finish first, and the fragment is stripped either way so a reload cannot re-spend it.
     */
    void redeemSeatFromUrl().then((result) => {
      if (result.error) setTransferError(result.error);
      client.connect(deepLinked ?? undefined);
    });
    const onPop = () => setRoute(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // A deep link with no stored seat still needs an explicit join once the handshake completes.
  const deepLinked = useMemo(() => codeFromLocation(), [route]);
  useEffect(() => {
    if (replayCode) return;
    if (!deepLinked) return;
    if (match.status !== 'connected') return;
    if (match.confirmed) return;
    client.joinMatch(deepLinked);
  }, [deepLinked, match.status, match.confirmed, replayCode]);

  useEffect(() => {
    if (replayCode) return;
    if (match.code && match.confirmed) pushRoomUrl(match.code);
  }, [match.code, match.confirmed, replayCode]);

  const leave = () => {
    client.close();
    pushHomeUrl();
    location.reload();
  };

  const goHome = () => {
    pushHomeUrl();
    location.reload();
  };

  if (replayCode) {
    return (
      <div className="app">
        <header className="topbar">
          <button className="brand" type="button" onClick={goHome}>
            Games
          </button>
          <span className="badge">Replay</span>
        </header>
        <Replay code={replayCode} onLeave={goHome} />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="brand"
          type="button"
          onClick={() => {
            if (match.confirmed) leave();
          }}
        >
          Games
        </button>
        <ConnectionBadge status={match.status} />
      </header>

      {transferError && (
        <p className="error banner" role="alert">
          {transferError}
        </p>
      )}
      {match.confirmed ? <Room onLeave={leave} /> : <Lobby deepLinkedCode={deepLinked} />}
    </div>
  );
}

function ConnectionBadge({ status }: { status: string }) {
  const label: Record<string, string> = {
    connecting: 'Connecting…',
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    closed: 'Disconnected',
  };
  return <span className={`badge badge-${status}`}>{label[status] ?? status}</span>;
}

export { normalizeCode };
