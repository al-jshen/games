import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatchRecord } from '@games/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlReplayStore, MemoryReplayStore, type ReplayStore } from '../src/replay-store.js';
import { SqliteReplayStore } from '../src/sqlite-store.js';

/**
 * The three stores are interchangeable behind one interface, so they get one shared suite. The
 * behaviour that matters most is the upsert: records are written after *every* move, so a store that
 * accumulated a copy per move — or that returned a stale copy — would quietly break replays.
 */

function record(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    matchId: 'm-1',
    code: 'ABC234',
    gameId: 'splendor-duel',
    seed: 'super-secret-seed-value',
    stateVersion: 1,
    options: {},
    seats: [0, 1],
    createdAt: 1_000,
    actions: [],
    ...overrides,
  };
}

function withMoves(count: number, overrides: Partial<MatchRecord> = {}): MatchRecord {
  return record({
    actions: Array.from({ length: count }, (_, i) => ({
      version: i + 1,
      seat: i % 2,
      action: { t: 'takeTokens', cells: [i % 25] },
      at: 2_000 + i,
    })),
    ...overrides,
  });
}

let dir: string;
const stores: { name: string; make: () => ReplayStore }[] = [
  { name: 'sqlite', make: () => new SqliteReplayStore(join(dir, 'games.db')) },
  { name: 'jsonl', make: () => new JsonlReplayStore(dir) },
  { name: 'memory', make: () => new MemoryReplayStore() },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'games-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

for (const { name, make } of stores) {
  describe(`${name} store`, () => {
    it('round-trips a record exactly, seed included', async () => {
      const store = make();
      const original = withMoves(5);
      await store.save(original);
      const loaded = await store.load('m-1');
      // Byte-identical: the seed is what makes the replay reproducible, so it must survive.
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(original));
      store.close?.();
    });

    it('upserts rather than accumulating, so saving every move is safe', async () => {
      const store = make();
      for (let moves = 1; moves <= 25; moves++) await store.save(withMoves(moves));

      const loaded = await store.load('m-1');
      expect(loaded?.actions).toHaveLength(25);

      // One match, however many times it was written.
      const list = await store.list();
      expect(list.filter((m) => m.matchId === 'm-1')).toHaveLength(1);
      expect(list[0]?.moves).toBe(25);
      store.close?.();
    });

    it('finds a match by code, preferring the most recent when a code is reused', async () => {
      const store = make();
      await store.save(withMoves(3, { matchId: 'old', createdAt: 1_000 }));
      await store.save(withMoves(7, { matchId: 'new', createdAt: 9_000 }));
      const found = await store.findByCode('ABC234');
      expect(found?.matchId).toBe('new');
      expect(await store.findByCode('NOPE22')).toBeNull();
      store.close?.();
    });

    it('lists most-recent-first and never includes the seed', async () => {
      const store = make();
      await store.save(withMoves(2, { matchId: 'a', code: 'AAA222', createdAt: 100 }));
      await store.save(withMoves(4, { matchId: 'b', code: 'BBB333', createdAt: 300 }));
      await store.save(withMoves(6, { matchId: 'c', code: 'CCC444', createdAt: 200 }));

      const list = await store.list();
      expect(list.map((m) => m.matchId)).toEqual(['b', 'c', 'a']);
      // This is what the HTTP list endpoint serves, so a leaked seed here would be a live-match leak.
      expect(JSON.stringify(list)).not.toContain('super-secret-seed-value');
      store.close?.();
    });

    it('reports the outcome of a finished match and nothing for one in progress', async () => {
      const store = make();
      await store.save(withMoves(10, { matchId: 'live' }));
      await store.save(
        withMoves(12, {
          matchId: 'done',
          createdAt: 5_000,
          finishedAt: 9_000,
          outcome: { status: 'over', winners: [1], reason: 'prestige', scores: [12, 21] },
        }),
      );

      const list = await store.list();
      const live = list.find((m) => m.matchId === 'live');
      const done = list.find((m) => m.matchId === 'done');
      expect(live?.finishedAt).toBeUndefined();
      expect(live?.winners).toBeUndefined();
      expect(done?.winners).toEqual([1]);
      expect(done?.reason).toBe('prestige');
      store.close?.();
    });

    it('respects the list limit', async () => {
      const store = make();
      for (let i = 0; i < 12; i++) {
        await store.save(withMoves(1, { matchId: `m-${i}`, createdAt: i * 10 }));
      }
      expect(await store.list(5)).toHaveLength(5);
      store.close?.();
    });

    it('returns null for a match it has never seen', async () => {
      const store = make();
      expect(await store.load('nope')).toBeNull();
      expect(await store.list()).toEqual([]);
      store.close?.();
    });
  });
}

describe('sqlite store durability', () => {
  it('sees records written by a previous process', async () => {
    const file = join(dir, 'games.db');
    const first = new SqliteReplayStore(file);
    await first.save(withMoves(9));
    first.close();

    // A fresh handle stands in for a restarted server.
    const second = new SqliteReplayStore(file);
    const loaded = await second.load('m-1');
    expect(loaded?.actions).toHaveLength(9);
    expect(second.count()).toBe(1);
    second.close();
  });

  it('creates its directory rather than failing on a missing path', async () => {
    const store = new SqliteReplayStore(join(dir, 'nested', 'deeper', 'games.db'));
    await store.save(withMoves(1));
    expect(await store.load('m-1')).not.toBeNull();
    store.close();
  });
});
