import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryReplayStore } from '../src/replay-store.js';
import { startServer, type RunningServer } from '../src/server.js';
import { TestClient } from './client.js';

/**
 * Taking a move back, by agreement.
 *
 * The rewind itself is the engine's business and tested there. What matters here is the negotiation
 * around it, which is where a feature like this goes wrong: an undo that one player can force, a
 * proposal that outlives the position it was made about, or a dialog left open on a screen because
 * the answer went missing.
 */

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    webRoot: null,
    store: new MemoryReplayStore(),
    sessionSecret: 'undo-secret-that-is-long-enough',
    quiet: true,
  });
});

afterAll(async () => {
  await server?.close();
});

const wsUrl = () => `${server.url.replace('http', 'ws')}/ws`;

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

/** Place a mark, waiting for the confirmation that echoes this move's own id. */
async function place(client: TestClient, expectVersion: number, cell: number, id: string) {
  client.send({ t: 'action', expectVersion, clientActionId: id, action: { t: 'place', cell } });
  return client.next('applied', (f) => f.t === 'applied' && f.clientActionId === id);
}

describe('proposing an undo', () => {
  it('asks both players, and changes nothing until the other one agrees', async () => {
    const { host, guest } = await seatedPair();
    await place(host, 0, 4, 'u1');
    await guest.next('applied');

    host.send({ t: 'undoRequest' });

    // Both sides are told, so both can show the same thing.
    const toProposer = await host.next('undoProposed');
    const toOther = await guest.next('undoProposed');
    expect(toProposer.by).toBe(0);
    expect(toOther.by).toBe(0);
    // Whose move is on the table is stated separately from who asked: either player may propose.
    expect(toOther.targetSeat).toBe(0);
    expect(toOther.atVersion).toBe(1);
    // The effects come along so each client can name the move in the game's own words.
    expect(toOther.effects.length).toBeGreaterThan(0);

    // Nothing has moved yet.
    expect((await host.resync()).snapshot.version).toBe(1);

    host.close();
    guest.close();
  });

  it('will not let the proposer agree with themselves', async () => {
    const { host, guest } = await seatedPair();
    await place(host, 0, 0, 'u2');
    await guest.next('applied');

    host.send({ t: 'undoRequest' });
    await host.next('undoProposed');
    await guest.next('undoProposed');

    // The whole point is that the other player consents; a second yes from the proposer is not that.
    host.send({ t: 'undoRespond', accept: true });
    const err = await host.next('error');
    expect(err.code).toBe('ILLEGAL_ACTION');
    expect(err.message).toMatch(/other player/i);
    expect((await host.resync()).snapshot.version).toBe(1);

    host.close();
    guest.close();
  });

  it('refuses before anything has been played', async () => {
    const { host, guest } = await seatedPair();
    host.send({ t: 'undoRequest' });
    const err = await host.next('error');
    expect(err.code).toBe('ILLEGAL_ACTION');
    expect(err.message).toMatch(/no move to undo/i);
    host.close();
    guest.close();
  });

  it('refuses a second proposal while one is still waiting', async () => {
    const { host, guest } = await seatedPair();
    await place(host, 0, 8, 'u3');
    await guest.next('applied');

    host.send({ t: 'undoRequest' });
    await host.next('undoProposed');
    await guest.next('undoProposed');

    guest.send({ t: 'undoRequest' });
    const err = await guest.next('error');
    expect(err.message).toMatch(/already waiting/i);

    host.close();
    guest.close();
  });
});

