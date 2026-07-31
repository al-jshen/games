import type { AnyGameModule } from '@games/engine';
import { splendorDuel } from '@games/splendor-duel';
import { ticTacToe } from '@games/tic-tac-toe';

/**
 * The one place the platform learns that a game exists.
 *
 * Adding a game is: create `packages/games/<id>/`, add a line here, and add a line to the web
 * app's lazy board map. Deliberately a static list rather than a dynamic plugin loader — for a
 * self-hosted platform that machinery is pure cost, and a static import means the type checker and
 * the bundler both see every game.
 */
const MODULES: AnyGameModule[] = [splendorDuel, ticTacToe];

export const registry = new Map<string, AnyGameModule>(MODULES.map((m) => [m.id, m]));

export function getGame(id: string): AnyGameModule | undefined {
  return registry.get(id);
}

export function gameCatalog() {
  return MODULES.map((m) => ({
    id: m.id,
    title: m.meta.title,
    blurb: m.meta.blurb,
    minPlayers: m.meta.minPlayers,
    maxPlayers: m.meta.maxPlayers,
    estMinutes: m.meta.estMinutes,
  }));
}
