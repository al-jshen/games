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
 *   q   what the *search* concluded about the position -- unlike `z`, this varies row by row
 *   h   what the hand-written heuristic thought at the time, so a learned value has a baseline
 *
 * Plus `meta`, three int32s per row — game, move number, seat. That exists so a suspicious row can be
 * looked at: the game index maps to a seed in the sidecar, and the seed and move number are enough to
 * pull the position up in the replay viewer. Without it a bad sample is several hundred anonymous
 * floats and there is no way back to a board.
 */

import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Written beside the blobs so a reader can check it is reading what it thinks.
 *
 * `seeds` is the *plan* -- every seed the run intends to play, known before a single game starts --
 * while `rows` and `games` are what actually reached the disk. Keeping the two apart matters: a run
 * that dies in its first second still has a full-length `seeds`, so anything that measures progress
 * by `seeds.length` reads a crashed run as a finished one.
 */
export function sidecarFor({ rows, games, featureSize, policySize, seeds, featureLayout, policyLayout, config, generatedAt }) {
  return {
    rows,
    // Games whose rows are on disk, as against `seeds.length` games asked for.
    games,
    featureSize,
    policySize,
    files: {
      x: 'x.f32',
      pi: 'pi.f32',
      z: 'z.f32',
      q: 'q.f32',
      h: 'h.f32',
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

/** Pack rows into the six blobs, column by column. The one place that knows the row layout. */
function pack(samples, featureSize, policySize) {
  const rows = samples.length;
  const x = new Float32Array(rows * featureSize);
  const pi = new Float32Array(rows * policySize);
  const z = new Float32Array(rows);
  const q = new Float32Array(rows);
  const h = new Float32Array(rows);
  const meta = new Int32Array(rows * 3);

  for (const [i, sample] of samples.entries()) {
    x.set(sample.x, i * featureSize);
    pi.set(sample.pi, i * policySize);
    z[i] = sample.z;
    q[i] = sample.q ?? 0;
    h[i] = sample.h ?? 0;
    meta[i * 3] = sample.game;
    meta[i * 3 + 1] = sample.move;
    meta[i * 3 + 2] = sample.seat;
  }
  return { x, pi, z, q, h, meta };
}

const bytes = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);

/**
 * A dataset written incrementally, as games finish, rather than all at once at the end.
 *
 * Generation runs for hours and the obvious shape -- accumulate every row, write once -- loses the
 * entire run to a single interruption. That is not hypothetical; it has already cost two runs here.
 * Appending as games complete means an interrupted run leaves a shorter dataset that is completely
 * valid rather than no dataset at all.
 *
 * The sidecar is rewritten as it goes, so `rows` always describes bytes that are actually on disk.
 * It is written *after* the blobs it describes, because the failure that matters is a reader
 * trusting a row count the files do not contain: a sidecar that lags the blobs truncates, which is
 * safe, while one that leads them reads off the end into whatever comes next.
 */
export async function openDataset(dir, { featureSize, policySize, seeds, featureLayout, policyLayout, config, generatedAt }) {
  await mkdir(dir, { recursive: true });

  const describe = (rows, games) =>
    sidecarFor({ rows, games, featureSize, policySize, seeds, featureLayout, policyLayout, config, generatedAt });
  const names = describe(0, 0).files;
  const handles = Object.fromEntries(
    await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await open(join(dir, name), 'w')])),
  );

  let rows = 0;
  // Counted by distinct game index rather than by call, because `writeDataset` hands over every
  // game at once while generation appends one at a time, and both have to report the same number.
  const played = new Set();
  const writeSidecar = () =>
    writeFile(join(dir, 'dataset.json'), `${JSON.stringify(describe(rows, played.size), null, 2)}\n`);
  // A readable, empty dataset from the outset, so an early kill still leaves something coherent.
  await writeSidecar();

  return {
    get rows() {
      return rows;
    },
    get games() {
      return played.size;
    },
    async append(samples) {
      if (samples.length === 0) return;
      const packed = pack(samples, featureSize, policySize);
      await Promise.all(Object.entries(packed).map(([key, array]) => handles[key].write(bytes(array))));
      rows += samples.length;
      for (const sample of samples) played.add(sample.game);
    },
    /** Publish the rows appended so far. Cheap, but not free, so the caller chooses when. */
    flush: writeSidecar,
    async close() {
      await writeSidecar();
      await Promise.all(Object.values(handles).map((handle) => handle.close()));
      return describe(rows, played.size);
    },
  };
}

/** Write a dataset in one go. Equivalent to opening one and appending everything. */
export async function writeDataset(dir, { samples, ...meta }) {
  const writer = await openDataset(dir, meta);
  await writer.append(samples);
  return writer.close();
}

/** Read a dataset back. Used by the tests, and by anything in Node that wants to inspect one. */
export async function readDataset(dir) {
  const sidecar = JSON.parse(await readFile(join(dir, 'dataset.json'), 'utf8'));
  /*
   * Cut to the row count the sidecar publishes rather than to the length of the file. The two differ
   * whenever a run was interrupted: rows are appended and the count is published after them, so the
   * blobs can run past the last published row with the tail of a game whose columns did not all
   * land. Reading the overhang would hand back rows stitched from different games.
   */
  const load = async (name, Kind, width) => {
    const buf = await readFile(join(dir, name));
    const all = new Kind(buf.buffer, buf.byteOffset, buf.byteLength / Kind.BYTES_PER_ELEMENT);
    const want = sidecar.rows * width;
    if (all.length < want) {
      throw new Error(`${name} holds ${all.length} values, short of the ${want} the sidecar claims`);
    }
    return all.subarray(0, want);
  };
  return {
    sidecar,
    x: await load(sidecar.files.x, Float32Array, sidecar.featureSize),
    pi: await load(sidecar.files.pi, Float32Array, sidecar.policySize),
    z: await load(sidecar.files.z, Float32Array, 1),
    q: await load(sidecar.files.q, Float32Array, 1),
    h: await load(sidecar.files.h, Float32Array, 1),
    meta: await load(sidecar.files.meta, Int32Array, 3),
  };
}
