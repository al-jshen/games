import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { netDeps } from '@games/bot-splendor-duel';
import { makeNet, type Sidecar } from '@games/net';
import type { Engine } from '../src/bot/engine.js';

/**
 * The checkpoints `apps/web/public` actually ships, read off disk instead of over HTTP.
 *
 * Same bytes and the same `makeNet`, so a bad publish is caught by a test rather than by a player
 * watching a blank sidebar. `loadEngine` differs from this only in where the two files come from.
 */
export const PUBLISHED = fileURLToPath(new URL('../public/bots/splendor-duel/gen3', import.meta.url));

export function publishedEngine(): Engine {
  const head = (name: string) => {
    const sidecar = JSON.parse(readFileSync(`${PUBLISHED}/${name}/model.json`, 'utf8')) as Sidecar;
    const buf = readFileSync(`${PUBLISHED}/${name}/${sidecar.file}`);
    return makeNet(sidecar, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), name);
  };
  const value = head('value');
  const policy = head('policy');
  return { value, policy, deps: netDeps(value, policy) };
}
