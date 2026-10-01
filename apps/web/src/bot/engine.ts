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

import { search, type SearchResult } from '@games/bot-ismcts';
import { netDeps, operatingPoint, type SplendorSearchDeps } from '@games/bot-splendor-duel';
import { fetchNet, type Net } from '@games/net';
import type { SplendorAction, SplendorView } from '@games/splendor-duel';

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

/** One search from a redacted view, exactly as the arena runs it. */
export function think(
  engine: Engine,
  view: SplendorView,
  seat: number,
  iterations: number,
  seed: string,
): SearchResult<SplendorAction> {
  return search(engine.deps, view, seat, operatingPoint(iterations, seed));
}
