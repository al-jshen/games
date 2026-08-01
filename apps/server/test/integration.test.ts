import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replay } from '@games/engine';
import { ticTacToe } from '@games/tic-tac-toe';
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest';
import { PROTOCOL_VERSION } from '@games/protocol';
import { TestClient } from './client.js';
import { MemoryReplayStore } from '../src/replay-store.js';
import { SqliteReplayStore } from '../src/sqlite-store.js';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * End-to-end tests against a real HTTP + WebSocket server with real sockets. These cover the
 * transport-level guarantees the game engine deliberately knows nothing about: seat identity,
 * stale-version rejection, idempotency, and reconnect.
 */

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    webRoot: null,
    store: new MemoryReplayStore(),
    sessionSecret: 'test-secret-that-is-long-enough',
    quiet: true,
  });
});

afterAll(async () => {
  await server?.close();
});

const wsUrl = () => `${server.url.replace('http', 'ws')}/ws`;

/** Create a match with one client and join it with another; returns both, seated. */
async function seatedPair(gameId = 'tic-tac-toe') {
  const host = await TestClient.connect(wsUrl());
  await host.hello();
  host.send({ t: 'create', gameId, name: 'Host' });
  const joined = await host.next('joined');

  const guest = await TestClient.connect(wsUrl());
  await guest.hello();
  guest.send({ t: 'join', code: joined.code, name: 'Guest' });
  await guest.next('joined');

  // Both get a sync once the room fills.
  await host.next('sync', (f) => f.t === 'sync' && f.snapshot.players.length === 2);
  await guest.next('sync');
  return { host, guest, code: joined.code };
}

describe('handshake and lobby', () => {
  it('rejects a protocol version mismatch instead of failing mysteriously later', async () => {
    const client = await TestClient.connect(wsUrl());
    client.send({ t: 'hello', protocolVersion: PROTOCOL_VERSION + 99 });
    const err = await client.next('error');
    expect(err.code).toBe('PROTOCOL_MISMATCH');
    client.close();
  });

  it('advertises the game catalog', async () => {
    const client = await TestClient.connect(wsUrl());
    const ok = await client.hello();
    expect(ok.games.map((g) => g.id).sort()).toEqual(['splendor-duel', 'tic-tac-toe']);
    client.close();
  });

  it('creates a match, hands out a shareable code, and lets a second player in', async () => {
    const { host, guest, code } = await seatedPair();
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(host.seat).toBe(0);
    expect(guest.seat).toBe(1);
    host.close();
    guest.close();
  });

  it('accepts a lowercase, dash-separated code the way a human would paste it', async () => {
    const host = await TestClient.connect(wsUrl());
    await host.hello();
    host.send({ t: 'create', gameId: 'tic-tac-toe' });
    const joined = await host.next('joined');

    const guest = await TestClient.connect(wsUrl());
    await guest.hello();
    const sloppy = `${joined.code.slice(0, 3).toLowerCase()}-${joined.code.slice(3).toLowerCase()}`;
    guest.send({ t: 'join', code: sloppy });
    const guestJoined = await guest.next('joined');
    expect(guestJoined.code).toBe(joined.code);
    host.close();
    guest.close();
  });

  it('refuses an unknown code and a full room', async () => {
    const stranger = await TestClient.connect(wsUrl());
    await stranger.hello();
    stranger.send({ t: 'join', code: 'ZZZZZZ' });
    expect((await stranger.next('error')).code).toBe('NO_SUCH_MATCH');

    const { host, guest, code } = await seatedPair();
    stranger.send({ t: 'join', code });
    expect((await stranger.next('error')).code).toBe('MATCH_FULL');
    host.close();
    guest.close();
    stranger.close();
  });
});

