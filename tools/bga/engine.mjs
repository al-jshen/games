/**
 * The published network and the search around it, for a caller that has a view and wants a move.
 *
 * Deliberately thin. The checkpoint is the one `apps/web/public` ships, read with the loader
 * self-play already has; the search settings are `operatingPoint`, shared with the browser. So the
 * agent sitting at a BGA table is the agent that was measured, and nothing here can make it a
 * different one by accident.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { search } from '@games/bot-ismcts';
import { netDeps, operatingPoint } from '@games/bot-splendor-duel';
import { loadNet } from '../selfplay/net.mjs';

export function loadPublished(base) {
  const manifest = JSON.parse(readFileSync(join(base, 'bot.json'), 'utf8'));
  const value = loadNet(join(base, manifest.value.dir));
  const policy = loadNet(join(base, manifest.policy.dir));
  return { id: manifest.id, generation: manifest.generation, deps: netDeps(value, policy) };
}

/**
 * One search per decision, and the search's favourite every time.
 *
 * The web client samples its first few moves from the visit counts so that a person does not watch
 * it open identically every game. This does not: the point here is to measure the agent, the deal
 * already makes every game different, and a sampled opening is a small handicap that would end up
 * in the number.
 *
 * The view is cloned because the search hands it to `determinize` once per iteration, and sharing
 * one object across a tree walk is the kind of aliasing that produces a bug nobody can reproduce.
 */
export function makeBrain(engine, iterations, seed) {
  return (view, seat, move) => {
    const result = search(engine.deps, structuredClone(view), seat, operatingPoint(iterations, `${seed}:${move}`));
    return { action: result.action, value: result.rootValue };
  };
}
