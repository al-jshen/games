import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatchRecord } from '@games/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestClient } from './client.js';
import type { ReplayStore } from './../src/replay-store.js';
import { SqliteReplayStore } from '../src/sqlite-store.js';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Coming back to a game later.
 *
 * The scenario these are written against is a real one rather than an abstract one: two people are
 * mid-match, both close their browsers, and one of them opens the link again the next day — after
 * the room has been evicted from memory, and quite possibly after the server has been restarted.
 *
 * What makes that more than a cache lookup is that a resumed room has to be indistinguishable from
 * the one that was evicted. Same board, same hidden information, same move log, and the same two
 * people back in the same two seats — while still refusing a stranger who has nothing but the code.
 */

const SECRET = 'resume-secret-that-is-long-enough';

let dir: string;
let server: RunningServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'games-resume-'));
  server = await start();
});

afterEach(async () => {
  // Closing the server closes its store, which is what a real shutdown does.
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Start a server over the database in `dir`. Called more than once per test on purpose: a fresh
 * process opening the same file is exactly what a restart is, and the store handle belongs to the
 * server that owns it.
 */
function start(sessionSecret = SECRET): Promise<RunningServer> {
  return startServer({
    port: 0,
    host: '127.0.0.1',
    webRoot: null,
    store: new SqliteReplayStore(join(dir, 'games.db')),
    sessionSecret,
    quiet: true,
  });
}

/** The store belongs to the current server, so tests must not hold on to an older one. */
const store = (): ReplayStore => server.store;

const wsUrl = () => `${server.url.replace('http', 'ws')}/ws`;

/** Evict everything from memory, exactly as the sweeper would after a long idle period. */
async function evictAll(): Promise<number> {
  return server.rooms.sweep(Date.now() + 48 * 60 * 60 * 1000);
}

async function seatedPair(gameId = 'tic-tac-toe') {
  const host = await TestClient.connect(wsUrl());
  await host.hello();
  host.send({ t: 'create', gameId, name: 'Ada' });
  const joined = await host.next('joined');

  const guest = await TestClient.connect(wsUrl());
  await guest.hello();
  guest.send({ t: 'join', code: joined.code, name: 'Grace' });
  await guest.next('joined');
  await host.next('sync', (f) => f.t === 'sync' && f.snapshot.players.length === 2);
  await guest.next('sync');
  return { host, guest, code: joined.code };
}

/**
 * Play one legal move for whoever is to act, using the server's own enumeration.
 *
 * Waits for the `applied` that echoes this move's `clientActionId`, not merely the next one to
 * arrive: every seat is told about every move, so a bare wait can be satisfied by the broadcast of
 * the *opponent's* previous move and let the next `expectVersion` go out stale.
 */
async function playOne(clients: TestClient[], id: string): Promise<void> {
  for (const client of clients) {
    client.send({ t: 'legalActions' });
    const legal = await client.next('legal');
    if (legal.actions.length === 0) continue;
    client.send({
      t: 'action',
      expectVersion: legal.version,
      clientActionId: id,
      action: legal.actions[0],
    });
    await client.next('applied', (f) => f.t === 'applied' && f.clientActionId === id);
    return;
  }
  throw new Error('nobody could move');
}

describe('coming back to a match after the room is gone from memory', () => {
  it('puts both players back in their seats, mid-game, and lets them keep playing', async () => {
    const { host, guest, code } = await seatedPair();
    await playOne([host, guest], 'm1');
    await playOne([host, guest], 'm2');

    const before = (await host.resync()).snapshot;
    const hostToken = host.sessionToken!;
    const guestToken = guest.sessionToken!;
    host.close();
    guest.close();

    // The players are gone and so is the room. Only the database is left.
    await new Promise((r) => setTimeout(r, 50));
    expect(await evictAll()).toBe(1);
    expect(server.rooms.size).toBe(0);

    const hostBack = await TestClient.connect(wsUrl());
    const resumed = await hostBack.hello(hostToken);
    expect(resumed.resumed, 'the token should be honoured against a room rebuilt from disk').toBe(true);

    const after = (await hostBack.next('sync')).snapshot;
    // Not "close enough": the same board, down to the byte. Version, actors and outcome included.
    expect(JSON.stringify(after.view)).toBe(JSON.stringify(before.view));
    expect(after.version).toBe(before.version);
    expect(after.actors).toEqual(before.actors);
    expect(after.matchId).toBe(before.matchId);
    expect(after.code).toBe(code);
    // ...and the same people, with the seat you had before, not just any free one.
    expect(after.players.map((p) => p.name)).toEqual(['Ada', 'Grace']);
    expect(after.players.find((p) => p.you)?.seat).toBe(0);

    // The other player comes back too, and the game carries on.
    const guestBack = await TestClient.connect(wsUrl());
    expect((await guestBack.hello(guestToken)).resumed).toBe(true);
    await guestBack.next('sync');
    await playOne([hostBack, guestBack], 'm3');
    expect((await hostBack.resync()).snapshot.version).toBe(before.version + 1);

    hostBack.close();
    guestBack.close();
  });

  it('survives a server restart, which is the same thing from the players’ side', async () => {
    const { host, guest } = await seatedPair();
    await playOne([host, guest], 'm1');
    const hostToken = host.sessionToken!;
    const before = (await host.resync()).snapshot;
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 50));

    // Stop the process entirely and start a fresh one over the same database. Tokens are HMACs
    // rather than rows in a session table, so a restart with the same secret keeps them valid.
    await server.close();
    server = await start();
    expect(server.rooms.size).toBe(0);

    const back = await TestClient.connect(wsUrl());
    expect((await back.hello(hostToken)).resumed).toBe(true);
    const after = (await back.next('sync')).snapshot;
    expect(JSON.stringify(after.view)).toBe(JSON.stringify(before.view));
    expect(after.version).toBe(before.version);
    back.close();
  });

  it('brings the move log back with it, not just the board', async () => {
    const { host, guest } = await seatedPair();
    await playOne([host, guest], 'm1');
    await playOne([host, guest], 'm2');
    await playOne([host, guest], 'm3');
    const before = await host.resync();
    const token = host.sessionToken!;
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 50));
    await evictAll();

    const back = await TestClient.connect(wsUrl());
    await back.hello(token);
    const after = await back.resync();
    // The log is rebuilt from the replay's effects, so history reads the same as before the break.
    expect(JSON.stringify(after.log)).toBe(JSON.stringify(before.log));
    expect(after.log?.length).toBe(3);
    back.close();
  });

  it('resumes a match nobody had moved in yet', async () => {
    // Persisting only on the first move would leave a gap where you can resume a game you have
    // played one move of, but not one you have played none of.
    const { host, guest, code } = await seatedPair();
    const token = host.sessionToken!;
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await evictAll()).toBe(1);

    const back = await TestClient.connect(wsUrl());
    expect((await back.hello(token)).resumed).toBe(true);
    const snap = (await back.next('sync')).snapshot;
    expect(snap.code).toBe(code);
    expect(snap.version).toBe(0);
    expect(snap.players).toHaveLength(2);
    back.close();
  });

  it('restores a finished match, so the result is still there tomorrow', async () => {
    const { host, guest } = await seatedPair();
    // Tic-tac-toe: 0,3,1,4,2 is a win for seat 0 on the top row.
    for (const [i, cell] of [0, 3, 1, 4, 2].entries()) {
      const who = i % 2 === 0 ? host : guest;
      who.send({ t: 'action', expectVersion: i, clientActionId: `w${i}`, action: { t: 'place', cell } });
      await who.next('applied', (f) => f.t === 'applied' && f.clientActionId === `w${i}`);
    }
    const token = host.sessionToken!;
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 50));
    await evictAll();

    const back = await TestClient.connect(wsUrl());
    await back.hello(token);
    const snap = (await back.next('sync')).snapshot;
    expect(snap.outcome.status).toBe('over');
    expect(snap.outcome.status === 'over' && snap.outcome.winners).toEqual([0]);
    back.close();
  });
});

