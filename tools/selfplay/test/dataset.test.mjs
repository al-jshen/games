import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEATURE_SIZE, POLICY_SIZE } from '@games/splendor-duel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDataset, writeDataset } from '../dataset.mjs';

/**
 * The dataset format is a contract with a trainer written in another language, and the failure mode
 * is quiet: a wrong stride or a truncated file reshapes into plausible nonsense, trains without
 * complaint, and produces a model that is simply wrong. So the bytes are checked, not just the API.
 */

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'games-dataset-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sample(i) {
  const x = new Float32Array(FEATURE_SIZE);
  const pi = new Float32Array(POLICY_SIZE);
  for (let k = 0; k < FEATURE_SIZE; k++) x[k] = (i * 31 + k) % 97 / 97;
  // A normalised distribution, as the real target is.
  pi[i % POLICY_SIZE] = 0.75;
  pi[(i * 7 + 3) % POLICY_SIZE] += 0.25;
  return { x, pi, z: [1, -1, 0][i % 3], h: (i % 11) / 11 - 0.5, game: Math.floor(i / 4), move: i % 4, seat: i % 2 };
}

describe('the training dataset', () => {
  it('round-trips every row exactly, values and metadata alike', async () => {
    const samples = Array.from({ length: 40 }, (_, i) => sample(i));
    await writeDataset(dir, {
      samples,
      seeds: ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'],
      featureSize: FEATURE_SIZE,
      policySize: POLICY_SIZE,
      featureLayout: { size: FEATURE_SIZE },
      policyLayout: { size: POLICY_SIZE },
      config: { iterations: 7 },
      generatedAt: '2026-01-01T00:00:00.000Z',
    });

    const back = await readDataset(dir);
    expect(back.sidecar.rows).toBe(40);
    expect(back.sidecar.featureSize).toBe(FEATURE_SIZE);
    expect(back.sidecar.policySize).toBe(POLICY_SIZE);
    expect(back.x).toHaveLength(40 * FEATURE_SIZE);
    expect(back.pi).toHaveLength(40 * POLICY_SIZE);
    expect(back.z).toHaveLength(40);
    expect(back.meta).toHaveLength(40 * 3);

    for (const [i, original] of samples.entries()) {
      // A wrong stride is the classic way to get this subtly wrong, so rows are checked whole.
      expect(Array.from(back.x.slice(i * FEATURE_SIZE, (i + 1) * FEATURE_SIZE))).toEqual(Array.from(original.x));
      expect(Array.from(back.pi.slice(i * POLICY_SIZE, (i + 1) * POLICY_SIZE))).toEqual(Array.from(original.pi));
      expect(back.z[i]).toBe(original.z);
      expect(back.h[i]).toBeCloseTo(original.h, 6);
      expect([back.meta[i * 3], back.meta[i * 3 + 1], back.meta[i * 3 + 2]]).toEqual([
        original.game,
        original.move,
        original.seat,
      ]);
    }
  });

  it('records enough to find a row again on a board', async () => {
    /*
     * The point of the metadata: a suspicious row has to lead back to a position somebody can look
     * at. Without it a bad sample is several hundred anonymous floats.
     */
    const samples = [sample(0), sample(5)];
    await writeDataset(dir, {
      samples,
      seeds: ['alpha', 'beta'],
      featureSize: FEATURE_SIZE,
      policySize: POLICY_SIZE,
      featureLayout: {},
      policyLayout: {},
      config: {},
      generatedAt: 'now',
    });
    const back = await readDataset(dir);
    expect(back.sidecar.seeds[back.meta[0]]).toBe('alpha');
    expect(back.sidecar.meta).toEqual(['game', 'move', 'seat']);
  });

  it('writes exactly the number of bytes the sidecar claims', async () => {
    // What a reader in another language actually depends on: file length divided by stride.
    const samples = Array.from({ length: 12 }, (_, i) => sample(i));
    const sidecar = await writeDataset(dir, {
      samples,
      seeds: [],
      featureSize: FEATURE_SIZE,
      policySize: POLICY_SIZE,
      featureLayout: {},
      policyLayout: {},
      config: {},
      generatedAt: 'now',
    });
    const { statSync } = await import('node:fs');
    expect(statSync(join(dir, sidecar.files.x)).size).toBe(12 * FEATURE_SIZE * 4);
    expect(statSync(join(dir, sidecar.files.pi)).size).toBe(12 * POLICY_SIZE * 4);
    expect(statSync(join(dir, sidecar.files.z)).size).toBe(12 * 4);
    expect(statSync(join(dir, sidecar.files.h)).size).toBe(12 * 4);
    expect(statSync(join(dir, sidecar.files.meta)).size).toBe(12 * 3 * 4);
  });
});
