/**
 * A forward pass for the checkpoints `checkpoint.py` writes.
 *
 * Small on purpose. The format is dense layers and three activations, so this is a loop over
 * matrices, and there is no reason to take a dependency to get one. If the architecture ever
 * outgrows it, widening both ends deliberately beats having installed a runtime first.
 *
 * Scratch buffers are allocated once at load. A leaf evaluator is called a few hundred times per
 * move, and allocating two Float32Arrays per call would make the garbage collector part of the
 * measurement -- which matters here, because whether the network is cheaper than what it replaces is
 * the entire question.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadNet(directory) {
  const sidecar = JSON.parse(readFileSync(join(directory, 'model.json'), 'utf8'));
  const buf = readFileSync(join(directory, sidecar.file));
  const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (flat.length !== sidecar.parameters) {
    throw new Error(`${directory}: ${flat.length} parameters on disk, sidecar claims ${sidecar.parameters}`);
  }

  let at = 0;
  const layers = sidecar.layers.map((layer) => {
    // Row-major (out, in), matching how torch stores `nn.Linear.weight` and how `checkpoint.py`
    // writes it. Walking output-by-output is also the order the loop below reads it in.
    const w = flat.subarray(at, at + layer.out * layer.in);
    at += layer.out * layer.in;
    const b = flat.subarray(at, at + layer.out);
    at += layer.out;
    return { ...layer, w, b, scratch: new Float32Array(layer.out) };
  });
  return { sidecar, layers, temperature: sidecar.temperature ?? 1 };
}

/** Returns one of the net's own scratch buffers -- read it or copy it before the next call. */
export function forward(net, x) {
  let input = x;
  for (const layer of net.layers) {
    const { w, b, scratch, in: nIn, out: nOut, activation } = layer;
    for (let o = 0; o < nOut; o++) {
      let sum = b[o];
      const row = o * nIn;
      for (let i = 0; i < nIn; i++) sum += w[row + i] * input[i];
      scratch[o] = activation === 'relu' ? (sum > 0 ? sum : 0) : activation === 'tanh' ? Math.tanh(sum) : sum;
    }
    input = scratch;
  }
  return input;
}