describe('Splendor Duel, where the state is big and half of it is secret', () => {
  /** Play until a card has been reserved face-down, so there is real hidden information around. */
  async function playUntilReserved(clients: TestClient[]): Promise<number> {
    for (let move = 0; move < 40; move++) {
      for (const client of clients) {
        client.send({ t: 'legalActions' });
        const legal = await client.next('legal');
        if (legal.actions.length === 0) continue;
        // Prefer reserving from a deck: that is the one card the opponent must never see.
        const hidden = legal.actions.find((a) => {
          const candidate = a as { t?: string; from?: { t?: string } };
          return candidate.t === 'reserve' && candidate.from?.t === 'deck';
        });
        const action = hidden ?? legal.actions[0];
        const id = `s${move}`;
        client.send({ t: 'action', expectVersion: legal.version, clientActionId: id, action });
        await client.next('applied', (f) => f.t === 'applied' && f.clientActionId === id);
        if (hidden) return move;
        break;
      }
    }
    throw new Error('no reserve-from-deck came up');
  }

  it('rebuilds both players’ views byte for byte, secrets still secret', async () => {
    const { host, guest } = await seatedPair('splendor-duel');
    await playUntilReserved([host, guest]);

    const beforeHost = (await host.resync()).snapshot;
    const beforeGuest = (await guest.resync()).snapshot;
    const hostToken = host.sessionToken!;
    const guestToken = guest.sessionToken!;
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 50));
    await evictAll();

    const hostBack = await TestClient.connect(wsUrl());
    await hostBack.hello(hostToken);
    const afterHost = (await hostBack.next('sync')).snapshot;
    const guestBack = await TestClient.connect(wsUrl());
    await guestBack.hello(guestToken);
    const afterGuest = (await guestBack.next('sync')).snapshot;

    /*
     * A replayed state is regenerated from the seed, so the deck order, the bag and the reserved
     * card all have to come back the same -- and then be redacted the same way. Byte equality of
     * both views is the strongest statement available: it covers the board, both tableaux, the
     * hidden card, and the fact that the opponent still cannot see it.
     */
    expect(JSON.stringify(afterHost.view)).toBe(JSON.stringify(beforeHost.view));
    expect(JSON.stringify(afterGuest.view)).toBe(JSON.stringify(beforeGuest.view));
    // Sanity: the two seats really are seeing different things, or the above proves little.
    expect(JSON.stringify(afterHost.view)).not.toBe(JSON.stringify(afterGuest.view));

    // And the game is still playable from here.
    await playOne([hostBack, guestBack], 'after-resume');
    hostBack.close();
    guestBack.close();
  });
});

