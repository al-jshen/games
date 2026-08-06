import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteReplayStore } from '../src/sqlite-store.js';
import { startServer, type RunningServer } from '../src/server.js';
import { TRANSFER_TTL_MS, mintTransferToken, verifyToken } from '../src/sessions.js';
import { TestClient } from './client.js';

/**
 * Carrying a seat to a second device.
 *
 * A seat lives in one browser's storage, which is why the resumable list only ever knows about that
 * browser. The way out is a link — and a link is a bearer credential that travels through a clipboard
 * and probably a chat app, so the interesting behaviour is not "does it work" but what it refuses:
 * it must expire, it must not itself be usable to play, and it must not mint another.
 */

const SECRET = 'transfer-secret-long-enough-here';

let dir: string;
let server: RunningServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'games-transfer-'));
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    webRoot: null,
    store: new SqliteReplayStore(join(dir, 'games.db')),
    sessionSecret: SECRET,
    quiet: true,
  });
});

afterEach(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

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

const post = (path: string, body: unknown) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('handing a seat to another device', () => {
  it('lets the second device play, without unseating the first', async () => {
    const { host, guest, code } = await seatedPair();

    const minted = await post(`/api/matches/${code}/transfer`, { sessionToken: host.sessionToken });
    expect(minted.status).toBe(200);
    const { transferToken, expiresAt } = (await minted.json()) as { transferToken: string; expiresAt: number };
    expect(expiresAt).toBeGreaterThan(Date.now());

    const redeemed = await post(`/api/matches/${code}/claim`, { transferToken });
    expect(redeemed.status).toBe(200);
    const claimed = (await redeemed.json()) as { sessionToken: string; seat: number; gameId: string };
    expect(claimed.seat).toBe(0);
    expect(claimed.gameId).toBe('tic-tac-toe');

    // The phone takes the same seat.
    const phone = await TestClient.connect(wsUrl());
    expect((await phone.hello(claimed.sessionToken)).resumed).toBe(true);
    const sync = await phone.next('sync');
    expect(sync.snapshot.players.find((p) => p.you)?.seat).toBe(0);

    // It can act...
    phone.send({ t: 'action', expectVersion: 0, clientActionId: 'p1', action: { t: 'place', cell: 4 } });
    await phone.next('applied', (f) => f.t === 'applied' && f.clientActionId === 'p1');

    /*
     * ...and the laptop is still seated. The seat is copied, not moved: a second socket on one seat
     * is already how a second tab behaves, and playing on a laptop then a phone then back again is
     * the entire point of this.
     */
    const stillThere = await host.resync();
    expect(stillThere.snapshot.players.find((p) => p.you)?.seat).toBe(0);
    expect(stillThere.snapshot.version).toBe(1);

    host.close();
    guest.close();
    phone.close();
  });

  it('will not accept a transfer token as a way to play', async () => {
    const { host, guest, code } = await seatedPair();
    const minted = await post(`/api/matches/${code}/transfer`, { sessionToken: host.sessionToken });
    const { transferToken } = (await minted.json()) as { transferToken: string };

    /*
     * The link travels through a clipboard and probably a chat app. If presenting it were enough to
     * sit down, the ten-minute window would be decoration: whoever saw the message would have a
     * permanent way in. It has to be exchanged for a session token first.
     */
    const direct = await TestClient.connect(wsUrl());
    expect((await direct.hello(transferToken)).resumed).toBeUndefined();
    direct.close();

    host.close();
    guest.close();
  });

  it('will not let a transfer token mint another', async () => {
    const { host, guest, code } = await seatedPair();
    const minted = await post(`/api/matches/${code}/transfer`, { sessionToken: host.sessionToken });
    const { transferToken } = (await minted.json()) as { transferToken: string };

    // Otherwise the expiry could be renewed indefinitely from a single leaked link.
    const again = await post(`/api/matches/${code}/transfer`, { sessionToken: transferToken });
    expect(again.status).toBe(401);

    host.close();
    guest.close();
  });

  it('stops working once it has expired', async () => {
    const { host, guest, code } = await seatedPair();
    const claim = verifyToken(SECRET, host.sessionToken!)!;

    // Minted as if it were issued long enough ago to have lapsed.
    const stale = mintTransferToken(SECRET, claim, Date.now() - TRANSFER_TTL_MS - 1000);
    const res = await post(`/api/matches/${code}/claim`, { transferToken: stale });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toMatch(/expired/i);

    // The signature was never the problem: an unexpired one from the same seat works.
    const fresh = mintTransferToken(SECRET, claim);
    expect((await post(`/api/matches/${code}/claim`, { transferToken: fresh })).status).toBe(200);

    host.close();
    guest.close();
  });

  it('refuses an ordinary session token at the redeem endpoint', async () => {
    const { host, guest, code } = await seatedPair();
    // Not redeemable: only the marked, expiring kind is, which is what keeps the two roles distinct.
    const res = await post(`/api/matches/${code}/claim`, { transferToken: host.sessionToken });
    expect(res.status).toBe(401);
    host.close();
    guest.close();
  });

  it('refuses a seat from a different match', async () => {
    const first = await seatedPair();
    const second = await seatedPair();
    const minted = await post(`/api/matches/${first.code}/transfer`, { sessionToken: first.host.sessionToken });
    const { transferToken } = (await minted.json()) as { transferToken: string };

    const res = await post(`/api/matches/${second.code}/claim`, { transferToken });
    expect(res.status).toBe(403);

    first.host.close();
    first.guest.close();
    second.host.close();
    second.guest.close();
  });

  it('refuses once the match has been closed', async () => {
    const { host, guest, code } = await seatedPair();
    const token = host.sessionToken!;
    await post(`/api/matches/${code}/close`, { sessionToken: token });

    expect((await post(`/api/matches/${code}/transfer`, { sessionToken: token })).status).toBe(404);
    host.close();
    guest.close();
  });

  it('needs a real token, not just the room code', async () => {
    const { host, guest, code } = await seatedPair();
    expect((await post(`/api/matches/${code}/transfer`, {})).status).toBe(401);
    expect((await post(`/api/matches/${code}/transfer`, { sessionToken: 'forged' })).status).toBe(401);
    expect((await post(`/api/matches/${code}/claim`, { transferToken: 'forged' })).status).toBe(401);
    host.close();
    guest.close();
  });
});
