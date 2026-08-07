#!/usr/bin/env node
/**
 * What does a leaf cost?
 *
 * The question this exists to answer is not "is the network more accurate" -- that is measured, it
 * is 5.3% better than the heuristic on held-out error. It is whether the network can be *afforded*.
 * A 1200-iteration search beats a 300-iteration one 39-1, roughly +600 elo, so search depth here is
 * worth a great deal and anything that reduces it starts from a very deep hole. A leaf evaluator
 * four times slower quarters the iteration count and would have to be worth more than that hole.
 *
 * Which makes the comparison a specific one. Not `net` against `evaluate`, because that is not the
 * swap: the incumbent leaf under `leaf: 'mixed'` is `0.5*evaluate + 0.5*rollout`, and the rollout is
 * up to 40 plies of real Splendor Duel ending in another `evaluate`. The AlphaZero design deletes
 * all of that and calls the network once. So the row that decides it is the last one.
 *
 *   node tools/selfplay/bench_leaf.mjs
 */

import { readFileSync } from 'node:fs';
import { RandomCursor } from '@games/engine';
import { DEFAULT_CONFIG, search } from '@games/bot-ismcts';
import splendorDuel, { encodeView, evaluate, redactFor, sampleAction } from '@games/splendor-duel';
import { forward, loadNet } from './net.mjs';
import { deps, OPTIONS } from './game.mjs';

const MODEL = process.argv[2] ?? '.data/models/value-gen0';
const net = loadNet(MODEL);

/*
 * Before timing anything, check this forward pass agrees with the one that trained the weights.
 * A transposed matrix does not throw -- it returns numbers in the right range, and every downstream
 * measurement would be of a network nobody trained.
 */
{
  const probe = JSON.parse(readFileSync(`${MODEL}/probe.json`, 'utf8'));
  let worst = 0;
  for (let i = 0; i < probe.inputs.length; i++) {
    const got = forward(net, Float32Array.from(probe.inputs[i]));
    for (let o = 0; o < got.length; o++) worst = Math.max(worst, Math.abs(got[o] - probe.outputs[i][o]));
  }
  console.log(`forward pass agrees with torch to ${worst.toExponential(1)}${worst < 1e-5 ? '' : '  <-- MISMATCH'}\n`);
  if (!(worst < 1e-5)) process.exit(1);
}

/** Real positions, at the depths a search actually meets, rather than opening positions. */
function collectStates(count) {
  const states = [];
  const rng = new RandomCursor('bench', 0);
  for (let game = 0; states.length < count; game++) {
    let state = splendorDuel.setup({ seed: `bench-${game}`, seats: [0, 1], options: OPTIONS });
    for (let ply = 0; ply < 160 && states.length < count; ply++) {
      if (splendorDuel.outcome(state).status === 'over') break;
      const actor = splendorDuel.currentActors(state)[0];
      if (actor === undefined) break;
      const action = sampleAction(state, actor, rng);
      if (action === null) break;
      const applied = splendorDuel.apply(state, actor, action);
      if (!applied.ok) break;
      state = applied.state;
      if (ply % 3 === 0) states.push(state);
    }
  }
  return states;
}

/** A faithful copy of `rollout` in search.ts, which is not exported. */
function rollout(start, seat, rng) {
  let state = start;
  for (let i = 0; i < DEFAULT_CONFIG.rolloutDepth; i++) {
    if (splendorDuel.outcome(state).status === 'over') return 1;
    const actor = splendorDuel.currentActors(state)[0];
    if (actor === undefined) break;
    const action = sampleAction(state, actor, rng);
    if (action === null) break;
    const applied = splendorDuel.apply(state, actor, action);
    if (!applied.ok) break;
    state = applied.state;
  }
  return splendorDuel.outcome(state).status === 'over' ? 1 : evaluate(state, seat);
}

const states = collectStates(300);
console.log(`${states.length} positions sampled from real games\n`);

function bench(label, fn, reps) {
  // Warm first, and separately, so the JIT has settled before the clock starts.
  let sink = 0;
  for (let i = 0; i < Math.min(reps, 300); i++) sink += fn(states[i % states.length], i);
  const started = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) sink += fn(states[i % states.length], i);
  const micros = Number(process.hrtime.bigint() - started) / 1000 / reps;
  if (!Number.isFinite(sink)) throw new Error('benchmark produced a non-finite value');
  return { label, micros };
}