describe('settling it', () => {
  it('rewinds the board on both screens once the other player agrees', async () => {
    const { host, guest } = await seatedPair();
    const before = (await host.resync()).snapshot;
    const applied = await place(host, 0, 4, 'y1');
    await guest.next('applied');
    expect(applied.snapshot.version).toBe(1);
    expect((applied.snapshot.view as { board: unknown[] }).board[4]).toBe('x');

    host.send({ t: 'undoRequest' });
    await host.next('undoProposed');
    await guest.next('undoProposed');
    guest.send({ t: 'undoRespond', accept: true });

    // Both are told it carried, and both are re-synced from the server rather than left to guess.
    expect((await host.next('undoResolved')).accepted).toBe(true);
    expect((await guest.next('undoResolved')).accepted).toBe(true);
    const hostSync = await host.next('sync');
    const guestSync = await guest.next('sync');

    expect(hostSync.snapshot.version).toBe(0);
    expect((hostSync.snapshot.view as { board: unknown[] }).board[4]).toBeNull();
    // Byte-identical to the position before the move, because it is a replay of the same log.
    expect(JSON.stringify(hostSync.snapshot.view)).toBe(JSON.stringify(before.view));
    expect(guestSync.snapshot.version).toBe(0);
    // The move log loses the entry too, rather than showing history that no longer happened.
    expect(hostSync.log).toHaveLength(0);
    // ...and it is the original player's turn again.
    expect(hostSync.snapshot.actors).toEqual(before.actors);

    host.close();
    guest.close();
  });

  it('leaves the move alone when declined', async () => {
    const { host, guest } = await seatedPair();
    await place(host, 0, 1, 'n1');
    await guest.next('applied');

    host.send({ t: 'undoRequest' });
    await host.next('undoProposed');
    await guest.next('undoProposed');
    guest.send({ t: 'undoRespond', accept: false });

    const resolved = await host.next('undoResolved');
    expect(resolved.accepted).toBe(false);
    expect(resolved.by).toBe(1);
    expect((await host.resync()).snapshot.version).toBe(1);

    // Declining clears the proposal, so another can be made.
    host.send({ t: 'undoRequest' });
    await guest.next('undoProposed');

    host.close();
    guest.close();
  });

  it('lets the proposer withdraw', async () => {
    const { host, guest } = await seatedPair();
    await place(host, 0, 2, 'w1');
    await guest.next('applied');

    host.send({ t: 'undoRequest' });
    await guest.next('undoProposed');
    host.send({ t: 'undoRespond', accept: false });

    // The other player's dialog has to close too, or they are answering something withdrawn.
    expect((await guest.next('undoResolved')).accepted).toBe(false);
    expect((await host.resync()).snapshot.version).toBe(1);

    host.close();
    guest.close();
  });

  it('lets the game continue from the rewound position', async () => {
    const { host, guest } = await seatedPair();
    await place(host, 0, 0, 'c1');
    await guest.next('applied');
    host.send({ t: 'undoRequest' });
    await guest.next('undoProposed');
    guest.send({ t: 'undoRespond', accept: true });
    await host.next('sync');
    await guest.next('sync');

    // The same cell is free again, and the same player is to move.
    const replayed = await place(host, 0, 0, 'c2');
    expect(replayed.snapshot.version).toBe(1);
    expect((replayed.snapshot.view as { board: unknown[] }).board[0]).toBe('x');

    host.close();
    guest.close();
  });

  it('lets the very same move be replayed under the same id it was undone with', async () => {
    /*
     * The idempotency cache remembers "this id produced version N" so a retry is not applied twice.
     * After an undo that memory is a trap: replaying the stored result would hand back the undone
     * move as though it had been re-applied, so the cache is cleared when the match rewinds.
     */
    const { host, guest } = await seatedPair();
    await place(host, 0, 6, 'same-id');
    await guest.next('applied');

    host.send({ t: 'undoRequest' });
    await guest.next('undoProposed');
    guest.send({ t: 'undoRespond', accept: true });
    await host.next('undoResolved');
    await host.next('sync');
    await guest.next('sync');

    // A client that had this move pending would resend exactly this frame.
    const again = await place(host, 0, 6, 'same-id');
    expect(again.snapshot.version).toBe(1);
    expect((again.snapshot.view as { board: unknown[] }).board[6]).toBe('x');
    // Really applied, not a cached echo: the log has the move back in it.
    expect((await host.resync()).log).toHaveLength(1);

    host.close();
    guest.close();
  });

  it('un-ends a finished match when the winning move is taken back', async () => {
    const { host, guest } = await seatedPair();
    for (const [i, cell] of [0, 3, 1, 4, 2].entries()) {
      const who = i % 2 === 0 ? host : guest;
      await place(who, i, cell, `f${i}`);
    }
    const won = await host.resync();
    expect(won.snapshot.outcome.status).toBe('over');

    // The most likely moment anyone wants an undo is the one that just lost them the game.
    guest.send({ t: 'undoRequest' });
    await host.next('undoProposed');
    host.send({ t: 'undoRespond', accept: true });
    await guest.next('undoResolved');
    const after = await guest.next('sync');

    expect(after.snapshot.outcome.status).toBe('active');
    expect(after.snapshot.version).toBe(4);
    // And the match is playable again rather than stuck refusing moves as finished.
    const resumed = await place(host, 4, 8, 'f-again');
    expect(resumed.snapshot.version).toBe(5);

    host.close();
    guest.close();
  });
});

describe('proposals that should not survive', () => {
  it('is dropped when a move is made instead of an answer', async () => {
    const { host, guest } = await seatedPair();
    await place(host, 0, 4, 's1');
    await guest.next('applied');

    host.send({ t: 'undoRequest' });
    await guest.next('undoProposed');

    // Rather than answering, the opponent plays on. The proposal was about a position that no
    // longer exists, so agreeing to it later would rewind a different move than the one shown.
    await place(guest, 1, 0, 's2');
    guest.send({ t: 'undoRespond', accept: true });
    const err = await guest.next('error');
    expect(err.message).toMatch(/no undo waiting/i);
    expect((await host.resync()).snapshot.version).toBe(2);

    host.close();
    guest.close();
  });

  it('is withdrawn when the other player disconnects', async () => {
    const { host, guest } = await seatedPair();
    await place(host, 0, 4, 'd1');
    await guest.next('applied');

    host.send({ t: 'undoRequest' });
    await host.next('undoProposed');
    await guest.next('undoProposed');

    guest.close();
    // The proposer should not be left waiting on somebody who has gone.
    const resolved = await host.next('undoResolved');
    expect(resolved.accepted).toBe(false);
    expect(resolved.reason).toMatch(/disconnect/i);

    host.close();
  });

  it('cannot be answered by someone who is not in the match', async () => {
    const { host, guest } = await seatedPair();
    await place(host, 0, 4, 'x1');
    await guest.next('applied');
    host.send({ t: 'undoRequest' });
    await guest.next('undoProposed');

    const stranger = await TestClient.connect(wsUrl());
    await stranger.hello();
    stranger.send({ t: 'undoRespond', accept: true });
    expect((await stranger.next('error')).code).toBe('NOT_IN_MATCH');
    expect((await host.resync()).snapshot.version).toBe(1);
    stranger.close();

    host.close();
    guest.close();
  });
});
