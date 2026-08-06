import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { MatchRecord } from '@games/engine';
import { ErrorCodes, normalizeCode } from '@games/protocol';
import { gameCatalog } from './registry.js';
import { claimHoldsSeat, type RoomRegistry } from './rooms.js';
import { TRANSFER_TTL_MS, mintToken, mintTransferToken, verifyToken } from './sessions.js';
import type { ReplayStore } from './replay-store.js';

/**
 * A small HTTP surface next to the WebSocket: enough for `curl` to create a match, for a health
 * check, and to serve the built web app.
 *
 * Plain `node:http` rather than a framework — there are only a handful of routes, and keeping the
 * dependency list short matters more when the deployment target is a minimal Alpine image behind
 * someone else's reverse proxy.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface HttpDeps {
  rooms: RoomRegistry;
  store: ReplayStore;
  /** Absolute path to the built web app, or `null` to serve API only. */
  webRoot: string | null;
  /** Signs session tokens. Closing a match is authenticated with one. */
  secret: string;
}

/** A match is over when its record says so; a resident room may or may not exist either way. */
function isFinished(record: MatchRecord): boolean {
  return record.finishedAt !== undefined || record.outcome?.status === 'over';
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function serveStatic(res: ServerResponse, webRoot: string, urlPath: string): Promise<boolean> {
  // Resolve then confirm containment, so `..` cannot escape the web root.
  const requested = resolve(join(webRoot, normalize(decodeURIComponent(urlPath))));
  if (requested !== webRoot && !requested.startsWith(webRoot + sep)) return false;

  let target = requested;
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, 'index.html');
  } catch {
    return false;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) return false;
    const ext = extname(target).toLowerCase();
    // Vite emits hashed asset filenames, so those are safe to cache hard; HTML must not be.
    const immutable = target.includes(`${sep}assets${sep}`) && ext !== '.html';
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    await new Promise<void>((done, failed) => {
      createReadStream(target).on('error', failed).on('end', done).pipe(res);
    });
    return true;
  } catch {
    return false;
  }
}