const rng = new RandomCursor('roll', 0);
// Declared before the benchmarks that close over it: `bench` runs its function immediately, so a
// `const` below would be in the temporal dead zone rather than merely undefined.
const scratchX = encodeView(redactFor(0, states[0]), 0);
const rows = [
  bench('evaluate (the heuristic)', (s) => evaluate(s, 0), 200_000),
  bench('redactFor', (s) => redactFor(0, s).board.length, 100_000),
  bench('encodeView', (s) => encodeView(redactFor(0, s), 0)[0], 100_000),
  bench('forward pass alone', () => forward(net, scratchX)[0], 200_000),
  bench('net leaf: redact + encode + forward', (s) => forward(net, encodeView(redactFor(0, s), 0))[0], 50_000),
  bench('rollout only (40 ply)', (s) => rollout(s, 0, rng), 5_000),
  bench("incumbent leaf ('mixed')", (s) => 0.5 * evaluate(s, 0) + 0.5 * rollout(s, 0, rng), 5_000),
];

const incumbent = rows.find((r) => r.label.startsWith('incumbent')).micros;
console.log('                                        micros    vs incumbent');
for (const { label, micros } of rows) {
  const ratio = incumbent / micros;
  console.log(
    `  ${label.padEnd(36)} ${micros.toFixed(2).padStart(7)}   ` +
      (label.startsWith('incumbent') ? '—' : `${ratio.toFixed(1)}x ${ratio >= 1 ? 'cheaper' : 'DEARER'}`),
  );
}

const netLeaf = rows.find((r) => r.label.startsWith('net leaf')).micros;
const speedup = incumbent / netLeaf;
console.log(
  `\n  Swapping the mixed leaf for the network is ${speedup.toFixed(1)}x ` +
    `${speedup >= 1 ? 'cheaper' : 'dearer'} per leaf.`,
);

/*
 * Which is not the same as that many more iterations, and the difference is worth measuring rather
 * than assuming. A leaf is only part of an iteration -- there is the descent, the node bookkeeping,
 * `legalActions` at every expansion, and one determinization per iteration -- and none of that gets
 * faster. Timing a whole search with the rollout on and off bounds it from the other side:
 * `leaf: 'evaluate'` has the same shape as a net leaf, minus the forward pass.
 */
function searchRate(overrides) {
  const state = states[states.length >> 1];
  const view = redactFor(0, state);
  const config = { ...DEFAULT_CONFIG, ...overrides, iterations: 300 };
  for (let i = 0; i < 3; i++) search(deps, view, 0, { ...config, seed: `warm:${i}` });
  const started = process.hrtime.bigint();
  const runs = 12;
  for (let i = 0; i < runs; i++) search(deps, view, 0, { ...config, seed: `rate:${i}` });
  return Number(process.hrtime.bigint() - started) / 1e6 / runs;
}

const mixedMs = searchRate({ leaf: 'mixed' });
const heuristicMs = searchRate({ leaf: 'evaluate' });
const perLeafSaved = incumbent - rows.find((r) => r.label.startsWith('evaluate')).micros;
console.log(`\n  A whole 300-iteration search: ${mixedMs.toFixed(0)}ms with rollouts, ${heuristicMs.toFixed(0)}ms without.`);
// The net leaf sits between the two: no rollout, but a forward pass on top of the heuristic's cost.
const projected = heuristicMs + (300 * (netLeaf - rows.find((r) => r.label.startsWith('evaluate')).micros)) / 1000;
console.log(`  Projecting a net leaf onto that: ~${projected.toFixed(0)}ms, or ${(mixedMs / projected).toFixed(1)}x the iterations per second.`);
console.log(
  `  That is the number to believe, not the ${speedup.toFixed(1)}x above -- the descent, the node`,
);
console.log(`  bookkeeping and one determinization per iteration do not get any faster.`);
if (perLeafSaved <= 0) console.log('  (leaf accounting looks wrong -- the incumbent should exceed the heuristic)');
