#!/usr/bin/env node
/**
 * Benchmark the server the way a bot actually uses it.
 *
 * Run with `npm run bench`. Numbers are for the machine you run it on, over loopback, so treat them
 * as a ceiling: on a real network the round trip is dominated by RTT, which none of this can help.
 *
 * Measures, in order of how much a bot author cares:
 *   1. Round-trip latency for one move (submit -> applied), and for a `legalActions` request.
 *   2. Sequential throughput for a single bot: how many moves a second one match can sustain.
 *   3. Concurrent throughput: many matches at once, and how latency degrades.
 *   4. Where the server's per-move time actually goes (reducer, redaction, serialisation, database).
 *   5. Payload sizes, since those set the bandwidth floor.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { startServer } from '../../apps/server/dist/server.js';
import { MemoryReplayStore } from '../../apps/server/dist/replay-store.js';
import { SqliteReplayStore } from '../../apps/server/dist/sqlite-store.js';
import { splendorDuel } from '../../packages/games/splendor-duel/dist/index.js';
import { createMatch, step } from '../../packages/engine/dist/index.js';

const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ stats */

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    mean: sorted.reduce((t, v) => t + v, 0) / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  };
}

const ms = (v) => `${v.toFixed(3)}ms`;
function row(label, s) {
  console.log(
    `  ${label.padEnd(30)} n=${String(s.n).padStart(6)}  ` +
      `p50=${ms(s.p50).padStart(9)}  p95=${ms(s.p95).padStart(9)}  p99=${ms(s.p99).padStart(9)}  max=${ms(s.max)}`,
  );
}

/* ------------------------------------------------------------------ a minimal bot client */