describe('a resumed match is not an open door', () => {
  it('refuses someone who has the code but never had a seat', async () => {
    const { host, guest, code } = await seatedPair();
    await playOne([host, guest], 'm1');
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 50));
    await evictAll();

    // The room is rebuilt on demand for this stranger -- and it is rebuilt full.
    const stranger = await TestClient.connect(wsUrl());
    await stranger.hello();
    stranger.send({ t: 'join', code, name: 'Mallory' });
    const err = await stranger.next('error');
    expect(err.code).toBe('MATCH_FULL');
    stranger.close();
  });

  it('refuses a token signed with a different secret', async () => {
    const { host, guest } = await seatedPair();
    await playOne([host, guest], 'm1');
    const token = host.sessionToken!;
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 50));
    await server.close();

    // A restart that forgot to set SESSION_SECRET, or an outright forgery.
    server = await start('a-completely-different-secret-value');
    const back = await TestClient.connect(wsUrl());
    expect((await back.hello(token)).resumed).toBeUndefined();
    back.close();
  });

  it('rebuilds the match exactly once when both players come back at the same instant', async () => {
    const { host, guest, code } = await seatedPair();
    await playOne([host, guest], 'm1');
    const hostToken = host.sessionToken!;
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 50));
    await evictAll();

    /*
     * Two different lookup keys for one match -- one by token, one by code -- raced deliberately.
     * Two rooms here would mean two truth states: the second to be registered wins the code, and
     * the loser's players go on playing into a room nobody else can see.
     */
    const [byToken, byCode] = await Promise.all([
      server.rooms.resumeByMatchId(JSON.parse(Buffer.from(hostToken.split('.')[0]!, 'base64url').toString()).matchId),
      server.rooms.resumeByCode(code),
    ]);
    expect(byToken).toBeDefined();
    expect(byToken).toBe(byCode);
    expect(server.rooms.size).toBe(1);
  });

  it('will not resume a record whose rules have since changed', async () => {
    const { host, guest, code } = await seatedPair();
    await playOne([host, guest], 'm1');
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 50));
    await evictAll();

    // Bump the recorded state version, standing in for a rules change that would make the stored
    // actions replay into a different board.
    const record = (await store().findByCode(code))!;
    await store().save({ ...record, stateVersion: record.stateVersion + 41 });

    expect(await server.rooms.resumeByCode(code)).toBeUndefined();
    // Better to say "no such match" than to hand back a plausible, wrong position.
    const client = await TestClient.connect(wsUrl());
    await client.hello();
    client.send({ t: 'join', code });
    expect((await client.next('error')).code).toBe('NO_SUCH_MATCH');
    client.close();
  });

  it('holds the seats of a record written before seat identities were saved, but still lets its owner in', async () => {
    const { host, guest, code } = await seatedPair();
    await playOne([host, guest], 'm1');
    const token = host.sessionToken!;
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 50));
    await evictAll();

    // Exactly what an upgrade finds on disk: a match in progress, recorded without `players`.
    const record = (await store().findByCode(code))!;
    const { players: _dropped, ...legacy } = record;
    expect(_dropped).toBeDefined();
    await store().save(legacy as MatchRecord);

    // A stranger with the code still cannot sit down...
    const stranger = await TestClient.connect(wsUrl());
    await stranger.hello();
    stranger.send({ t: 'join', code, name: 'Mallory' });
    expect((await stranger.next('error')).code).toBe('MATCH_FULL');
    stranger.close();

    // ...but the signed token is proof enough that this server issued that seat.
    const back = await TestClient.connect(wsUrl());
    expect((await back.hello(token)).resumed).toBe(true);
    expect((await back.next('sync')).snapshot.players.find((p) => p.you)?.seat).toBe(0);
    back.close();
  });
});

