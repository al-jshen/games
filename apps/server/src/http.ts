import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ErrorCodes, normalizeCode } from '@games/protocol';
import { gameCatalog } from './registry.js';
import type { RoomRegistry } from './rooms.js';
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

      const matchInfo = /^\/api\/matches\/([^/]+)$/.exec(path);
      if (matchInfo && req.method === 'GET') {
        const code = normalizeCode(matchInfo[1] ?? '');
        const room = deps.rooms.byCodeExact(code);
        if (!room) {
          json(res, 404, { code: ErrorCodes.NO_SUCH_MATCH, message: `No match with code ${code}` });
          return;
        }
        // Public info only, so the web app can prefetch the right game bundle before connecting.
        json(res, 200, {
          code: room.code,
          matchId: room.matchId,
          gameId: room.gameId,
          status: room.status,
          seatsFilled: room.seats.length,
          maxSeats: room.maxSeats,
          version: room.match.version,
        });
        return;
      }

      const replayInfo = /^\/api\/matches\/([^/]+)\/replay$/.exec(path);
      if (replayInfo && req.method === 'GET') {
        const code = normalizeCode(replayInfo[1] ?? '');
        const live = deps.rooms.byCodeExact(code);
        const record = live?.status === 'finished' ? live.match.record : await deps.store.findByCode(code);
        if (!record) {
          json(res, 404, { code: ErrorCodes.NO_SUCH_MATCH, message: 'No finished match with that code' });
          return;
        }
        // The seed is what makes a replay reproducible, but handing it out mid-match would leak
        // every future shuffle. Finished matches have nothing left to protect.
        json(res, 200, record);
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
