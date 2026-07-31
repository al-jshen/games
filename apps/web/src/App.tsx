import { normalizeCode } from '@games/protocol';
import { useEffect, useMemo, useState } from 'react';
import { Lobby } from './Lobby.js';
import { Room } from './Room.js';
import { client, codeFromLocation, pushHomeUrl, pushRoomUrl, useMatch } from './store.js';

export function App() {
  const match = useMatch();
  const [route, setRoute] = useState<string>(() => location.pathname);

  // Connect once on mount, resuming a seat if this browser already holds one for the code in the URL.
  useEffect(() => {
    const deepLinked = codeFromLocation();
    client.connect(deepLinked ?? undefined);
    const onPop = () => setRoute(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // A deep link with no stored seat still needs an explicit join once the handshake completes.
  const deepLinked = useMemo(() => codeFromLocation(), [route]);
  useEffect(() => {
    if (!deepLinked) return;
    if (match.status !== 'connected') return;
    if (match.confirmed) return;
    client.joinMatch(deepLinked);
  }, [deepLinked, match.status, match.confirmed]);

  useEffect(() => {
    if (match.code && match.confirmed) pushRoomUrl(match.code);
  }, [match.code, match.confirmed]);

  const leave = () => {
    client.close();
    pushHomeUrl();
    location.reload();
  };

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
