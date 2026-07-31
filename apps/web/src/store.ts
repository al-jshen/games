import { GameClient, type MatchState } from '@games/client-sdk';
import { useSyncExternalStore } from 'react';

/**
 * A single client instance plus a `useSyncExternalStore` bridge.
 *
 * No Redux or Zustand: the SDK already owns the state machine, and duplicating it into a second
 * store is how the two end up disagreeing. React just subscribes to it.
 */

type Listener = () => void;
const listeners = new Set<Listener>();
let snapshot: MatchState;

export const client = new GameClient({
  onChange: (state) => {
    snapshot = state;
    for (const listener of listeners) listener();
  },
});
snapshot = client.state;

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMatch(): MatchState {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** The last path segment when it looks like a room code, so `/g/ABC234` deep links work. */
export function codeFromLocation(): string | null {
  const match = /^\/g\/([A-Za-z0-9-]+)\/?$/.exec(location.pathname);
  return match?.[1]?.toUpperCase() ?? null;
}

export function pushRoomUrl(code: string): void {
  const next = `/g/${code}`;
  if (location.pathname !== next) history.pushState({}, '', next);
}

export function pushHomeUrl(): void {
  if (location.pathname !== '/') history.pushState({}, '', '/');
}
