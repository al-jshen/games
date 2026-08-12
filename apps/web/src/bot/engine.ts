/**
 * The network and the search, loaded in a worker.
 *
 * Shared by the two workers that want them: `play.worker.ts`, which sits in a seat and plays, and
 * `analysis.worker.ts`, which sits in no seat and only reports. Both run the identical search on the
 * identical checkpoints -- an evaluation that disagreed with the opponent you are facing would be
 * worse than no evaluation.
 *
 * Neither of these may run on the main thread. A search is a synchronous tree walk with a matrix
 * multiply at every leaf, and at `hard` that is most of a second with no yield in it; on the main
 * thread the board would freeze, the animations would stall and the browser would offer to kill the
 * tab. So the network never enters the main bundle at all: the 3MB of policy weights are fetched by
 * a worker, in a worker, and the page above it stays a page.
 */

import { search, withConfig, type SearchResult } from '@games/bot-ismcts';
import { netDeps, type SplendorSearchDeps } from '@games/bot-splendor-duel';
import { fetchNet, valueOf, type Net } from '@games/net';
import { encodeView, type SplendorAction, type SplendorView } from '@games/splendor-duel';

export interface Engine {
  value: Net;
  policy: Net;
  deps: SplendorSearchDeps;
}

/**
 * Fetch both heads and wire up the search.
 *
 * In parallel, because they are independent and the policy head is thirty times the size of the
 * value head -- serialising them would put a 90KB round trip in front of a 3MB one for no reason.
 */
export async function loadEngine(base: string): Promise<Engine> {
  const [value, policy] = await Promise.all([fetchNet(`${base}/value`), fetchNet(`${base}/policy`)]);
  return { value, policy, deps: netDeps(value, policy) };
}

/**
 * The search's operating point, which is deliberately not a choice made here.
 *
 * Every one of these is copied from `tools/selfplay/loop.yaml`, and the reason to copy rather than
 * to tune is that the numbers attached to this network -- 93% against the heuristic search, the
 * +182 elo for full-depth priors -- were all measured with exactly these settings. A browser that
 * quietly ran `puctDepth: 0` because it seemed cheaper would be shipping a different and weaker
 * agent under the same name.
 *
 * `iterations` is the one thing a caller varies, and it is the one thing the difficulty levels are.
 */
export function config(iterations: number, seed: string) {
  return withConfig({
    iterations,
    seed,
    leaf: 'evaluate',
    selection: 'puct',
    puctExploration: 4,
    puctDepth: 99,
    normaliseValues: true,
  });
}

/** One search from a redacted view, exactly as the arena runs it. */
export function think(
  engine: Engine,
  view: SplendorView,
  seat: number,
  iterations: number,
  seed: string,
): SearchResult<SplendorAction> {
  return search(engine.deps, view, seat, config(iterations, seed));
}

/**
 * The value head's own opinion of a position, with no search around it.
 *
 * Worth having next to the search's estimate rather than instead of it. This is one forward pass on
 * the position as it stands -- instant, and exactly what the network thinks before any reading. The
 * search's `rootValue` is that same head averaged over a few hundred lines, so the two disagreeing
 * is informative: it means the position plays differently from how it looks.
 */
export function staticValue(engine: Engine, view: SplendorView, seat: number): number {
  return valueOf(engine.value, encodeView(view, seat as 0 | 1));
}
