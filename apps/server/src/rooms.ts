import { randomBytes } from 'node:crypto';
import {
  createMatch,
  step,
  type AnyGameModule,
  type Effect,
  type LiveMatch,
  type Outcome,
  type Seat,
} from '@games/engine';
import { ErrorCodes, type LogEntry, type PlayerInfo, type Snapshot } from '@games/protocol';
import { generateCode } from './codes.js';
import { getGame } from './registry.js';
import { mintToken, newPlayerId, type SessionClaim } from './sessions.js';
import type { ReplayStore } from './replay-store.js';

/** How long a room with no second player survives. Long enough to paste a code into chat. */
const LOBBY_TTL_MS = 30 * 60 * 1000;
/** How long an active match survives with nobody connected. Resumable from disk afterwards. */
const ABANDONED_TTL_MS = 60 * 60 * 1000;
/** How long a finished match stays in memory, for the post-game screen and a rematch. */
const FINISHED_TTL_MS = 10 * 60 * 1000;
/** Bound on remembered idempotency keys per seat. */
const DEDUPE_LIMIT = 64;

export interface Connection {
  send(frame: unknown): void;
  close(code?: number, reason?: string): void;
}

interface Seatholder {
  seat: Seat;
  name: string;
  playerId: string;
  /** Multiple sockets per seat is allowed: it makes refresh races a non-issue. */
  sockets: Set<Connection>;
}

interface AppliedResult {
  version: number;
  effects: Effect[];
}

export type RoomStatus = 'lobby' | 'active' | 'finished';

export class Room {
  readonly matchId: string;
  readonly code: string;
  readonly gameId: string;
  readonly mod: AnyGameModule;
  match: LiveMatch<unknown>;
  readonly seats: Seatholder[] = [];
  readonly maxSeats: number;
  /** Truth effects, redacted per recipient on the way out. Powers the move log and replays. */
  readonly log: { version: number; seat: Seat; effects: Effect[] }[] = [];
  private readonly dedupe = new Map<string, AppliedResult>();
  status: RoomStatus = 'lobby';
  lastActivity = Date.now();
  createdAt = Date.now();
  private persisted = false;

  constructor(mod: AnyGameModule, code: string, options: unknown, now: number) {
    this.mod = mod;
    this.gameId = mod.id;
    this.code = code;
    this.matchId = randomBytes(12).toString('base64url');
    this.maxSeats = mod.meta.maxPlayers;
    const seats: Seat[] = Array.from({ length: this.maxSeats }, (_, i) => i);
    this.match = createMatch(mod as never, {
      matchId: this.matchId,
      code,
      // The seed is generated here and never leaves the server. Anyone holding it could compute
      // every future shuffle.
      seed: randomBytes(16).toString('base64url'),
      seats,
      options: options as never,
      now,
    });
  }

  get full(): boolean {
    return this.seats.length >= this.maxSeats;
  }

  get connectedCount(): number {
    return this.seats.reduce((t, s) => t + (s.sockets.size > 0 ? 1 : 0), 0);
  }

  outcome(): Outcome {
    return this.mod.outcome(this.match.state) as Outcome;
  }

  /** Claim the next free seat. Returns `null` when the room is full. */
  addSeat(name: string): Seatholder | null {
    if (this.full) return null;
    const seat = this.seats.length as Seat;
    const holder: Seatholder = {
      seat,
      name: name.trim().slice(0, 32) || `Player ${seat + 1}`,
      playerId: newPlayerId(),
      sockets: new Set(),
    };
    this.seats.push(holder);
    if (this.full) this.status = 'active';
    this.lastActivity = Date.now();
    return holder;
  }

  seatAt(seat: Seat): Seatholder | undefined {
    return this.seats.find((s) => s.seat === seat);
  }

  /** Validate a session claim against this room's actual seat, not against the wire's word for it. */
  seatForClaim(claim: SessionClaim): Seatholder | undefined {
    if (claim.matchId !== this.matchId) return undefined;
    const holder = this.seatAt(claim.seat as Seat);
    return holder && holder.playerId === claim.playerId ? holder : undefined;
  }

  tokenFor(holder: Seatholder, secret: string): string {
    return mintToken(secret, {
      matchId: this.matchId,
      seat: holder.seat,
      playerId: holder.playerId,
      iat: Date.now(),
    });
  }

  attach(holder: Seatholder, conn: Connection): void {
    holder.sockets.add(conn);
    this.lastActivity = Date.now();
  }

  detach(conn: Connection): void {
    for (const holder of this.seats) holder.sockets.delete(conn);
    this.lastActivity = Date.now();
  }

  players(viewer: Seat | null): PlayerInfo[] {
    return this.seats.map((s) => ({
      seat: s.seat,
      name: s.name,
      connected: s.sockets.size > 0,
      you: s.seat === viewer,
    }));
  }