export function createRequestHandler(deps: HttpDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      if (path === '/healthz') {
        json(res, 200, { ok: true, rooms: deps.rooms.size, uptime: Math.round(process.uptime()) });
        return;
      }

      if (path === '/metrics') {
        // Deliberately tiny. A slow room leak is invisible until the process runs out of memory.
        const rooms = deps.rooms.list();
        json(res, 200, {
          rooms: rooms.length,
          byStatus: {
            lobby: rooms.filter((r) => r.status === 'lobby').length,
            active: rooms.filter((r) => r.status === 'active').length,
            finished: rooms.filter((r) => r.status === 'finished').length,
          },
          connections: rooms.reduce((t, r) => t + r.seats.reduce((n, s) => n + s.sockets.size, 0), 0),
          uptimeSeconds: Math.round(process.uptime()),
          rss: process.memoryUsage().rss,
        });
        return;
      }

      if (path === '/api/games') {
        json(res, 200, { games: gameCatalog() });
        return;
      }

      // Creating over HTTP means the code exists before any socket opens, so the creator can close
      // the tab and come back — and a bot or `curl` can open a match without speaking WebSocket.
      if (path === '/api/matches' && req.method === 'POST') {
        let body: { gameId?: string; options?: unknown };
        try {
          body = (await readJsonBody(req)) as { gameId?: string; options?: unknown };
        } catch (err) {
          json(res, 400, { code: ErrorCodes.BAD_FRAME, message: (err as Error).message });
          return;
        }
        if (!body.gameId) {
          json(res, 400, { code: ErrorCodes.UNKNOWN_GAME, message: 'gameId is required' });
          return;
        }
        const created = deps.rooms.create(body.gameId, body.options);
        if (!created.ok) {
          json(res, 400, { code: created.code, message: created.message });
          return;
        }
        // No session token here: seats are claimed over the WebSocket, so a created match has no
        // occupant yet. The seed is of course never included.
        json(res, 201, {
          code: created.room.code,
          matchId: created.room.matchId,
          gameId: created.room.gameId,
        });
        return;
      }

      // Recent matches. Summaries only -- no record, so no seed.
      if (path === '/api/matches' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const matches = await deps.store.list(Number.isFinite(limit) ? limit : 50);
        json(res, 200, { matches });
        return;
      }

      /*
       * Carrying a seat to another device. Two steps on purpose.
       *
       * `/transfer` turns the session token this browser holds into a short-lived one, and that is
       * what goes in the link. `/claim` exchanges it for an ordinary session token, which is what the
       * receiving device keeps. The link therefore stops working within minutes while the device that
       * used it carries on, which matters because the link travels through a clipboard and very
       * probably a chat app.
       *
       * Both devices end up working. The seat is copied, not moved: multiple sockets per seat is
       * already how a second tab behaves, and playing on a laptop then a phone then back again is the
       * whole point.
       */
      const transferMatch = /^\/api\/matches\/([^/]+)\/transfer$/.exec(path);
      if (transferMatch && req.method === 'POST') {
        const code = normalizeCode(transferMatch[1] ?? '');
        let body: { sessionToken?: string };
        try {
          body = (await readJsonBody(req)) as { sessionToken?: string };
        } catch (err) {
          json(res, 400, { code: ErrorCodes.BAD_FRAME, message: (err as Error).message });
          return;
        }
        const claim = body.sessionToken ? verifyToken(deps.secret, body.sessionToken) : null;
        // A transfer token cannot mint another: one hop only, or the ten-minute window means nothing.
        if (!claim || claim.kind === 'transfer') {
          json(res, 401, { code: ErrorCodes.BAD_SESSION, message: 'A valid session token is required.' });
          return;
        }
        const record = await deps.rooms.recordForCode(code);
        if (!record || record.closedAt !== undefined) {
          json(res, 404, { code: ErrorCodes.NO_SUCH_MATCH, message: `No match with code ${code}` });
          return;
        }
        if (!claimHoldsSeat(record, claim)) {
          json(res, 403, { code: ErrorCodes.BAD_SESSION, message: 'You do not hold a seat in that match.' });
          return;
        }
        const now = Date.now();
        json(res, 200, {
          code,
          transferToken: mintTransferToken(deps.secret, claim, now),
          expiresAt: now + TRANSFER_TTL_MS,
        });
        return;
      }

      const claimMatch = /^\/api\/matches\/([^/]+)\/claim$/.exec(path);
      if (claimMatch && req.method === 'POST') {
        const code = normalizeCode(claimMatch[1] ?? '');
        let body: { transferToken?: string };
        try {
          body = (await readJsonBody(req)) as { transferToken?: string };
        } catch (err) {
          json(res, 400, { code: ErrorCodes.BAD_FRAME, message: (err as Error).message });
          return;
        }
        const claim = body.transferToken ? verifyToken(deps.secret, body.transferToken) : null;
        // Only a transfer token is redeemable, and `verifyToken` has already rejected an expired one.
        if (!claim || claim.kind !== 'transfer') {
          json(res, 401, {
            code: ErrorCodes.BAD_SESSION,
            message: 'That transfer link is not valid, or has expired.',
          });
          return;
        }
        const record = await deps.rooms.recordForCode(code);
        if (!record || record.closedAt !== undefined) {
          json(res, 404, { code: ErrorCodes.NO_SUCH_MATCH, message: `No match with code ${code}` });
          return;
        }
        if (!claimHoldsSeat(record, claim)) {
          json(res, 403, { code: ErrorCodes.BAD_SESSION, message: 'That seat is not in this match.' });
          return;
        }
        json(res, 200, {
          code,
          seat: claim.seat,
          gameId: record.gameId,
          // An ordinary session token: no `kind`, no expiry. This device is now seated like any other.
          sessionToken: mintToken(deps.secret, {
            matchId: claim.matchId,
            seat: claim.seat,
            playerId: claim.playerId,
            iat: Date.now(),
          }),
        });
        return;
      }

      /*
       * Called from the lobby, which holds a seat token but no socket to the room, so this is HTTP
       * rather than a frame. The token is what authorises it: a room code alone must not be enough
       * to end somebody else's game.
       */
      const closeMatch = /^\/api\/matches\/([^/]+)\/close$/.exec(path);
      if (closeMatch && req.method === 'POST') {
        const code = normalizeCode(closeMatch[1] ?? '');
        let body: { sessionToken?: string };
        try {
          body = (await readJsonBody(req)) as { sessionToken?: string };
        } catch (err) {
          json(res, 400, { code: ErrorCodes.BAD_FRAME, message: (err as Error).message });
          return;
        }
        const claim = body.sessionToken ? verifyToken(deps.secret, body.sessionToken) : null;
        if (!claim) {
          json(res, 401, { code: ErrorCodes.BAD_SESSION, message: 'A valid session token is required.' });
          return;
        }

        const result = await deps.rooms.closeMatch(code, claim);
        if (!result.ok) {
          json(res, result.code === ErrorCodes.NO_SUCH_MATCH ? 404 : 403, {
            code: result.code,
            message: result.message,
          });
          return;
        }
        json(res, 200, { code, closed: true });
        return;
      }

      const matchInfo = /^\/api\/matches\/([^/]+)$/.exec(path);
      if (matchInfo && req.method === 'GET') {
        const code = normalizeCode(matchInfo[1] ?? '');
        const room = deps.rooms.byCodeExact(code);
        if (room) {
          // Public info only, so the web app can prefetch the right game bundle before connecting.
          json(res, 200, {
            code: room.code,
            matchId: room.matchId,
            gameId: room.gameId,
            status: room.status,
            seatsFilled: room.seats.length,
            maxSeats: room.maxSeats,
            version: room.match.version,
            createdAt: room.createdAt,
            resumable: true,
          });
          return;
        }
        /*
         * Not resident, but possibly on disk. Answered from the record directly rather than by
         * rebuilding the room: this endpoint is a lookup, and letting an unauthenticated GET force
         * a replay would make it a cheap way to spend the server's CPU.
         */
        const record = await deps.store.findByCode(code);
        if (!record) {
          json(res, 404, { code: ErrorCodes.NO_SUCH_MATCH, message: `No match with code ${code}` });
          return;
        }
        if (record.closedAt !== undefined) {
          // Gone rather than missing: it existed, a player called it off, and it will not be back.
          // Distinct from 404 so a client can tell "never heard of it" from "over, forget it".
          json(res, 410, { code: ErrorCodes.MATCH_CLOSED, message: 'That match was closed.' });
          return;
        }
        json(res, 200, {
          code: record.code,
          matchId: record.matchId,
          gameId: record.gameId,
          status: record.finishedAt ? 'finished' : 'active',
          seatsFilled: record.players?.length ?? record.seats.length,
          maxSeats: record.seats.length,
          version: record.actions.at(-1)?.version ?? 0,
          createdAt: record.createdAt,
          resumable: true,
        });
        return;
      }

      const replayInfo = /^\/api\/matches\/([^/]+)\/replay$/.exec(path);
      if (replayInfo && req.method === 'GET') {
        const code = normalizeCode(replayInfo[1] ?? '');
        const live = deps.rooms.byCodeExact(code);
        const record = live?.status === 'finished' ? live.match.record : await deps.store.findByCode(code);
        /*
         * Finished matches only, and the check is on the *record* rather than on whether a room
         * happens to be resident.
         *
         * Saving after every move put every in-progress match in the store, so the earlier version
         * of this -- which only consulted `live.status` before falling through to the store -- would
         * hand out a live match's seed to anyone who knew the code. The seed is precisely what lets
         * you compute every future shuffle, so that was the whole hidden-information model gone for
         * the price of a GET.
         */
        if (!record || !isFinished(record)) {
          json(res, 404, { code: ErrorCodes.NO_SUCH_MATCH, message: 'No finished match with that code' });
          return;
        }
        /*
         * The seed is what makes a replay reproducible, and a finished match has nothing left to
         * protect. Two things are different in kind. `playerId` is what a session token is checked
         * against, so it never leaves — but the *names* beside it are not secret, both players saw
         * them all game, and a replay that says "Player 1 vs Player 2" is worse for no gain. And the
         * chat stays behind entirely: two people talking to each other did not agree to publish it
         * to anyone holding the room code.
         */
        const { players, chat: _chat, ...rest } = record;
        json(res, 200, {
          ...rest,
          ...(players ? { players: players.map((p) => ({ seat: p.seat, name: p.name })) } : {}),
        });
        return;
      }

      if (deps.webRoot && (req.method === 'GET' || req.method === 'HEAD')) {
        if (await serveStatic(res, deps.webRoot, path)) return;
        // SPA fallback: any unknown non-API path renders the app shell so /g/CODE deep links work.
        if (!path.startsWith('/api/') && (await serveStatic(res, deps.webRoot, '/index.html'))) return;
      }

      json(res, 404, { code: 'NOT_FOUND', message: `No route for ${req.method} ${path}` });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { code: ErrorCodes.INTERNAL, message: (err as Error).message });
      else res.end();
    }
  };
}
