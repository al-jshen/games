import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import splendorDuel from '@games/splendor-duel';
import ticTacToe from '@games/tic-tac-toe';
import { App } from './App.js';
import { client } from './store.js';
import './styles.css';

/**
 * Register each game's reducer for client-side prediction.
 *
 * This is the whole reason the game modules are pure isomorphic TypeScript: the browser runs the
 * same rules the server does, so your own move renders immediately instead of after a round trip.
 * Games without an `applyToView` simply wait for the server, which is correct, just slower.
 */
const PREDICTORS = [splendorDuel, ticTacToe];

client.setPredictionAdapter({
  applyToView(view, seat, action) {
    const gameId = client.state.gameId;
    const mod = PREDICTORS.find((m) => m.id === gameId);
    if (!mod?.applyToView) return { ok: false };
    const result = mod.applyToView(view as never, seat, action as never);
    if (!result.ok) return { ok: false };
    return { ok: true, state: result.state, ...(result.unresolved ? { unresolved: true } : {}) };
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