describe('actions', () => {
  it('applies a legal move and tells both players', async () => {
    const { host, guest } = await seatedPair();
    host.send({ t: 'action', expectVersion: 0, clientActionId: 'a1', action: { t: 'place', cell: 4 } });

    const mine = await host.next('applied');
    expect(mine.snapshot.version).toBe(1);
    expect(mine.clientActionId).toBe('a1');
    expect((mine.snapshot.view as { board: unknown[] }).board[4]).toBe('x');

    const theirs = await guest.next('applied');
    expect(theirs.snapshot.version).toBe(1);
    // Only the submitter has a pending move to retire.
    expect(theirs.clientActionId).toBeUndefined();
    host.close();
    guest.close();
  });

  it('rejects a move from the player who is not to act', async () => {
    const { host, guest } = await seatedPair();
    guest.send({ t: 'action', expectVersion: 0, clientActionId: 'b1', action: { t: 'place', cell: 0 } });
    const rejected = await guest.next('rejected');
    expect(rejected.code).toBe('NOT_YOUR_TURN');
    // The rejection carries authoritative state, so the client heals without another round trip.
    expect(rejected.snapshot.version).toBe(0);
    host.close();
    guest.close();
  });

  it('rejects a stale expectVersion and attaches the truth', async () => {
    const { host, guest } = await seatedPair();
    host.send({ t: 'action', expectVersion: 0, clientActionId: 'c1', action: { t: 'place', cell: 0 } });
    await host.next('applied');
    await guest.next('applied');

    guest.send({ t: 'action', expectVersion: 0, clientActionId: 'c2', action: { t: 'place', cell: 1 } });
    const rejected = await guest.next('rejected');
    expect(rejected.code).toBe('STALE');
    expect(rejected.snapshot.version).toBe(1);
    host.close();
    guest.close();
  });

  it('applies a duplicate clientActionId exactly once', async () => {
    const { host, guest } = await seatedPair();
    const move = { t: 'action', expectVersion: 0, clientActionId: 'dup', action: { t: 'place', cell: 8 } };
    host.send(move);
    const first = await host.next('applied');
    expect(first.snapshot.version).toBe(1);

    // Exactly the frame a retry or a reconnect-and-resend would produce.
    host.send(move);
    const second = await host.next('applied');
    // Same version: the move was not applied a second time.
    expect(second.snapshot.version).toBe(1);
    const board = (second.snapshot.view as { board: unknown[] }).board;
    expect(board.filter((c) => c !== null)).toHaveLength(1);
    host.close();
    guest.close();
  });

  it('rejects an illegal move without disturbing the match', async () => {
    const { host, guest } = await seatedPair();
    host.send({ t: 'action', expectVersion: 0, clientActionId: 'e1', action: { t: 'place', cell: 4 } });
    await host.next('applied');
    await guest.next('applied');

    guest.send({ t: 'action', expectVersion: 1, clientActionId: 'e2', action: { t: 'place', cell: 4 } });
    const rejected = await guest.next('rejected');
    expect(rejected.code).toBe('ILLEGAL_ACTION');
    expect(rejected.snapshot.version).toBe(1);
    host.close();
    guest.close();
  });

  it('enumerates legal actions server-side for clients that cannot run the rules', async () => {
    const { host, guest } = await seatedPair();
    host.send({ t: 'legalActions' });
    const legal = await host.next('legal');
    expect(legal.actions).toHaveLength(9);
    expect(legal.truncated).toBe(false);

    guest.send({ t: 'legalActions' });
    // Not this seat's turn, so nothing is offered.
    expect((await guest.next('legal')).actions).toHaveLength(0);
    host.close();
    guest.close();
  });

  it('plays a full game through to a result', async () => {
    const { host, guest } = await seatedPair();
    // x takes the top row, o answers on the middle row: 0,3,1,4,2 -> x wins.
    const script: [TestClient, number][] = [
      [host, 0], [guest, 3], [host, 1], [guest, 4], [host, 2],
    ];
    let version = 0;
    for (const [client, cell] of script) {
      client.send({ t: 'action', expectVersion: version, clientActionId: `m${cell}`, action: { t: 'place', cell } });
      const applied = await client.next('applied', (f) => f.t === 'applied' && f.snapshot.version === version + 1);
      version = applied.snapshot.version;
    }
    const over = await host.next('over');
    expect(over.snapshot.outcome).toMatchObject({ status: 'over', winners: [0], reason: 'line' });
    host.close();
    guest.close();
  });
});

describe('reconnect', () => {
  it('restores the seat and the move log after a socket drops', async () => {
    const { host, guest } = await seatedPair();
    host.send({ t: 'action', expectVersion: 0, clientActionId: 'r1', action: { t: 'place', cell: 4 } });
    await host.next('applied');
    await guest.next('applied');

    const token = host.sessionToken!;
    host.close();

    // A page refresh: brand new socket, same token.
    const resumed = await TestClient.connect(wsUrl());
    const ok = await resumed.hello(token);
    expect(ok.resumed).toBe(true);
    const sync = await resumed.next('sync');
    expect(sync.snapshot.version).toBe(1);
    expect(sync.snapshot.players.find((p) => p.you)?.seat).toBe(0);
    // History survives, so the reconnecting client can render a move log it never saw.
    expect(sync.log).toHaveLength(1);
    expect(sync.log[0]?.effects[0]).toMatchObject({ k: 'placed', cell: 4 });

    // And the seat is genuinely usable again.
    guest.send({ t: 'action', expectVersion: 1, clientActionId: 'r2', action: { t: 'place', cell: 0 } });
    await guest.next('applied', (f) => f.t === 'applied' && f.snapshot.version === 2);
    resumed.send({ t: 'action', expectVersion: 2, clientActionId: 'r3', action: { t: 'place', cell: 1 } });
    // Match on the version: the resumed socket also receives the broadcast of the guest's move.
    const own = await resumed.next('applied', (f) => f.t === 'applied' && f.clientActionId === 'r3');
    expect(own.snapshot.version).toBe(3);

    resumed.close();
    guest.close();
  });

  it('ignores a forged or foreign session token rather than handing out a seat', async () => {
    const client = await TestClient.connect(wsUrl());
    const ok = await client.hello('bm90LWEtdG9rZW4.ZmFrZQ');
    expect(ok.resumed).toBeUndefined();
    client.send({ t: 'action', expectVersion: 0, clientActionId: 'x', action: { t: 'place', cell: 0 } });
    expect((await client.next('error')).code).toBe('NOT_IN_MATCH');
    client.close();
  });
});

