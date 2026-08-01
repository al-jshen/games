import type { Seat } from '@games/engine';
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  normalizeCode,
  parseClientFrame,
  type ServerFrame,
} from '@games/protocol';
import type { WebSocket, WebSocketServer } from 'ws';
import { gameCatalog } from './registry.js';
import type { Connection, Room, RoomRegistry } from './rooms.js';
import type { ReplayStore } from './replay-store.js';
import { verifyToken } from './sessions.js';
import { reportStoreError } from './store-errors.js';

/** Server pings this often; also keeps proxies from reaping an idle socket mid-turn. */
const PING_INTERVAL_MS = 25_000;

interface SocketState {
  conn: Connection;
  alive: boolean;
  room: Room | null;
  seat: Seat | null;
  /** A coarse flood guard, so a runaway loop cannot wedge the process. */
  actionTimes: number[];
}

/**
 * Flood guard, per socket, per second.
 *
 * Its job is to stop a runaway loop wedging a single-threaded process, not to enforce a human pace:
 * a bot playing at full speed is an expected use. For scale, a move costs the server about 0.05ms of
 * work and 0.15ms of round trip on loopback, so even the default leaves one socket using a small
 * fraction of capacity. Raise it with `ACTION_RATE_LIMIT` if you are driving self-play over the
 * network — though for training, running the engine in-process is ~10x faster than any socket.
 */
const ACTION_WINDOW_MS = 1000;
const DEFAULT_ACTION_LIMIT = 1000;

/**
 * Resolved per server rather than once at module load. That is not only for tests: an embedder
 * starting a server should be able to set this without reaching for an environment variable.
 */
export function resolveActionLimit(configured?: number): number {
  const value = configured ?? Number(process.env.ACTION_RATE_LIMIT);
  if (!Number.isFinite(value) || (value as number) <= 0) return DEFAULT_ACTION_LIMIT;
  return Math.floor(value as number);
}

export interface SocketDeps {
  rooms: RoomRegistry;
  store: ReplayStore;
  secret: string;
  /** Actions per socket per second. Defaults to ACTION_RATE_LIMIT, then to 1000. */
  actionRateLimit?: number;
  log?: (msg: string, extra?: unknown) => void;
}

