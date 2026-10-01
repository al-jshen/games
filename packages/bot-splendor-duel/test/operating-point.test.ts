import { describe, expect, it } from 'vitest';
import { operatingPoint } from '../src/index.js';

describe('the operating point', () => {
  it('is the one every measurement of the network was taken at', () => {
    /*
     * Pinned on purpose. These are copied from `tools/selfplay/loop.yaml`, and the numbers attached
     * to the published network — the gate, the win rate against the heuristic search — were all
     * measured with exactly these. Changing one here changes which agent the browser and the BGA
     * adapter are playing, without changing its name.
     */
    expect(operatingPoint(1000, 'seed')).toMatchObject({
      iterations: 1000,
      seed: 'seed',
      leaf: 'evaluate',
      selection: 'puct',
      puctExploration: 4,
      puctDepth: 99,
      normaliseValues: true,
    });
  });
});