describe('hidden information over the wire', () => {
  it('never ships the seed or the deck order to a Splendor Duel client', async () => {
    const { host, guest } = await seatedPair('splendor-duel');
    const sync = await host.next('sync');
    const wire = JSON.stringify(sync);

    // The engine's own tests prove redaction; this proves the transport uses it.
    const room = server.rooms.byCodeExact(sync.snapshot.code)!;
    const truth = room.match.state as { seed: string; decks: Record<string, string[]> };
    expect(wire).not.toContain(truth.seed);

    const view = sync.snapshot.view as { decks: Record<string, number>; bag: { total: number } };
    // Deck contents collapse to a count; the bag starts empty because all 25 tokens are on the board.
    expect(view.decks[1]).toBe(25);
    expect(view.bag.total).toBe(0);
    host.close();
    guest.close();
  });
});

describe('http surface', () => {
  it('reports health and a game catalog', async () => {
    const health = await fetch(`${server.url}/healthz`).then((r) => r.json());
    expect(health).toMatchObject({ ok: true });
    const games = await fetch(`${server.url}/api/games`).then((r) => r.json());
    expect(games.games.map((g: { id: string }) => g.id)).toContain('splendor-duel');
  });

  it('creates a match over plain HTTP so curl and bots need no socket', async () => {
    const res = await fetch(`${server.url}/api/matches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'splendor-duel' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    // Critically, creating a match must not hand back the shuffle seed.
    expect(JSON.stringify(body)).not.toContain('seed');

    const info = await fetch(`${server.url}/api/matches/${body.code}`).then((r) => r.json());
    expect(info).toMatchObject({ code: body.code, gameId: 'splendor-duel', seatsFilled: 0 });
  });

  it('404s an unknown game and an unknown code', async () => {
    const bad = await fetch(`${server.url}/api/matches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'chess' }),
    });
    expect(bad.status).toBe(400);
    expect((await fetch(`${server.url}/api/matches/ZZZZZZ`)).status).toBe(404);
  });
});


describe('match records survive', () => {
  /**
   * The claim under test: a match is on disk after every move, not only when it ends. Before this,
   * records were written on finish or when a room was swept, so a redeploy — routine with
   * `restart: unless-stopped` — silently discarded every game in progress.
   */
  test('an interrupted match is still on disk, and replays exactly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'games-durability-'));
    const dbFile = join(dir, 'games.db');
    let store = new SqliteReplayStore(dbFile);
    const interrupted = await startServer({
      port: 0,
      host: '127.0.0.1',
      webRoot: null,
      store,
      sessionSecret: 'durability-secret-long-enough',
      quiet: true,
    });
    const url = `${interrupted.url.replace('http', 'ws')}/ws`;

    try {
      const host = await TestClient.connect(url);
      await host.hello();
      host.send({ t: 'create', gameId: 'tic-tac-toe' });
      const joined = await host.next('joined');

      const guest = await TestClient.connect(url);
      await guest.hello();
      guest.send({ t: 'join', code: joined.code });
      await guest.next('joined');
      await host.next('sync', (f) => f.t === 'sync' && f.snapshot.players.length === 2);

      // Three moves, then walk away mid-match.
      const script: [TestClient, number][] = [[host, 0], [guest, 4], [host, 1]];
      let version = 0;
      for (const [client, cell] of script) {
        client.send({ t: 'action', expectVersion: version, clientActionId: `d${cell}`, action: { t: 'place', cell } });
        const applied = await client.next('applied', (f) => f.t === 'applied' && f.snapshot.version === version + 1);
        version = applied.snapshot.version;
      }

      // Already durable, with no shutdown and no finished match.
      const midMatch = await store.load(joined.matchId);
      expect(midMatch, 'an in-progress match should already be saved').not.toBeNull();
      expect(midMatch?.actions).toHaveLength(3);
      expect(midMatch?.outcome).toBeUndefined();

      host.close();
      guest.close();
      await interrupted.close();

      // A brand-new process reads it back and can reconstruct the position.
      store = new SqliteReplayStore(dbFile);
      const reloaded = await store.load(joined.matchId);
      expect(reloaded?.actions).toHaveLength(3);
      const { state } = replay(ticTacToe, reloaded!);
      expect(state.board.filter((c) => c !== null)).toHaveLength(3);
      expect(state.board[0]).toBe('x');
      expect(state.board[4]).toBe('o');

      // And it shows up in the listing without exposing the seed.
      const list = await store.list();
      expect(list.map((m) => m.matchId)).toContain(joined.matchId);
      expect(JSON.stringify(list)).not.toContain(reloaded!.seed);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the HTTP listing shows recent matches and never a seed', async () => {
    const res = await fetch(`${server.url}/api/matches?limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: { matchId: string; code: string; moves: number }[] };
    expect(Array.isArray(body.matches)).toBe(true);
    // Earlier tests in this file played matches, so there is something to see.
    expect(body.matches.length).toBeGreaterThan(0);
    for (const match of body.matches) {
      expect(match).not.toHaveProperty('seed');
      expect(match).not.toHaveProperty('record');
    }
  });
});
