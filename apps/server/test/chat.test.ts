import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReplayStore } from '../src/replay-store.js';
import { SqliteReplayStore } from '../src/sqlite-store.js';
import { startServer, type RunningServer } from '../src/server.js';
import { getGame } from '../src/registry.js';
import { Room } from '../src/rooms.js';
import { TestClient } from './client.js';

/**
 * Table talk.
 *
 * Chat is stored with the match rather than held in memory, for the same reason the seating is: a
 * game can be put down and picked up days later, and a conversation that evaporated when the room
 * left memory would be stranger than one that did not. That makes durability part of the feature,
 * so these run against a real database.
 */

const SECRET = 'chat-secret-that-is-long-enough!!';

let dir: string;
let server: RunningServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'games-chat-'));
  server = await start();
});

afterEach(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

function start(): Promise<RunningServer> {
  return startServer({
    port: 0,
    host: '127.0.0.1',
    webRoot: null,
    store: new SqliteReplayStore(join(dir, 'games.db')),
    sessionSecret: SECRET,
    quiet: true,
  });
}

const store = (): ReplayStore => server.store;
const wsUrl = () => `${server.url.replace('http', 'ws')}/ws`;

async function seatedPair() {
  const host = await TestClient.connect(wsUrl());
  await host.hello();
  host.send({ t: 'create', gameId: 'tic-tac-toe', name: 'Ada' });
  const joined = await host.next('joined');

  const guest = await TestClient.connect(wsUrl());
  await guest.hello();
  guest.send({ t: 'join', code: joined.code, name: 'Grace' });
  await guest.next('joined');
  await host.next('sync', (f) => f.t === 'sync' && f.snapshot.players.length === 2);
  await guest.next('sync');
  return { host, guest, code: joined.code };
}

describe('sending a message', () => {
  it('reaches both players, attributed and timestamped', async () => {
    const { host, guest } = await seatedPair();
    const before = Date.now();
    host.send({ t: 'chat', text: 'your move' });

    const mine = await host.next('chat');
    const theirs = await guest.next('chat');
    expect(mine.message.text).toBe('your move');
    expect(mine.message.seat).toBe(0);
    expect(mine.message.name).toBe('Ada');
    expect(mine.message.at).toBeGreaterThanOrEqual(before);
    // The sender sees the same line the receiver does, ids included, so neither ends up with a
    // local copy that drifts from the other's.
    expect(theirs.message).toEqual(mine.message);

    host.close();
    guest.close();
  });

  it('numbers messages so order does not depend on clocks', async () => {
    const { host, guest } = await seatedPair();
    host.send({ t: 'chat', text: 'one' });
    await host.next('chat');
    guest.send({ t: 'chat', text: 'two' });
    const second = await host.next('chat');
    host.send({ t: 'chat', text: 'three' });
    const third = await host.next('chat');

    expect(second.message.id).toBeGreaterThan(1);
    expect(third.message.id).toBe(second.message.id + 1);

    host.close();
    guest.close();
  });

  it('collapses whitespace and drops a message with nothing in it', async () => {
    const { host, guest } = await seatedPair();
    // A wall of spaces or newlines is a cheap way to take over the other player's panel.
    host.send({ t: 'chat', text: '  hello   \n\n   there  ' });
    expect((await guest.next('chat')).message.text).toBe('hello there');

    host.send({ t: 'chat', text: '     ' });
    host.send({ t: 'chat', text: 'still here' });
    // The blank one is not delivered at all, rather than arriving as an empty bubble.
    expect((await guest.next('chat')).message.text).toBe('still here');

    host.close();
    guest.close();
  });

  it('refuses a message that is too long, at the wire, not just in the UI', async () => {
    const { host, guest } = await seatedPair();
    host.send({ t: 'chat', text: 'x'.repeat(501) });
    const err = await host.next('error');
    expect(err.code).toBe('BAD_FRAME');
    host.close();
    guest.close();
  });

  it('refuses chat from a socket that is not in a match', async () => {
    const stranger = await TestClient.connect(wsUrl());
    await stranger.hello();
    stranger.send({ t: 'chat', text: 'anyone there' });
    expect((await stranger.next('error')).code).toBe('NOT_IN_MATCH');
    stranger.close();
  });

  it('caps how fast one socket can talk', async () => {
    const { host, guest } = await seatedPair();
    for (let i = 0; i < 40; i++) host.send({ t: 'chat', text: `flood ${i}` });
    await new Promise((r) => setTimeout(r, 300));

    // Chat is not an action, so the action budget does not cover it; it needs its own stop.
    const limited = await host.next('error');
    expect(limited.code).toBe('RATE_LIMITED');
    host.close();
    guest.close();
  });
});

describe('the conversation is part of the match', () => {
  it('is handed to a client that reconnects mid-game', async () => {
    const { host, guest } = await seatedPair();
    host.send({ t: 'chat', text: 'first' });
    await guest.next('chat');
    guest.send({ t: 'chat', text: 'second' });
    await host.next('chat');

    const token = host.sessionToken!;
    host.close();
    await new Promise((r) => setTimeout(r, 40));

    // A tab that reloads has none of the history in memory; the sync has to supply it.
    const back = await TestClient.connect(wsUrl());
    expect((await back.hello(token)).resumed).toBe(true);
    const sync = await back.next('sync');
    expect(sync.chat?.map((m) => m.text)).toEqual(['first', 'second']);

    back.close();
    guest.close();
  });

  it('survives eviction and a server restart', async () => {
    const { host, guest, code } = await seatedPair();
    host.send({ t: 'chat', text: 'see you tomorrow' });
    await guest.next('chat');
    // One move, so the record is definitely written.
    host.send({ t: 'action', expectVersion: 0, clientActionId: 'm1', action: { t: 'place', cell: 0 } });
    await host.next('applied', (f) => f.t === 'applied' && f.clientActionId === 'm1');
    const token = host.sessionToken!;
    host.close();
    guest.close();
    await new Promise((r) => setTimeout(r, 60));

    await server.close();
    server = await start();
    expect(server.rooms.size).toBe(0);

    const back = await TestClient.connect(wsUrl());
    expect((await back.hello(token)).resumed).toBe(true);
    const sync = await back.next('sync');
    expect(sync.chat?.map((m) => m.text)).toEqual(['see you tomorrow']);

    // And the numbering carries on rather than repeating an id the client already has.
    back.send({ t: 'chat', text: 'morning' });
    const next = await back.next('chat');
    expect(next.message.id).toBeGreaterThan(sync.chat!.at(-1)!.id);
    expect((await store().findByCode(code))?.chat).toHaveLength(2);

    back.close();
  });

  it('is not published by the replay endpoint', async () => {
    const { host, guest, code } = await seatedPair();
    host.send({ t: 'chat', text: 'a private remark' });
    await guest.next('chat');
    for (const [i, cell] of [0, 3, 1, 4, 2].entries()) {
      const who = i % 2 === 0 ? host : guest;
      who.send({ t: 'action', expectVersion: i, clientActionId: `w${i}`, action: { t: 'place', cell } });
      await who.next('applied', (f) => f.t === 'applied' && f.clientActionId === `w${i}`);
    }
    await new Promise((r) => setTimeout(r, 60));

    const res = await fetch(`${server.url}/api/matches/${code}/replay`);
    expect(res.status).toBe(200);
    const body = await res.text();
    /*
     * The seed is fair game once a match is finished, but two people talking to each other did not
     * agree to publish it to anyone who happens to know the room code.
     */
    expect(body).not.toContain('a private remark');
    expect(JSON.parse(body).chat).toBeUndefined();
    // The stored record still has it; it is the endpoint that withholds it.
    expect((await store().findByCode(code))?.chat?.[0]?.text).toBe('a private remark');

    host.close();
    guest.close();
  });

  it('keeps only the most recent messages, so the record cannot grow without bound', () => {
    /*
     * Exercised on the room directly rather than over a socket: the cap is a property of the record,
     * and driving 250 messages through the per-second flood guard would mean a twelve-second test to
     * prove something that has nothing to do with the wire.
     */
    const mod = getGame('tic-tac-toe')!;
    const room = Room.create(mod, 'CHAT01', {}, 1_000);
    room.addSeat('Ada');
    room.addSeat('Grace');

    for (let i = 0; i < 250; i++) room.say(i % 2 === 0 ? 0 : 1, `line ${i}`, 2_000 + i);

    // The record is rewritten whole after every move, so an unbounded log would make every one of
    // those writes bigger for ever.
    expect(room.chat).toHaveLength(200);
    // The newest survive, not the oldest.
    expect(room.chat.at(-1)?.text).toBe('line 249');
    expect(room.chat[0]?.text).toBe('line 50');
    // Ids keep climbing past the window, so a client cannot confuse a new line with a dropped one.
    expect(room.chat.at(-1)?.id).toBe(250);
  });
});
