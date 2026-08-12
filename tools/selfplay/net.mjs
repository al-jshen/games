/**
 * Read a checkpoint off disk. The arithmetic lives in `@games/net`.
 *
 * This file used to hold the forward pass as well, and it moved because the browser wants the same
 * one: the bot a player faces in `apps/web` has to be the network the arena measured, not a second
 * implementation of it that happens to agree today. What is left here is the part that genuinely
 * needs a filesystem -- everything above the `readFileSync`.
 *
 * `checkpoint.py` writes a raw little-endian `float32` blob plus a JSON sidecar, and that pairing is
 * the whole format. See `@games/net` for what the sidecar may say and why the weights are widened to
 * `Float64Array` on load.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeNet } from '@games/net';

export { bothOf, forward, policyOf, valueOf } from '@games/net';

/**
 * Which implementation runs the arithmetic.
 *
 * `native` is the loop in `@games/net`. `onnx` hands the model to ONNX Runtime, which is worth
 * knowing about because the two scale completely differently: measured at batch 1, ORT costs ~95us
 * whatever the model is -- 23k parameters and 185k parameters both -- because it is almost entirely
 * per-call overhead. The native loop scales with the arithmetic. So they cross at roughly a 48-wide
 * trunk:
 *
 *     tiny 719->32     native  65us    onnx ~95us     native wins
 *     dual 719->64     native 202us    onnx ~95us     onnx wins 2.1x
 *     dual 719->256    native 800us    onnx ~95us     onnx wins 8.4x
 *
 * **`onnx` cannot currently be used inside the search, and the reason is structural rather than
 * missing plumbing.** `session.run` is asynchronous, while `evaluate` is called from a synchronous
 * recursive `descend`. Using it means making the whole tree walk async, which is a real change to
 * the core of the search rather than a swap of one function. The switch exists so the backends can
 * be compared, and so that whoever needs a trunk wide enough to want ORT finds the decision already
 * measured instead of having to rediscover it.
 *
 * It is also now a reason the native loop earns its keep for a second purpose: ORT in a browser
 * means shipping a WASM runtime to a player who wanted to play a board game.
 */
export const BACKENDS = ['native', 'onnx'];

export function loadNet(directory) {
  const sidecar = JSON.parse(readFileSync(join(directory, 'model.json'), 'utf8'));
  const buf = readFileSync(join(directory, sidecar.file));
  return makeNet(sidecar, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), directory);
}