class Client {
  constructor(url) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.waiters = [];
    this.queue = [];
    this.bytesIn = 0;
    this.ws.on('message', (raw) => {
      this.bytesIn += raw.length;
      const frame = JSON.parse(String(raw));
      const i = this.waiters.findIndex((w) => w.match(frame));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(frame);
      else this.queue.push(frame);
    });
  }

  static async connect(url) {
    const c = new Client(url);
    await new Promise((done, fail) => {
      c.ws.once('open', done);
      c.ws.once('error', fail);
    });
    return c;
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  next(match) {
    const i = this.queue.findIndex(match);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  close() {
    this.ws.close();
  }
}

async function seatPair(url, gameId) {
  const host = await Client.connect(url);
  host.send({ t: 'hello', protocolVersion: PROTOCOL_VERSION });
  await host.next((f) => f.t === 'hello_ok');
  host.send({ t: 'create', gameId });
  const joined = await host.next((f) => f.t === 'joined');

  const guest = await Client.connect(url);
  guest.send({ t: 'hello', protocolVersion: PROTOCOL_VERSION });
  await guest.next((f) => f.t === 'hello_ok');
  guest.send({ t: 'join', code: joined.code });
  await guest.next((f) => f.t === 'joined');

  const sync = await host.next((f) => f.t === 'sync' && f.snapshot.players.length === 2);
  await guest.next((f) => f.t === 'sync');
  return { host, guest, seats: { [host.seatIndex ?? 0]: host }, snapshot: sync.snapshot, code: joined.code };
}

/**
 * Play one match to completion, timing each move.
 *
 * Moves are chosen from the client's own copy of the rules so that the measurement is of the server's
 * round trip, not of a bot's thinking. `useServerLegalActions` adds the extra request a
 * non-TypeScript bot has to make, which is the honest cost for a Python bot.
 */
async function playMatch(url, { useServerLegalActions = false, actionLatencies, legalLatencies } = {}) {
  const { host, guest } = await seatPair(url, 'splendor-duel');
  const clients = [host, guest];
  let snapshot = (await host.next((f) => f.t === 'sync')) ?? null;
  // Both already have a sync; re-read the latest from the host.
  host.send({ t: 'resync' });
  snapshot = (await host.next((f) => f.t === 'sync')).snapshot;

  let moves = 0;
  let bytes = 0;
  try {
    for (let i = 0; i < 4000; i++) {
      if (snapshot.outcome.status === 'over') break;
      const seat = snapshot.actors[0];
      if (seat === undefined) break;
      const client = clients[seat];

      let actions;
      if (useServerLegalActions) {
        const t0 = performance.now();
        client.send({ t: 'legalActions' });
        const legal = await client.next((f) => f.t === 'legal');
        legalLatencies?.push(performance.now() - t0);
        actions = legal.actions;
      } else {
        actions = splendorDuel.legalActionsFromView(snapshot.view, seat).actions;
      }
      if (actions.length === 0) break;

      const action = actions[(i * 7919) % actions.length];
      const id = `b${i}`;
      const t1 = performance.now();
      client.send({ t: 'action', expectVersion: snapshot.version, clientActionId: id, action });
      const reply = await client.next(
        (f) => (f.t === 'applied' || f.t === 'rejected') && f.clientActionId === id,
      );
      actionLatencies?.push(performance.now() - t1);
      if (reply.t === 'rejected') {
        snapshot = reply.snapshot;
        continue;
      }
      snapshot = reply.snapshot;
      moves += 1;
    }
    bytes = host.bytesIn + guest.bytesIn;
  } finally {
    host.close();
    guest.close();
  }
  return { moves, bytes };
}

/* ------------------------------------------------------------------ 1. the engine alone */

function benchEngine() {
  console.log('\n1. The rules engine on its own (no network, no database)');
  const samples = [];
  let total = 0;
  for (let m = 0; m < 40; m++) {
    let match = createMatch(splendorDuel, {
      matchId: `m${m}`,
      code: 'BENCH1',
      seed: `seed-${m}`,
      seats: [0, 1],
      options: {},
      now: 0,
    });
    for (let i = 0; i < 4000; i++) {
      const actors = splendorDuel.currentActors(match.state);
      if (actors.length === 0) break;
      const { actions } = splendorDuel.legalActions(match.state, actors[0]);
      if (actions.length === 0) break;
      const t0 = performance.now();
      const result = step(splendorDuel, match, actors[0], actions[(i * 7919) % actions.length], i);
      samples.push(performance.now() - t0);
      if (!result.ok) break;
      match = result.match;
      total += 1;
    }
  }
  row('validate + apply one move', stats(samples));
  const perMove = stats(samples).mean;
  console.log(`  -> ${Math.round(1000 / perMove).toLocaleString()} moves/sec of pure rules work (${total} moves sampled)`);
  return perMove;
}

/* ------------------------------------------------------------------ 2. server-side per-move work */

function benchServerWork() {
  console.log('\n2. What the server does per move, measured directly');
  const dir = mkdtempSync(join(tmpdir(), 'games-bench-'));
  const store = new SqliteReplayStore(join(dir, 'bench.db'));
  try {
    let match = createMatch(splendorDuel, {
      matchId: 'work',
      code: 'BENCH2',
      seed: 'work-seed',
      seats: [0, 1],
      options: {},
      now: 0,
    });
    const redact = [];
    const serialise = [];
    const save = [];
    let viewBytes = 0;

    for (let i = 0; i < 600; i++) {
      const actors = splendorDuel.currentActors(match.state);
      if (actors.length === 0) break;
      const { actions } = splendorDuel.legalActions(match.state, actors[0]);
      if (actions.length === 0) break;
      const result = step(splendorDuel, match, actors[0], actions[(i * 7919) % actions.length], i);
      if (!result.ok) break;
      match = result.match;

      // Two seats, so two distinct redacted views per move.
      const t0 = performance.now();
      const a = splendorDuel.redactFor(0, match.state);
      const b = splendorDuel.redactFor(1, match.state);
      redact.push(performance.now() - t0);

      // Serialising both views is what the server actually does per move, and the result is used
      // below, so there is nothing here for the JIT to elide.
      const t1 = performance.now();
      const seat0 = JSON.stringify(a);
      const seat1 = JSON.stringify(b);
      serialise.push(performance.now() - t1);
      viewBytes = Math.round((Buffer.byteLength(seat0) + Buffer.byteLength(seat1)) / 2);

      const t2 = performance.now();
      store.save(match.record);
      save.push(performance.now() - t2);
    }

    row('redact for both seats', stats(redact));
    row('serialise both views', stats(serialise));
    row('sqlite upsert of the record', stats(save));
    console.log(`  -> one redacted view is ${viewBytes.toLocaleString()} bytes of JSON`);
    console.log(
      `  -> server-side total ~${ms(stats(redact).mean + stats(serialise).mean + stats(save).mean)} per move`,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ 3-5. over a real socket */

async function benchOverSocket(storeKind) {
  const dir = mkdtempSync(join(tmpdir(), 'games-bench-'));
  const store = storeKind === 'memory' ? new MemoryReplayStore() : new SqliteReplayStore(join(dir, 'bench.db'));
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    webRoot: null,
    store,
    sessionSecret: 'benchmark-secret-long-enough',
    quiet: true,
  });
  const url = `${server.url.replace('http', 'ws')}/ws`;

  try {
    console.log(`\n3. One bot, one match at a time, over a WebSocket (store: ${storeKind})`);
    const actionLatencies = [];
    let moves = 0;
    let bytes = 0;
    const t0 = performance.now();
    for (let m = 0; m < 8; m++) {
      const r = await playMatch(url, { actionLatencies });
      moves += r.moves;
      bytes += r.bytes;
    }
    const wall = performance.now() - t0;
    row('submit -> applied', stats(actionLatencies));
    console.log(
      `  -> ${Math.round((moves / wall) * 1000).toLocaleString()} moves/sec sequentially ` +
        `(${moves} moves in ${(wall / 1000).toFixed(2)}s, one move in flight at a time)`,
    );
    console.log(`  -> ${Math.round(bytes / moves).toLocaleString()} bytes received per move, across both clients`);

    console.log('\n4. The same, but asking the server to enumerate legal moves each turn');
    const actions2 = [];
    const legal2 = [];
    const t1 = performance.now();
    let moves2 = 0;
    for (let m = 0; m < 4; m++) {
      const r = await playMatch(url, {
        useServerLegalActions: true,
        actionLatencies: actions2,
        legalLatencies: legal2,
      });
      moves2 += r.moves;
    }
    const wall2 = performance.now() - t1;
    row('legalActions -> legal', stats(legal2));
    row('submit -> applied', stats(actions2));
    console.log(
      `  -> ${Math.round((moves2 / wall2) * 1000).toLocaleString()} moves/sec (two round trips per move)`,
    );

    console.log('\n5. Many matches at once');
    for (const concurrency of [1, 4, 16, 48]) {
      const latencies = [];
      const t2 = performance.now();
      const results = await Promise.all(
        Array.from({ length: concurrency }, () => playMatch(url, { actionLatencies: latencies })),
      );
      const wall3 = performance.now() - t2;
      const total = results.reduce((t, r) => t + r.moves, 0);
      const s = stats(latencies);
      console.log(
        `  ${String(concurrency).padStart(3)} match(es):  ` +
          `${String(Math.round((total / wall3) * 1000)).padStart(6)} moves/sec   ` +
          `p50=${ms(s.p50).padStart(9)}  p99=${ms(s.p99).padStart(9)}   (${total} moves)`,
      );
      await sleep(50);
    }
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ main */

console.log('Splendor Duel server benchmark');
console.log(`node ${process.version} on ${process.platform}/${process.arch}, loopback sockets`);

benchEngine();
benchServerWork();
await benchOverSocket('sqlite');
await benchOverSocket('memory');

console.log('\nNotes');
console.log('  - Loopback only. Over a network the round trip is RTT plus these numbers, and RTT wins.');
console.log('  - One socket is capped at 400 actions/sec by the server\'s flood guard (ACTION_LIMIT).');
console.log('  - Sequential figures have exactly one move in flight; that is a latency measurement.');
process.exit(0);