export function attachSocketServer(wss: WebSocketServer, deps: SocketDeps): () => void {
  const states = new Map<WebSocket, SocketState>();
  const actionLimit = resolveActionLimit(deps.actionRateLimit);

  /**
   * Write the room's record, without making the caller wait and without letting a store failure
   * interrupt a live game. Reported rather than swallowed: silently discarding these is how a data
   * directory that was never writable went unnoticed indefinitely.
   */
  const savePoint = (room: Room): void => {
    void room.persist(deps.store).catch((error: unknown) => {
      reportStoreError(error, `match ${room.code}`, deps.log);
    });
  };

  const send = (ws: WebSocket, frame: ServerFrame): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(frame));
  };

  const fail = (ws: WebSocket, code: string, message: string): void => {
    send(ws, { t: 'error', code, message });
  };

  /** Push the current state to every socket in the room, redacted per seat. */
  const broadcastSync = (room: Room): void => {
    for (const holder of room.seats) {
      for (const conn of holder.sockets) {
        conn.send({ t: 'sync', snapshot: room.snapshot(holder.seat), log: room.redactedLog(holder.seat) });
      }
    }
  };

  const broadcastPresence = (room: Room): void => {
    for (const holder of room.seats) {
      for (const conn of holder.sockets) {
        conn.send({ t: 'presence', players: room.players(holder.seat) });
      }
    }
  };

  /**
   * One `applied` per recipient, each with its own redacted snapshot and effects. Only the
   * submitter gets `clientActionId` echoed back, since only they have a pending move to retire.
   */
  const broadcastApplied = (room: Room, seat: Seat, effects: unknown[], clientActionId: string): void => {
    for (const holder of room.seats) {
      for (const conn of holder.sockets) {
        const frame: ServerFrame = {
          t: 'applied',
          snapshot: room.snapshot(holder.seat),
          seat,
          effects: room.redactEffects(holder.seat, effects as never) as Record<string, unknown>[],
          ...(holder.seat === seat ? { clientActionId } : {}),
        };
        conn.send(frame);
      }
    }
    if (room.status === 'finished') {
      for (const holder of room.seats) {
        for (const conn of holder.sockets) {
          conn.send({ t: 'over', snapshot: room.snapshot(holder.seat) });
        }
      }
    }
    /*
     * After *every* move, not just the last one. The store upserts on match id, so this is cheap and
     * idempotent, and it means an interrupted match is still on disk to replay.
     */
    savePoint(room);
  };

  const joinRoom = (ws: WebSocket, state: SocketState, room: Room, name: string): void => {
    const holder = room.addSeat(name);
    if (!holder) {
      fail(ws, ErrorCodes.MATCH_FULL, 'That match already has both players.');
      return;
    }
    state.room = room;
    state.seat = holder.seat;
    room.attach(holder, state.conn);
    send(ws, {
      t: 'joined',
      matchId: room.matchId,
      code: room.code,
      gameId: room.gameId,
      seat: holder.seat,
      sessionToken: room.tokenFor(holder, deps.secret),
    });
    broadcastSync(room);
    broadcastPresence(room);
    // Save on seating, not just on moving, so a match can be resumed before anyone has played. A
    // room still waiting for its second player is a no-op here.
    savePoint(room);
  };

  wss.on('connection', (ws: WebSocket) => {
    const conn: Connection = {
      send: (frame) => send(ws, frame as ServerFrame),
      close: (code, reason) => ws.close(code, reason),
    };
    const state: SocketState = { conn, alive: true, room: null, seat: null, actionTimes: [] };
    states.set(ws, state);

    ws.on('pong', () => {
      state.alive = true;
    });

    /*
     * One frame at a time, in arrival order.
     *
     * `hello` and `join` now await a possible load from disk, and a client is entitled to pipeline
     * frames without waiting for a reply -- the Python SDK and the benchmark both do. Without a
     * queue, a `join` sent immediately after a `hello` could be handled while the hello was still
     * resolving, and would be answered with "join a match first".
     */
    const handleFrame = async (raw: unknown): Promise<void> => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(String(raw));
      } catch {
        fail(ws, ErrorCodes.BAD_FRAME, 'Frames must be JSON.');
        return;
      }
      const parsed = parseClientFrame(parsedJson);
      if (!parsed.ok) {
        fail(ws, ErrorCodes.BAD_FRAME, parsed.error);
        return;
      }
      const frame = parsed.frame;

      switch (frame.t) {
        case 'hello': {
          if (frame.protocolVersion !== PROTOCOL_VERSION) {
            // Without this check a deploy silently breaks every open tab.
            send(ws, {
              t: 'error',
              code: ErrorCodes.PROTOCOL_MISMATCH,
              message: `Server speaks protocol ${PROTOCOL_VERSION}, client sent ${frame.protocolVersion}. Reload.`,
            });
            return;
          }

          let resumed = false;
          if (frame.sessionToken) {
            const claim = verifyToken(deps.secret, frame.sessionToken);
            // Resident or rebuilt from disk: a token stays good across an eviction and a restart,
            // which is what makes "close the tab and come back tomorrow" work.
            const room = claim ? await deps.rooms.resumeByMatchId(claim.matchId) : undefined;
            const holder = claim && room ? room.seatForClaim(claim) : undefined;
            if (room && holder) {
              state.room = room;
              state.seat = holder.seat;
              room.attach(holder, conn);
              resumed = true;
            }
          }

          send(ws, {
            t: 'hello_ok',
            protocolVersion: PROTOCOL_VERSION,
            serverTime: Date.now(),
            games: gameCatalog(),
            ...(resumed ? { resumed: true } : {}),
          });

          if (resumed && state.room && state.seat !== null) {
            // Reclaiming a seat: hand back the full picture, including the move log so the client
            // can render history it may never have seen.
            send(ws, {
              t: 'sync',
              snapshot: state.room.snapshot(state.seat),
              log: state.room.redactedLog(state.seat),
            });
            broadcastPresence(state.room);
          }
          return;
        }

        case 'create': {
          const created = deps.rooms.create(frame.gameId, frame.options);
          if (!created.ok) {
            fail(ws, created.code, created.message);
            return;
          }
          joinRoom(ws, state, created.room, frame.name ?? '');
          return;
        }

        case 'join': {
          const code = normalizeCode(frame.code);
          const room = await deps.rooms.resumeByCode(code);
          if (!room) {
            fail(ws, ErrorCodes.NO_SUCH_MATCH, `No match with code ${code}.`);
            return;
          }
          // Rejoining a seat you already hold is handled by `hello` + sessionToken, not here.
          joinRoom(ws, state, room, frame.name ?? '');
          return;
        }

        case 'action': {
          const { room, seat } = state;
          if (!room || seat === null) {
            fail(ws, ErrorCodes.NOT_IN_MATCH, 'Join a match first.');
            return;
          }

          const now = Date.now();
          state.actionTimes = state.actionTimes.filter((t) => now - t < ACTION_WINDOW_MS);
          if (state.actionTimes.length >= actionLimit) {
            // Reported as a rejected *action*, not a connection error: it names the action it
            // refused and carries authoritative state, so a client retries through its normal
            // error path instead of treating the socket as broken.
            send(ws, {
              t: 'rejected',
              clientActionId: frame.clientActionId,
              code: ErrorCodes.RATE_LIMITED,
              message: `More than ${actionLimit} actions in one second; retry shortly. Raise ACTION_RATE_LIMIT if this is legitimate.`,
              snapshot: room.snapshot(seat),
            });
            return;
          }
          state.actionTimes.push(now);

          // Idempotency: a double-click, a retry, or a reconnect-and-resend must not buy the same
          // card twice. Replay the stored result instead of applying again.
          const already = room.seenAction(seat, frame.clientActionId);
          if (already) {
            send(ws, {
              t: 'applied',
              snapshot: room.snapshot(seat),
              seat,
              clientActionId: frame.clientActionId,
              effects: room.redactEffects(seat, already.effects) as Record<string, unknown>[],
            });
            return;
          }

          if (frame.expectVersion !== room.match.version) {
            // The rejection carries the authoritative snapshot, so the client heals in this same
            // round trip rather than having to ask again.
            send(ws, {
              t: 'rejected',
              clientActionId: frame.clientActionId,
              code: ErrorCodes.STALE,
              message: `Version ${frame.expectVersion} is stale; the match is at ${room.match.version}.`,
              snapshot: room.snapshot(seat),
            });
            return;
          }

          const result = room.submit(seat, frame.action, frame.clientActionId);
          if (!result.ok) {
            send(ws, {
              t: 'rejected',
              clientActionId: frame.clientActionId,
              code: result.code,
              message: result.message,
              snapshot: room.snapshot(seat),
            });
            return;
          }
          broadcastApplied(room, seat, result.effects, frame.clientActionId);
          return;
        }

        case 'legalActions': {
          const { room, seat } = state;
          if (!room || seat === null) {
            fail(ws, ErrorCodes.NOT_IN_MATCH, 'Join a match first.');
            return;
          }
          // Computed server-side on request: this is what lets a Python bot play without
          // reimplementing the rules.
          const { actions, truncated } = room.mod.legalActions(room.match.state, seat) as {
            actions: unknown[];
            truncated: boolean;
          };
          send(ws, { t: 'legal', version: room.match.version, actions, truncated });
          return;
        }

        case 'resync': {
          const { room, seat } = state;
          if (!room || seat === null) {
            fail(ws, ErrorCodes.NOT_IN_MATCH, 'Join a match first.');
            return;
          }
          send(ws, { t: 'sync', snapshot: room.snapshot(seat), log: room.redactedLog(seat) });
          return;
        }

        case 'ping':
          send(ws, { t: 'pong', serverTime: Date.now() });
          return;
      }
    };

    let queue: Promise<void> = Promise.resolve();
    ws.on('message', (raw) => {
      queue = queue.then(() => handleFrame(raw)).catch((error: unknown) => {
        // A frame handler throwing must not wedge the socket's queue behind a rejected promise.
        deps.log?.(`frame handler failed: ${error instanceof Error ? error.message : String(error)}`);
        fail(ws, ErrorCodes.INTERNAL, 'The server failed to handle that frame.');
      });
    });

    ws.on('close', () => {
      states.delete(ws);
      const room = state.room;
      if (!room) return;
      room.detach(conn);
      // A dropped connection in a turn-based game is almost always a closed lid or a tunnel, so the
      // match pauses and the seat is held rather than forfeited.
      broadcastPresence(room);
    });

    ws.on('error', () => {
      states.delete(ws);
      if (state.room) state.room.detach(conn);
    });
  });

  const heartbeat = setInterval(() => {
    for (const [ws, state] of states) {
      if (!state.alive) {
        // terminate(), not close(): a half-open socket will never complete a closing handshake, and
        // leaving it attached means the opponent waits on a ghost.
        ws.terminate();
        states.delete(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);

  return () => {
    clearInterval(heartbeat);
  };
}
