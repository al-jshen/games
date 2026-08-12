/**
 * A forward pass for the checkpoints `tools/selfplay/checkpoint.py` writes, single-headed or dual.
 *
 * Small on purpose. The format is dense layers and three activations, so this is a loop over
 * matrices, and there is no reason to take a dependency to get one. If the architecture ever
 * outgrows it, widening both ends deliberately beats having installed a runtime first.
 *
 * Scratch buffers are allocated once at load. A leaf evaluator is called a few hundred times per
 * move, and allocating a Float32Array per layer per call would make the garbage collector part of
 * the measurement -- which matters here, because whether the network is cheaper than what it
 * replaces is the entire question.
 *
 * **Nothing here reads a file, and that is the point of it being a package.** This began as
 * `tools/selfplay/net.mjs`, which read `model.json` and `weights.f32` off disk with `node:fs` and so
 * could only ever run on a compute node. The browser wants the identical arithmetic -- the bot a
 * player faces in `apps/web` has to be the same network the arena measured, or the elo numbers in
 * this repo describe something nobody plays. So the IO moved to the two callers that have opinions
 * about where bytes come from (`readFileSync` there, `fetch` here) and the arithmetic moved here,
 * once. `tools/selfplay/net.mjs` is now a nine-line wrapper over `makeNet`.
 */

/** What a layer does after the matrix multiply. `null` is a bare linear layer, as the policy head's last is. */
export type Activation = 'relu' | 'tanh' | null;

/** One dense layer, as `checkpoint.py` describes it. */
export interface LayerSpec {
  in: number;
  out: number;
  activation: Activation;
}

interface SidecarBase {
  parameters: number;
  file: string;
  /**
   * Divides the logits before the softmax. Fitted on held-out data by `train_policy.py`, so a
   * checkpoint that carries one is *calibrated* and a checkpoint that does not is raw. 1 is the
   * identity, which is the honest default for a value net that has no logits at all.
   */
  temperature?: number;
  [key: string]: unknown;
}

/** A single chain of layers: one head, no trunk. */
export interface SingleSidecar extends SidecarBase {
  kind?: 'value' | 'policy';
  layers: LayerSpec[];
}

/** A trunk that forks into a value head and a policy head. */
export interface DualSidecar extends SidecarBase {
  kind: 'dual';
  trunk: LayerSpec[];
  heads: { value: LayerSpec[]; policy: LayerSpec[] };
}

export type Sidecar = SingleSidecar | DualSidecar;

interface Layer extends LayerSpec {
  w: Float64Array;
  b: Float64Array;
  scratch: Float64Array;
}

interface NetBase {
  sidecar: Sidecar;
  /** A reusable double-width copy of the input. See `run`. */
  wide: Float64Array;
  temperature: number;
}

export interface SingleNet extends NetBase {
  kind: 'value' | 'policy';
  layers: Layer[];
}

export interface DualNet extends NetBase {
  kind: 'dual';
  trunk: Layer[];
  value: Layer[];
  policy: Layer[];
}

export type Net = SingleNet | DualNet;

/**
 * Slice a chain of dense layers out of the flat blob, with somewhere to put their outputs.
 *
 * **Widened to `Float64Array`, which is faster rather than slower, and by a lot.** The weights are
 * float32 on disk and the obvious thing is to keep them that way -- half the memory, and the network
 * was trained in single precision so nothing is gained by carrying more. Measured on a 719x256
 * matvec: float64 519us, float32 1551us, int16 1464us, int8 1777us -- three times, in the direction
 * nobody expects. The gain scales with the arithmetic, so it is 3x at a 256-wide trunk and only
 * 1.1x at the 32-wide value net (72.5us to 65.0us). Worth having, not dramatic at that size.
 *
 * The reason is that V8 has one number type. Every element read out of a `Float32Array` is converted
 * to a double before it can be multiplied, and every `Int8Array` read is too; only `Float64Array` is
 * a plain load. NNUE quantises to int8 and gets a large win, but that win is AVX2 doing thirty-two
 * lanes at once -- scalar JavaScript has no lanes to fill, so narrow types buy nothing and pay for
 * the conversion. Doubling the memory is irrelevant here: even a 256-wide trunk is 1.5MB and the
 * loop is nowhere near bandwidth-bound at 0.9 GB/s.
 */