describe('what the match endpoints will tell you', () => {
  it('never serves the seed of a match still being played', async () => {
    const { host, guest, code } = await seatedPair('splendor-duel');
    await playOne([host, guest], 'm1');

    /*
     * Regression test for a real leak. Records are saved after every move, so an in-progress match
     * is in the store; the endpoint checked whether a *room* was finished and otherwise fell
     * through to the store, which handed the live seed to anyone holding the code. The seed is what
     * generates every future shuffle, so it is the one field that must never go out early.
     */
    const live = await fetch(`${server.url}/api/matches/${code}/replay`);
    expect(live.status).toBe(404);
    expect(JSON.stringify(await live.json())).not.toContain('seed');

    host.close();
    guest.close();
  });

  it('serves a finished match without the seat identities', async () => {
    const { host, guest, code } = await seatedPair();
    for (const [i, cell] of [0, 3, 1, 4, 2].entries()) {
      const who = i % 2 === 0 ? host : guest;
      who.send({ t: 'action', expectVersion: i, clientActionId: `w${i}`, action: { t: 'place', cell } });
      await who.next('applied', (f) => f.t === 'applied' && f.clientActionId === `w${i}`);
    }
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`${server.url}/api/matches/${code}/replay`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MatchRecord & { players?: unknown };
    // The seed is fine now: there is nothing left to predict.
    expect(body.seed).toBeTruthy();
    expect(body.actions).toHaveLength(5);
    // A playerId is what a session token is checked against, so it stays in the server.
    expect(body.players).toBeUndefined();
    const record = (await store().findByCode(code))!;
    expect(JSON.stringify(body)).not.toContain(record.players![0]!.playerId);

    host.close();
    guest.close();
  });

  it('finds a match that is only on disk, so a returning tab knows which game to load', async () => {
    const { host, guest, code } = await seatedPair('splendor-duel');
    await playOne([host, guest], 'm1');
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 50));
    await evictAll();

    const res = await fetch(`${server.url}/api/matches/${code}`);
    expect(res.status).toBe(200);
    const info = (await res.json()) as Record<string, unknown>;
    expect(info.gameId).toBe('splendor-duel');
    expect(info.resumable).toBe(true);
    expect(info.seatsFilled).toBe(2);
    // Looking a match up must not rebuild it: an unauthenticated GET should not be able to make
    // the server replay an arbitrary number of moves.
    expect(server.rooms.size).toBe(0);
    expect(JSON.stringify(info)).not.toContain('seed');
  });
});

describe('frame ordering', () => {
  it('handles a pipelined hello and join in the order they were sent', async () => {
    // Resuming made two frame handlers asynchronous. A client that does not wait for `hello_ok`
    // before sending `join` -- the Python SDK and the benchmark both do this -- would otherwise be
    // told to join a match first.
    const host = await TestClient.connect(wsUrl());
    await host.hello();
    host.send({ t: 'create', gameId: 'tic-tac-toe', name: 'Ada' });
    const { code } = await host.next('joined');

    const client = await TestClient.connect(wsUrl());
    client.send({ t: 'hello', protocolVersion: 1 });
    client.send({ t: 'join', code, name: 'Pipelined' });
    const joined = await client.next('joined');
    expect(joined.code).toBe(code);
    expect(joined.seat).toBe(1);
    client.close();
    host.close();
  });
});
