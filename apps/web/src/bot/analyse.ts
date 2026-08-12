/**
 * What the coach actually computes. Separated from its worker for the same reason `player.ts` is:
 * so it can be run, and tested, without a browser.
 *
 * **It only ever sees one seat's view.** A coach that searched from the server's truth would be
 * telling you what is in the deck, and the fact that it cannot is not a restriction imposed on it --
 * `encodeView` and `determinize` take a view because that is the only thing a seated player has. So
 * its advice is bounded by the same uncertainty yours is, and its evaluation is an honest answer to
 * "how does this look from here" rather than to "who is actually winning".
 */

import { policyRanking, netValue } from '@games/bot-splendor-duel';
import { describeAction, legalActionsFromView, type SplendorAction, type SplendorView } from '@games/splendor-duel';
import type { CoachMove } from './bot.js';
import { think, type Engine } from './engine.js';

export interface Request {
  view: SplendorView;
  seat: number;
  /**
   * Whether to suggest moves at all.
   *
   * The evaluation is wanted on both turns -- you can see the board, so what the network makes of it
   * is fair game. A list of moves on your opponent's turn would be a list of *their* best replies,
   * which is a different thing entirely and not yours to read.
   */
  yourTurn: boolean;
  iterations: number;
  seed: string;
}

export interface Reading {
  /** The value head alone, in [-1, 1] from `seat`'s point of view. One forward pass, no search. */
  staticValue: number;
  /** The same head averaged over the search tree. Better, and slower. */
  searchValue: number;
  /** Best first, at most four. Empty when it is not your turn. */
  moves: CoachMove[];
  /** The policy head's own favourite, before any search. Null when it is not your turn. */
  instinct: string | null;
  ms: number;
}

export function analyse(engine: Engine, request: Request): Reading {
  const started = Date.now();
  const staticValue = netValue(engine.value, request.view, request.seat);
  const result = think(engine, request.view, request.seat, request.iterations, request.seed);

  let moves: CoachMove[] = [];
  let instinct: string | null = null;
  if (request.yourTurn) {
    const { actions } = legalActionsFromView(request.view, request.seat);
    const ranked = policyRanking(engine.policy, request.view, request.seat, actions);
    const priors = new Map(ranked.map((entry) => [key(entry.action), entry.prior]));

    // The policy's own favourite, over *moves* rather than over actions -- summed the same way the
    // list below is, so a move split across three indistinguishable actions is not beaten by a
    // single one the network likes less.
    const byText = new Map<string, number>();
    for (const entry of ranked) {
      const text = describeAction(entry.action, request.view);
      byText.set(text, (byText.get(text) ?? 0) + entry.prior);
    }
    instinct = [...byText.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    /*
     * Visit *share*, not raw counts: the number of iterations is a setting, and a reader comparing
     * "62%" against "18%" is asking the right question where "93 visits" invites the wrong one.
     *
     * Merged by description, and this is not cosmetic. Several distinct actions can read the same
     * way on purpose -- which gold token you take when reserving, which of two equal payments you
     * make -- because the difference is immaterial and `describeAction` declines to name it. Listed
     * separately they appear as two identical recommendations at 25% and 5%, which reads as a bug
     * and understates a move the search actually likes. It is the same collapsing the policy head's
     * slots already do, arrived at from the other end.
     */
    const total = result.ranking.reduce((sum, entry) => sum + entry.visits, 0) || 1;
    const merged = new Map<string, CoachMove & { weight: number }>();
    for (const entry of result.ranking) {
      const text = describeAction(entry.action, request.view);
      const prior = priors.get(key(entry.action)) ?? 0;
      const seen = merged.get(text);
      if (seen) {
        seen.visits += entry.visits / total;
        seen.prior += prior;
        // Visit-weighted, so the line the search actually explored decides what the move is worth.
        seen.value = (seen.value * seen.weight + entry.value * entry.visits) / (seen.weight + entry.visits || 1);
        seen.weight += entry.visits;
      } else {
        merged.set(text, { text, visits: entry.visits / total, prior, value: entry.value, weight: entry.visits });
      }
    }
    moves = [...merged.values()]
      .sort((a, b) => b.visits - a.visits)
      .slice(0, 4)
      .map(({ text, visits, prior, value }) => ({ text, visits, prior, value }));
  }

  return { staticValue, searchValue: result.rootValue, moves, instinct, ms: Date.now() - started };
}

/** Actions are plain JSON by the engine's contract, so this is a sound identity. The search's own. */
function key(action: SplendorAction): string {
  return JSON.stringify(action);
}
