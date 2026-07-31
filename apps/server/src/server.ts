import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { createRequestHandler } from './http.js';
import { JsonlReplayStore, type ReplayStore } from './replay-store.js';
import { RoomRegistry } from './rooms.js';
import { resolveSecret } from './sessions.js';
import { attachSocketServer } from './socket.js';

/** Global room sweeper cadence. One timer for the whole process, never one per room. */
const SWEEP_INTERVAL_MS = 30_000;

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Absolute path to the built web app, or `null` for API + WebSocket only. */
  webRoot?: string | null;
  dataDir?: string;
  store?: ReplayStore;
  sessionSecret?: string;
  quiet?: boolean;
}

export interface RunningServer {
  http: Server;
  wss: WebSocketServer;
  rooms: RoomRegistry;
  store: ReplayStore;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? 8787;
  const store = options.store ?? new JsonlReplayStore(options.dataDir ?? 'data');
  const secret = resolveSecret(options.sessionSecret ?? process.env.SESSION_SECRET);
  const rooms = new RoomRegistry(store);
  const log = options.quiet ? () => undefined : (msg: string) => console.log(msg);

  const handler = createRequestHandler({ rooms, store, webRoot: options.webRoot ?? null });
  const http = createServer((req, res) => {
    void handler(req, res);
  });

  // `noServer` so the WebSocket shares the app's port and origin: no CORS preflight, no second TLS
  // handshake, and one thing for the user's reverse proxy to forward.
  const wss = new WebSocketServer({
    noServer: true,
    // Compression is a loss on 2-6 KB frames, and Node's zlib fragments memory under concurrency.
    perMessageDeflate: false,
    maxPayload: 256 * 1024,
  });
  const stopHeartbeat = attachSocketServer(wss, { rooms, store, secret });

  http.on('upgrade', (req, socket: Socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // Small frames, so Nagle's algorithm plus delayed ACK would add a silent ~40 ms per move.
  http.on('connection', (socket) => socket.setNoDelay(true));

  const sweeper = setInterval(() => {
    void rooms.sweep().then((removed) => {
      if (removed > 0) log(`swept ${removed} expired room(s)`);
    });
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  await new Promise<void>((done, failed) => {
    http.once('error', failed);
    http.listen(port, host, () => {
      http.off('error', failed);
      done();
    });
  });

  const address = http.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${boundPort}`;

  return {
    http,
    wss,
    rooms,
    store,
    port: boundPort,
    url,
    async close() {
      clearInterval(sweeper);
      stopHeartbeat();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((done) => wss.close(() => done()));
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}
