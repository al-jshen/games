/**
 * A forward pass for the checkpoints `checkpoint.py` writes, single-headed or dual.
 *
 * Small on purpose. The format is dense layers and three activations, so this is a loop over
 * matrices, and there is no reason to take a dependency to get one. If the architecture ever
 * outgrows it, widening both ends deliberately beats having installed a runtime first.
 *
 * Scratch buffers are allocated once at load. A leaf evaluator is called a few hundred times per
 * move, and allocating a Float32Array per layer per call would make the garbage collector part of
 * the measurement -- which matters here, because whether the network is cheaper than what it
 * replaces is the entire question.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which implementation runs the arithmetic.
 *
 * `native` is the loop below. `onnx` hands the model to ONNX Runtime, which is worth knowing about
 * because the two scale completely differently: measured at batch 1, ORT costs ~95us whatever the
 * model is -- 23k parameters and 185k parameters both -- because it is almost entirely per-call
 * overhead. The native loop scales with the arithmetic. So they cross at roughly a 48-wide trunk:
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
 */
export const BACKENDS = ['native', 'onnx'];

/**
 * Slice a chain of dense layers out of the flat blob, with somewhere to put their outputs.
 *
 * **Widened to `Float64Array`, which is faster rather than slower, and by a lot.** The weights are
 * float32 on disk and the obvious thing is to keep them that way -- half the memory, and the network
 * was trained in single precision so nothing is gained by carrying more. Measured on a 719x256
 * matvec: float64 519us, float32 1551us, int16 1464us, int8 1777us -- three times, in the direction
 * nobody expects. The gain scales with the arithmetic, so it is 3x at a 256-wide trunk and only
 * 1.1x at the 32-wide net actually deployed today (72.5us to 65.0us). Worth having, not dramatic
 * at current sizes.
 *
 * The reason is that V8 has one number type. Every element read out of a `Float32Array` is converted
 * to a double before it can be multiplied, and every `Int8Array` read is too; only `Float64Array` is
 * a plain load. NNUE quantises to int8 and gets a large win, but that win is AVX2 doing thirty-two
 * lanes at once -- scalar JavaScript has no lanes to fill, so narrow types buy nothing and pay for
 * the conversion. Doubling the memory is irrelevant here: even a 256-wide trunk is 1.5MB and the
 * loop is nowhere near bandwidth-bound at 0.9 GB/s.
 */
function chain(descriptors, flat, at) {
  const layers = descriptors.map((layer) => {
    // Row-major (out, in), matching how torch stores `nn.Linear.weight` and how `checkpoint.py`
    // writes it. Walking output-by-output is also the order the loop below reads it in.
    const w = Float64Array.from(flat.subarray(at, at + layer.out * layer.in));
    at += layer.out * layer.in;
    const b = Float64Array.from(flat.subarray(at, at + layer.out));
    at += layer.out;
    return { ...layer, w, b, scratch: new Float64Array(layer.out) };
  });
  return { layers, at };
}

function run(layers, x, wide) {
  // The input is a `Float32Array` from `encodeView`, and the same conversion cost applies to it as
  // to the weights -- 719 conversions per call, on every leaf. Copied once into the caller's reusable
  // double buffer instead.
  let input = x;
  if (wide && x.length === wide.length) {
    wide.set(x);
    input = wide;
  }
  for (const layer of layers) {
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

export function loadNet(directory) {
  const sidecar = JSON.parse(readFileSync(join(directory, 'model.json'), 'utf8'));
  const buf = readFileSync(join(directory, sidecar.file));
  const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (flat.length !== sidecar.parameters) {
    throw new Error(`${directory}: ${flat.length} parameters on disk, sidecar claims ${sidecar.parameters}`);
  }

  if (sidecar.kind === 'dual') {
    // Order is trunk, value head, policy head, and the sidecar says so explicitly rather than
    // leaving it to be inferred from the order of keys in a JSON object.
    let at = 0;
    const trunk = chain(sidecar.trunk, flat, at);
    const value = chain(sidecar.heads.value, flat, trunk.at);
    const policy = chain(sidecar.heads.policy, flat, value.at);
    if (policy.at !== flat.length) {
      throw new Error(`${directory}: read ${policy.at} of ${flat.length} parameters`);
    }
    return {
      sidecar,
      kind: 'dual',
      trunk: trunk.layers,
      value: value.layers,
      policy: policy.layers,
      wide: new Float64Array(sidecar.trunk[0].in),
      temperature: sidecar.temperature ?? 1,
    };
  }

  const { layers } = chain(sidecar.layers, flat, 0);
  return {
    sidecar,
    kind: sidecar.kind ?? 'value',
    layers,
    wide: new Float64Array(sidecar.layers[0].in),
    temperature: sidecar.temperature ?? 1,
  };
}

/**
 * The value, and only the value.
 *
 * On a dual checkpoint this runs the trunk and the value head and stops. The policy head is 20% of
 * a forward pass at a 256-wide trunk and it is not wanted here: the value is needed at every one of
 * ~300 leaves per move, while the policy is needed wherever priors are computed -- once per move
 * under root-only PUCT, and not at all under UCB1. Computing it anyway would be a fifth of the
 * hottest path in the search spent on a number nobody reads.
 */
export function valueOf(net, x) {
  return net.kind === 'dual' ? run(net.value, run(net.trunk, x, net.wide))[0] : run(net.layers, x, net.wide)[0];
}

/** The policy logits. Shares the trunk's weights with `valueOf`, not its computation -- they are
 *  called on different positions, so there is nothing to reuse between them. */
export function policyOf(net, x) {
  return net.kind === 'dual' ? run(net.policy, run(net.trunk, x, net.wide)) : run(net.layers, x, net.wide);
}

/** Both, from one pass of the trunk. Only useful where the same position needs both numbers. */
export function bothOf(net, x) {
  if (net.kind !== 'dual') throw new Error('bothOf needs a dual checkpoint');
  const h = run(net.trunk, x, net.wide);
  // The value head's scratch would be clobbered by the policy head if the trunk were rerun, so the
  // value is read out before the second head touches anything.
  const value = run(net.value, h)[0];
  return { value, policy: run(net.policy, h) };
}

/** Back-compatible whole-chain pass, for single-headed checkpoints and the probe check. */
export function forward(net, x) {
  if (net.kind === 'dual') throw new Error('forward is for single-headed checkpoints; use valueOf');
  return run(net.layers, x, net.wide);
}