function chain(descriptors: LayerSpec[], flat: Float32Array, from: number): { layers: Layer[]; at: number } {
  let at = from;
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

function run(layers: Layer[], x: Float32Array | Float64Array, wide?: Float64Array): Float64Array {
  // The input is a `Float32Array` from `encodeView`, and the same conversion cost applies to it as
  // to the weights -- 719 conversions per call, on every leaf. Copied once into the caller's reusable
  // double buffer instead.
  let input: Float32Array | Float64Array = x;
  if (wide && x.length === wide.length) {
    wide.set(x);
    input = wide;
  }
  let out = input as Float64Array;
  for (const layer of layers) {
    const { w, b, scratch, in: nIn, out: nOut, activation } = layer;
    for (let o = 0; o < nOut; o++) {
      let sum = b[o] as number;
      const row = o * nIn;
      for (let i = 0; i < nIn; i++) sum += (w[row + i] as number) * (input[i] as number);
      scratch[o] = activation === 'relu' ? (sum > 0 ? sum : 0) : activation === 'tanh' ? Math.tanh(sum) : sum;
    }
    input = scratch;
    out = scratch;
  }
  return out;
}

function firstInput(sidecar: Sidecar): number {
  const layers = sidecar.kind === 'dual' ? sidecar.trunk : sidecar.layers;
  const first = layers[0];
  if (first === undefined) throw new Error('checkpoint has no layers');
  return first.in;
}

/**
 * Turn a sidecar and its weights into something callable.
 *
 * The parameter count is checked rather than trusted, because the failure it catches is silent: a
 * truncated blob reads as a network whose last layer is quietly full of whatever followed it, and it
 * will happily return plausible numbers for ever.
 */
export function makeNet(sidecar: Sidecar, flat: Float32Array, label = 'checkpoint'): Net {
  if (flat.length !== sidecar.parameters) {
    throw new Error(`${label}: ${flat.length} parameters on hand, sidecar claims ${sidecar.parameters}`);
  }
  const wide = new Float64Array(firstInput(sidecar));
  const temperature = sidecar.temperature ?? 1;

  if (sidecar.kind === 'dual') {
    // Order is trunk, value head, policy head, and the sidecar says so explicitly rather than
    // leaving it to be inferred from the order of keys in a JSON object.
    const trunk = chain(sidecar.trunk, flat, 0);
    const value = chain(sidecar.heads.value, flat, trunk.at);
    const policy = chain(sidecar.heads.policy, flat, value.at);
    if (policy.at !== flat.length) {
      throw new Error(`${label}: read ${policy.at} of ${flat.length} parameters`);
    }
    return { sidecar, kind: 'dual', trunk: trunk.layers, value: value.layers, policy: policy.layers, wide, temperature };
  }

  const { layers, at } = chain(sidecar.layers, flat, 0);
  if (at !== flat.length) throw new Error(`${label}: read ${at} of ${flat.length} parameters`);
  return { sidecar, kind: sidecar.kind ?? 'value', layers, wide, temperature };
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
export function valueOf(net: Net, x: Float32Array | Float64Array): number {
  const out = net.kind === 'dual' ? run(net.value, run(net.trunk, x, net.wide)) : run(net.layers, x, net.wide);
  return out[0] as number;
}

/** The policy logits. Shares the trunk's weights with `valueOf`, not its computation -- they are
 *  called on different positions, so there is nothing to reuse between them. */
export function policyOf(net: Net, x: Float32Array | Float64Array): Float64Array {
  return net.kind === 'dual' ? run(net.policy, run(net.trunk, x, net.wide)) : run(net.layers, x, net.wide);
}

/** Both, from one pass of the trunk. Only useful where the same position needs both numbers. */
export function bothOf(net: Net, x: Float32Array | Float64Array): { value: number; policy: Float64Array } {
  if (net.kind !== 'dual') throw new Error('bothOf needs a dual checkpoint');
  const h = run(net.trunk, x, net.wide);
  // The value head's scratch would be clobbered by the policy head if the trunk were rerun, so the
  // value is read out before the second head touches anything.
  const value = run(net.value, h)[0] as number;
  return { value, policy: run(net.policy, h) };
}

/** Back-compatible whole-chain pass, for single-headed checkpoints and the probe check. */
export function forward(net: Net, x: Float32Array | Float64Array): Float64Array {
  if (net.kind === 'dual') throw new Error('forward is for single-headed checkpoints; use valueOf');
  return run(net.layers, x, net.wide);
}

/**
 * A checkpoint over HTTP, from a directory served as-is.
 *
 * The two files go out in parallel because they are independent and the policy head is thirty times
 * the size of its sidecar -- waiting for the JSON before starting the 3MB would add a round trip to
 * the one request that actually costs something.
 *
 * `weights.f32` is a raw little-endian `float32` blob, which every platform this runs on already is,
 * so the `ArrayBuffer` is reinterpreted rather than converted. A big-endian browser would read it
 * backwards; none exists, and `checkpoint.py` writes `<f4` on the same assumption.
 */
export async function fetchNet(baseUrl: string): Promise<Net> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  const get = async (url: string): Promise<Response> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    return response;
  };

  // `sidecar.file` decides the second URL, so the requests cannot be issued together without
  // guessing the name. It is always `weights.f32` in practice, and guessing it would be the kind of
  // shortcut that works until the day a checkpoint is written differently.
  const sidecar = (await (await get(`${base}model.json`)).json()) as Sidecar;
  const buffer = await (await get(`${base}${sidecar.file}`)).arrayBuffer();

  return makeNet(sidecar, new Float32Array(buffer), base);
}