  /**
   * The wire view for one viewer. `redactFor` is the only path from truth state to a client, and
   * `Redacted<T>` makes that a compile-time guarantee rather than a convention.
   */
  snapshot(viewer: Seat | null): Snapshot {
    return {
      matchId: this.matchId,
      code: this.code,
      gameId: this.gameId,
      version: this.match.version,
      view: this.mod.redactFor(viewer, this.match.state),
      actors: this.mod.currentActors(this.match.state) as Seat[],
      outcome: this.outcome() as Snapshot['outcome'],
      players: this.players(viewer),
    };
  }

  redactedLog(viewer: Seat | null): LogEntry[] {
    return this.log.map((entry) => ({
      version: entry.version,
      seat: entry.seat,
      effects: this.redactEffects(viewer, entry.effects),
    }));
  }

  redactEffects(viewer: Seat | null, effects: Effect[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const effect of effects) {
      const redacted = this.mod.redactEffect(viewer, effect, this.match.state) as Effect | null;
      if (redacted) out.push(redacted as Record<string, unknown>);
    }
    return out;
  }

  /** A previously applied action with this idempotency key, if any. */
  seenAction(seat: Seat, clientActionId: string): AppliedResult | undefined {
    return this.dedupe.get(`${seat}:${clientActionId}`);
  }

  private remember(seat: Seat, clientActionId: string, result: AppliedResult): void {
    const key = `${seat}:${clientActionId}`;
    this.dedupe.set(key, result);
    // Insertion-ordered, so the oldest keys are the first ones out.
    while (this.dedupe.size > DEDUPE_LIMIT * this.maxSeats) {
      const oldest = this.dedupe.keys().next().value;
      if (oldest === undefined) break;
      this.dedupe.delete(oldest);
    }
  }

  /**
   * Apply one action. The seat is passed in from the authenticated session; it is never read off
   * the wire, and it is re-checked against `currentActors` inside the engine's `step`.
   */
  submit(
    seat: Seat,
    action: unknown,
    clientActionId: string,
  ): { ok: true; effects: Effect[] } | { ok: false; code: string; message: string } {
    const result = step(this.mod as never, this.match as never, seat, action, Date.now());
    if (!result.ok) {
      return { ok: false, code: result.error.code, message: result.error.message };
    }
    this.match = result.match as LiveMatch<unknown>;
    this.log.push({ version: this.match.version, seat, effects: result.effects });
    this.remember(seat, clientActionId, { version: this.match.version, effects: result.effects });
    this.lastActivity = Date.now();
    if (result.outcome.status === 'over') this.status = 'finished';
    return { ok: true, effects: result.effects };
  }

  async persist(store: ReplayStore): Promise<void> {
    if (this.persisted && this.status !== 'finished') return;
    this.persisted = true;
    await store.save(this.match.record);
  }

  /** Has this room outlived its usefulness? */
  expired(now: number): boolean {
    const idle = now - this.lastActivity;
    if (this.status === 'finished') return idle > FINISHED_TTL_MS;
    if (this.status === 'lobby') return idle > LOBBY_TTL_MS;
    return this.connectedCount === 0 && idle > ABANDONED_TTL_MS;
  }

  dispose(): void {
    for (const holder of this.seats) {
      for (const conn of holder.sockets) conn.close(1001, 'room closed');
      holder.sockets.clear();
    }
  }
}

export class RoomRegistry {
  private readonly byCode = new Map<string, Room>();
  private readonly byMatchId = new Map<string, Room>();

  constructor(private readonly store: ReplayStore) {}

  create(gameId: string, options: unknown): { ok: true; room: Room } | { ok: false; code: string; message: string } {
    const mod = getGame(gameId);
    if (!mod) return { ok: false, code: ErrorCodes.UNKNOWN_GAME, message: `No such game: ${gameId}` };

    const parsed = mod.optionsValidator.validate(options ?? {});
    if (!parsed.ok) {
      return { ok: false, code: ErrorCodes.BAD_ACTION, message: `Bad options: ${parsed.error}` };
    }

    // Generate and reserve in one synchronous block — no await in between, or two creates could
    // race onto the same code.
    const code = generateCode((c) => this.byCode.has(c));
    let room: Room;
    try {
      room = new Room(mod, code, parsed.value, Date.now());
    } catch (err) {
      return { ok: false, code: ErrorCodes.INTERNAL, message: (err as Error).message };
    }
    this.byCode.set(code, room);
    this.byMatchId.set(room.matchId, room);
    return { ok: true, room };
  }

  byCodeExact(code: string): Room | undefined {
    return this.byCode.get(code);
  }

  get(matchId: string): Room | undefined {
    return this.byMatchId.get(matchId);
  }

  get size(): number {
    return this.byCode.size;
  }

  list(): Room[] {
    return [...this.byCode.values()];
  }

  /**
   * One global sweeper rather than a timer per room. Per-room intervals are the classic source of
   * leaks and of callbacks firing on disposed objects.
   */
  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const room of [...this.byCode.values()]) {
      if (!room.expired(now)) continue;
      if (room.match.record.actions.length > 0) {
        try {
          await room.persist(this.store);
        } catch {
          // Losing a replay must never take the server down.
        }
      }
      room.dispose();
      this.byCode.delete(room.code);
      this.byMatchId.delete(room.matchId);
      removed += 1;
    }
    return removed;
  }
}
