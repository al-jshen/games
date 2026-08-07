/**
 * Writing training data to disk, and reading it back.
 *
 * The format is deliberately dull: raw little-endian `float32` blobs with a JSON sidecar describing
 * the shapes. `np.fromfile(...).reshape(-1, width)` reads it in one line and needs no library on
 * either side, which is the whole point — this is the seam between a TypeScript game and a PyTorch
 * trainer, and a seam is the wrong place for a dependency.
 *
 * JSONL would be simpler still and is roughly ten times the size and far slower to parse once there
 * are millions of rows, which there will be.
 *
 * Each row is one position a search actually chose from:
 *
 *   x   the encoded view, from the mover's point of view
 *   pi  the search's visit counts over the policy space, normalised
 *   z   how the game turned out for that player: +1, -1, or 0
 *
 * Plus `meta`, three int32s per row — game, move number, seat. That exists so a suspicious row can be
 * looked at: the game index maps to a seed in the sidecar, and the seed and move number are enough to
 * pull the position up in the replay viewer. Without it a bad sample is several hundred anonymous
 * floats and there is no way back to a board.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Written beside the blobs so a reader can check it is reading what it thinks. */
export function sidecarFor({ rows, featureSize, policySize, seeds, featureLayout, policyLayout, config, generatedAt }) {
  return {
    rows,
    featureSize,
    policySize,
    files: {
      x: 'x.f32',
      pi: 'pi.f32',
      z: 'z.f32',
      meta: 'meta.i32',
    },
    meta: ['game', 'move', 'seat'],
    seeds,
    featureLayout,
    policyLayout,
    config,
    generatedAt,
  };
}

export async function writeDataset(
  dir,
  { samples, seeds, featureSize, policySize, featureLayout, policyLayout, config, generatedAt },
) {
  await mkdir(dir, { recursive: true });

  const rows = samples.length;
  const x = new Float32Array(rows * featureSize);
  const pi = new Float32Array(rows * policySize);
  const z = new Float32Array(rows);
  const meta = new Int32Array(rows * 3);

  for (const [i, sample] of samples.entries()) {
    x.set(sample.x, i * featureSize);
    pi.set(sample.pi, i * policySize);
    z[i] = sample.z;
    meta[i * 3] = sample.game;
    meta[i * 3 + 1] = sample.move;
    meta[i * 3 + 2] = sample.seat;
  }

  await Promise.all([
    writeFile(join(dir, 'x.f32'), Buffer.from(x.buffer, x.byteOffset, x.byteLength)),
    writeFile(join(dir, 'pi.f32'), Buffer.from(pi.buffer, pi.byteOffset, pi.byteLength)),
    writeFile(join(dir, 'z.f32'), Buffer.from(z.buffer, z.byteOffset, z.byteLength)),
    writeFile(join(dir, 'meta.i32'), Buffer.from(meta.buffer, meta.byteOffset, meta.byteLength)),
  ]);

  const sidecar = sidecarFor({
    rows,
    featureSize,
    policySize,
    seeds,
    featureLayout,
    policyLayout,
    config,
    generatedAt,
  });
  await writeFile(join(dir, 'dataset.json'), `${JSON.stringify(sidecar, null, 2)}\n`);
  return sidecar;
}

/** Read a dataset back. Used by the tests, and by anything in Node that wants to inspect one. */
export async function readDataset(dir) {
  const sidecar = JSON.parse(await readFile(join(dir, 'dataset.json'), 'utf8'));
  const load = async (name, Kind) => {
    const buf = await readFile(join(dir, name));
    return new Kind(buf.buffer, buf.byteOffset, buf.byteLength / Kind.BYTES_PER_ELEMENT);
  };
  return {
    sidecar,
    x: await load(sidecar.files.x, Float32Array),
    pi: await load(sidecar.files.pi, Float32Array),
    z: await load(sidecar.files.z, Float32Array),
    meta: await load(sidecar.files.meta, Int32Array),
  };
}
