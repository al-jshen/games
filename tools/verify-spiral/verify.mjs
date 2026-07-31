#!/usr/bin/env node
/**
 * Re-derive the board's spiral fill order from the printed board art.
 *
 * Why this exists: the rulebook only ever says "starting with the central space and following the
 * printed spiral". The spiral itself is art on the physical board, so no amount of reading settles
 * its handedness — and the fan implementations disagree, with the majority getting it wrong.
 *
 * The method does not involve eyeballing arrows. Each board cell carries a printed path segment;
 * detecting which of the cell's four edges that segment touches recovers the *undirected* path, and
 * the centre cell is a degree-1 endpoint which orients it. The result is self-checking:
 *
 *   - every cell's edge detection must agree with its neighbour's (a shared edge is seen twice);
 *   - there must be exactly two degree-1 cells, one of which is the centre;
 *   - the walk must visit all 25 cells exactly once;
 *   - the leg lengths must be 1,1,2,2,3,3,4,4,4 -- the signature of an outward square spiral.
 *
 * If any of those fail, the geometry constants below are wrong for the image, not the conclusion.
 *
 * The board scan is fetched into a gitignored cache rather than committed: it is Space Cowboys
 * artwork, and we only need a handful of integers out of it.
 *
 *   npm run verify:spiral
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, '.cache/board.png');
const SOURCE =
  'https://raw.githubusercontent.com/leopoldch/splendor-duel-digital/main/src/assets/rest_detoured/Board.png';

/** Grid geometry of the cached scan, measured from where the cream cell faces begin and end. */
const GRID = { x0: 15, y0: 14, pitch: 72, cell: 58 };

/* ------------------------------------------------------------------ tiny PNG decoder */

function decodePng(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette = null;
  const idat = [];

  while (pos < bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    const body = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colorType = body[9];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
      if (body[12] !== 0) throw new Error('interlaced PNGs are not supported');
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let offset = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[offset++];
    const line = Buffer.from(raw.subarray(offset, offset + stride));
    offset += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[i] = (line[i] + a) & 255; break;
        case 2: line[i] = (line[i] + b) & 255; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
        default: throw new Error(`unknown filter ${filter}`);
      }
    }
    line.copy(pixels, y * stride);
    previous = line;
  }

  const luma = (x, y) => {
    const i = y * stride + x * channels;
    if (colorType === 3) {
      const idx = pixels[i] * 3;
      return 0.299 * palette[idx] + 0.587 * palette[idx + 1] + 0.114 * palette[idx + 2];
    }
    if (colorType === 0 || colorType === 4) return pixels[i];
    return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  };
  return { width, height, luma };
}

/* ------------------------------------------------------------------ edge detection */

const DIRS = { U: [-1, 0], D: [1, 0], L: [0, -1], R: [0, 1] };
const OPPOSITE = { U: 'D', D: 'U', L: 'R', R: 'L' };

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Which cell edges does this cell's printed path segment reach?
 *
 * The segment is drawn along the cell's centre axes, so we scan a thin band just inside each edge,
 * within a few pixels of the axis, and look for pixels much darker than the cell's own background.
 * Using the cell's median as the reference makes this work for the highlighted centre cell too,
 * which is painted a different colour from the rest.
 */
function edgesTouched(luma, row, col) {
  const x0 = GRID.x0 + GRID.pitch * col;
  const y0 = GRID.y0 + GRID.pitch * row;
  const size = GRID.cell;
  const cx = x0 + (size >> 1);
  const cy = y0 + (size >> 1);

  const samples = [];
  for (let dx = 6; dx < size - 6; dx += 3) {
    for (let dy = 6; dy < size - 6; dy += 3) samples.push(luma(x0 + dx, y0 + dy));
  }
  const threshold = median(samples) - 38;

  const hits = {};
  for (const [name, [dr, dc]] of Object.entries(DIRS)) {
    let count = 0;
    for (let depth = 1; depth < 6; depth++) {
      for (let along = -5; along <= 5; along++) {
        const x = dc === 0 ? cx + along : dc < 0 ? x0 + depth : x0 + size - 1 - depth;
        const y = dr === 0 ? cy + along : dr < 0 ? y0 + depth : y0 + size - 1 - depth;
        if (luma(x, y) < threshold) count += 1;
      }
    }
    hits[name] = count;
  }
  // A touched edge lights up a run of pixels; noise does not.
  return Object.keys(DIRS).filter((name) => hits[name] >= 5);
}

/* ------------------------------------------------------------------ main */

async function boardBytes() {
  try {
    return await readFile(CACHE);
  } catch {
    process.stdout.write(`Fetching board art into ${CACHE} ...\n`);
    const response = await fetch(SOURCE);
    if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(CACHE), { recursive: true });
    await writeFile(CACHE, bytes);
    return bytes;
  }
}

const { luma } = decodePng(await boardBytes());

const edges = new Map();
for (let row = 0; row < 5; row++) {
  for (let col = 0; col < 5; col++) edges.set(row * 5 + col, edgesTouched(luma, row, col));
}

const problems = [];

// Consistency: a shared edge is detected from both sides, or the geometry is off.
for (const [cell, dirs] of edges) {
  const row = Math.floor(cell / 5);
  const col = cell % 5;
  for (const dir of dirs) {
    const [dr, dc] = DIRS[dir];
    const nr = row + dr;
    const nc = col + dc;
    if (nr < 0 || nr > 4 || nc < 0 || nc > 4) {
      problems.push(`cell ${cell} has an edge ${dir} pointing off the board`);
      continue;
    }
    if (!edges.get(nr * 5 + nc).includes(OPPOSITE[dir])) {
      problems.push(`cell ${cell} sees ${dir} but its neighbour ${nr * 5 + nc} disagrees`);
    }
  }
}

const endpoints = [...edges].filter(([, dirs]) => dirs.length === 1).map(([cell]) => cell);
if (endpoints.length !== 2) problems.push(`expected exactly 2 endpoints, found ${endpoints.length}: ${endpoints}`);
if (!endpoints.includes(12)) problems.push('the centre cell (12) is not an endpoint, so it cannot be the start');

// Walk from the centre.
const path = [];
let current = 12;
let previous = null;
while (current !== undefined && current !== null) {
  path.push(current);
  const row = Math.floor(current / 5);
  const col = current % 5;
  let next = null;
  for (const dir of edges.get(current)) {
    const [dr, dc] = DIRS[dir];
    const candidate = (row + dr) * 5 + (col + dc);
    if (candidate !== previous) next = candidate;
  }
  previous = current;
  current = next;
}

if (path.length !== 25 || new Set(path).size !== 25) {
  problems.push(`walk visited ${path.length} cells (${new Set(path).size} unique), expected 25 unique`);
}

const legs = [];
let run = 1;
for (let i = 2; i < path.length; i++) {
  if (path[i] - path[i - 1] === path[i - 1] - path[i - 2]) run += 1;
  else {
    legs.push(run);
    run = 1;
  }
}
legs.push(run);
const expectedLegs = [1, 1, 2, 2, 3, 3, 4, 4, 4];
if (JSON.stringify(legs) !== JSON.stringify(expectedLegs)) {
  problems.push(`leg lengths ${JSON.stringify(legs)} are not an outward square spiral ${JSON.stringify(expectedLegs)}`);
}

const order = new Map(path.map((cell, i) => [cell, i]));
process.stdout.write('\nFill order per cell (row 0 at top):\n');
for (let row = 0; row < 5; row++) {
  const cells = [];
  for (let col = 0; col < 5; col++) cells.push(String(order.get(row * 5 + col) ?? '??').padStart(2));
  process.stdout.write(`  ${cells.join(' ')}\n`);
}

process.stdout.write(`\nSPIRAL = [${path.join(', ')}]\n`);
process.stdout.write(`leg lengths: ${JSON.stringify(legs)}\n`);
process.stdout.write(`endpoints: centre ${path[0]} -> ${path[path.length - 1]}\n`);

if (problems.length > 0) {
  process.stderr.write(`\nFAILED (${problems.length} problem(s)):\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}

// Cross-check against the constant the engine ships.
const spiralSource = await readFile(resolve(HERE, '../../packages/games/splendor-duel/src/spiral.ts'), 'utf8');
const declared = /export const SPIRAL[^=]*=\s*\[([^\]]+)\]/s.exec(spiralSource);
if (!declared) {
  process.stderr.write('\nCould not find SPIRAL in packages/games/splendor-duel/src/spiral.ts\n');
  process.exit(1);
}
const declaredOrder = declared[1]
  .split(',')
  .map((n) => n.trim())
  // Drop the trailing-comma empty string before converting: `Number('')` is 0, not NaN, so
  // filtering on NaN afterwards would silently append a phantom cell 0.
  .filter((n) => n.length > 0)
  .map(Number)
  .filter((n) => !Number.isNaN(n));
if (JSON.stringify(declaredOrder) !== JSON.stringify(path)) {
  process.stderr.write('\nMISMATCH: the engine constant does not match the board art.\n');
  process.stderr.write(`  engine: [${declaredOrder.join(', ')}]\n`);
  process.stderr.write(`  art:    [${path.join(', ')}]\n`);
  process.exit(1);
}

process.stdout.write('\nAll checks passed, and the engine constant matches the board art.\n');
