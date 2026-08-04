import { randomBytes } from 'node:crypto';
import {
  createMatch,
  replay,
  step,
  undoLast,
  type AnyGameModule,
  type ChatMessage,
  type Effect,
  type LiveMatch,
  type MatchRecord,
  type Outcome,
  type Seat,
} from '@games/engine';
import { ErrorCodes, type LogEntry, type PlayerInfo, type Snapshot } from '@games/protocol';
import { generateCode } from './codes.js';
import { getGame } from './registry.js';
import { mintToken, newPlayerId, type SessionClaim } from './sessions.js';
import type { ReplayStore } from './replay-store.js';
import { reportStoreError, type Logger } from './store-errors.js';

/**
 * Eviction timings. These bound *memory*, not the life of a match: an evicted match with at least
 * one move is on disk and is rebuilt on demand the moment somebody asks for it again, so the only
 * thing a sweep costs is the replay to get back.
 *
 * A lobby nobody joined is the exception. It was never persisted — there is nothing in it worth a
 * row — so evicting it really does discard it.
 */
const LOBBY_TTL_MS = 30 * 60 * 1000;
/** How long an active match with nobody connected stays resident before falling back to disk. */
const ABANDONED_TTL_MS = 60 * 60 * 1000;
/** How long a finished match stays resident, for the post-game screen and a rematch. */
const FINISHED_TTL_MS = 10 * 60 * 1000;
/** Bound on remembered idempotency keys per seat. */
const DEDUPE_LIMIT = 64;
/**
 * How long an unanswered undo proposal stands. Long enough for someone to look up from their coffee,
 * short enough that a proposal left hanging by a closed tab does not block the next one for ever.
 */
const UNDO_PROPOSAL_TTL_MS = 3 * 60 * 1000;
/**
 * Chat lines kept per match. The record is rewritten whole after every move, so an unbounded
 * conversation would make every one of those writes bigger for ever.
 */
const CHAT_HISTORY = 200;
/** Longest single message. Also enforced by the wire schema; this is the belt to that's braces. */
const CHAT_MAX_LENGTH = 500;

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
  /**
   * Set on a seat rebuilt from a record that predates durable seats, where the occupant's id was
   * never written down. The seat is held — so nobody can walk into it with just the room code —
   * but the first valid session token for it is adopted. See `seatForClaim`.
   */
  provisional?: boolean;
}

interface AppliedResult {
  version: number;
  at: number;
  effects: Effect[];
}

/** An undo waiting on the other player's agreement. */
export interface PendingUndo {
  by: Seat;
  /** Whose move is on the table. Either player may propose, including about their opponent's move. */
  targetSeat: Seat;
  /** The version the proposal was made against; any move makes it stale. */
  atVersion: number;
  /** Effects of the move in question, so both clients can describe what is being taken back. */
  effects: Effect[];
  requestedAt: number;
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
  readonly log: { version: number; seat: Seat; at: number; effects: Effect[] }[] = [];
  private readonly dedupe = new Map<string, AppliedResult>();
  status: RoomStatus = 'lobby';
  /** Set while an undo is waiting on the other player. At most one at a time. */
  pendingUndo: PendingUndo | null = null;
  /** Highest chat id handed out so far. Restored from the record on resume, never reused. */
  private chatSeq = 0;
  lastActivity = Date.now();
  createdAt = Date.now();
  /** True for a room rebuilt from disk rather than started here. Informational; used in logs. */
  readonly resumed: boolean;

  private constructor(mod: AnyGameModule, matchId: string, code: string, match: LiveMatch<unknown>, resumed: boolean) {
    this.mod = mod;
    this.gameId = mod.id;
    this.matchId = matchId;
    this.code = code;
    this.match = match;
    this.maxSeats = mod.meta.maxPlayers;
    this.resumed = resumed;
  }

  /** A brand new match. */
  static create(mod: AnyGameModule, code: string, options: unknown, now: number): Room {
    const matchId = randomBytes(12).toString('base64url');
    const seats: Seat[] = Array.from({ length: mod.meta.maxPlayers }, (_, i) => i);
    const match = createMatch(mod as never, {
      matchId,
      code,
      // The seed is generated here and never leaves the server. Anyone holding it could compute
      // every future shuffle.
      seed: randomBytes(16).toString('base64url'),
      seats,
      options: options as never,
      now,
    });
    return new Room(mod, matchId, code, match as LiveMatch<unknown>, false);
  }

  /**
   * Rebuild a match from its record: replay the actions to recover the state, and put the same
   * people back in the same seats.
   *
   * Throws if the record will not replay — a rules change since it was written, or a corrupt row.
   * The caller decides what to do about that; a match that cannot be reconstructed faithfully must
   * not be served as if it could, because a silently wrong board is worse than an honest failure.
   */
  static fromRecord(mod: AnyGameModule, record: MatchRecord, now: number): Room {
    const { state, version, log } = replay(mod as never, record);
    const room = new Room(mod, record.matchId, record.code, { record, state, version }, true);
    room.createdAt = record.createdAt;
    room.lastActivity = now;
    room.log.push(...log);

    /*
     * Seats come back from the record when it has them. When it does not, the seats are still
     * filled -- with placeholders -- rather than left open: an in-progress match must not be
     * walk-in-able by anyone holding the code.
     */
    const recorded = record.players;
    const seats = recorded?.length ? recorded : record.seats.map((seat) => ({ seat, name: `Player ${seat + 1}`, playerId: newPlayerId() }));
    for (const player of seats) {
      room.seats.push({
        seat: player.seat,
        name: player.name,
        playerId: player.playerId,
        sockets: new Set(),
        ...(recorded?.length ? {} : { provisional: true }),
      });
    }

    // Carry on numbering from where the stored conversation left off, so ids stay unique across a
    // restart and a client cannot mistake a new line for one it already has.
    room.chatSeq = record.chat?.reduce((top, m) => Math.max(top, m.id), 0) ?? 0;

    const outcome = mod.outcome(state) as Outcome;
    room.status = outcome.status === 'over' ? 'finished' : room.full ? 'active' : 'lobby';
    return room;
  }

  get chat(): readonly ChatMessage[] {
    return this.match.record.chat ?? [];
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
    // The lowest unoccupied seat, rather than `seats.length`. Those agree for a room that filled up
    // in order, but a room rebuilt from a record should not depend on that having been true.
    const taken = new Set(this.seats.map((s) => s.seat));
    const seat = Array.from({ length: this.maxSeats }, (_, i) => i).find((i) => !taken.has(i)) as Seat | undefined;
    if (seat === undefined) return null;
    const holder: Seatholder = {
      seat,
      name: name.trim().slice(0, 32) || `Player ${seat + 1}`,
      playerId: newPlayerId(),
      sockets: new Set(),
    };
    this.seats.push(holder);
    this.syncPlayers();
    if (this.full) this.status = 'active';
    this.lastActivity = Date.now();
    return holder;
  }

  /**
   * Mirror the seating into the record, so it survives eviction. Replaces the record rather than
   * mutating it, matching how `step` treats it.
   */
  private syncPlayers(): void {
    const players = this.seats.map((s) => ({ seat: s.seat, name: s.name, playerId: s.playerId }));
    this.match = { ...this.match, record: { ...this.match.record, players } };
  }

  seatAt(seat: Seat): Seatholder | undefined {
    return this.seats.find((s) => s.seat === seat);
  }

  /** Validate a session claim against this room's actual seat, not against the wire's word for it. */
  seatForClaim(claim: SessionClaim): Seatholder | undefined {
    if (claim.matchId !== this.matchId) return undefined;
    const holder = this.seatAt(claim.seat as Seat);
    if (!holder) return undefined;
    if (holder.playerId === claim.playerId) return holder;
    /*
     * A seat rebuilt from a record written before seats were persisted. The token's signature is
     * itself proof that this server issued this seat to this player, so adopt the claimed id rather
     * than locking someone out of a game that was in progress when the server was upgraded. The
     * HMAC is what is being trusted here, exactly as it is on the normal path.
     */
    if (holder.provisional) {
      holder.playerId = claim.playerId;
      holder.provisional = false;
      this.syncPlayers();
      return holder;
    }
    return undefined;
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
      at: entry.at,
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
  ): { ok: true; effects: Effect[]; at: number } | { ok: false; code: string; message: string } {
    // One clock reading for the whole move, so the durable record, the in-memory log and the frame
    // that goes out to both players cannot disagree about when it happened.
    const at = Date.now();
    const result = step(this.mod as never, this.match as never, seat, action, at);
    if (!result.ok) {
      return { ok: false, code: result.error.code, message: result.error.message };
    }
    this.match = result.match as LiveMatch<unknown>;
    this.log.push({ version: this.match.version, seat, at, effects: result.effects });
    this.remember(seat, clientActionId, { version: this.match.version, at, effects: result.effects });
    this.lastActivity = at;
    if (result.outcome.status === 'over') this.status = 'finished';
    // A move moves the goalposts: whatever undo was on the table was about a different position.
    this.pendingUndo = null;
    return { ok: true, effects: result.effects, at };
  }

  /** Discard a proposal nobody ever answered, so it cannot block the next one indefinitely. */
  private expireStaleUndo(now: number): void {
    if (this.pendingUndo && now - this.pendingUndo.requestedAt > UNDO_PROPOSAL_TTL_MS) {
      this.pendingUndo = null;
    }
  }

  /**
   * Put an undo to the other player. Nothing changes until they agree.
   *
   * Mutual agreement rather than a unilateral take-back: in a two-player game with hidden
   * information, undoing a move you have already seen the consequences of is a way to cheat, so the
   * player who stands to lose by it is the one who has to say yes.
   */
  proposeUndo(seat: Seat, now = Date.now()): { ok: true; pending: PendingUndo } | { ok: false; code: string; message: string } {
    this.expireStaleUndo(now);
    if (this.pendingUndo) {
      return { ok: false, code: ErrorCodes.ILLEGAL_ACTION, message: 'An undo is already waiting for an answer.' };
    }
    const last = this.log.at(-1);
    const lastAction = this.match.record.actions.at(-1);
    if (!last || !lastAction) {
      return { ok: false, code: ErrorCodes.ILLEGAL_ACTION, message: 'There is no move to undo yet.' };
    }
    if (this.seats.length < this.maxSeats) {
      // With nobody to agree, "mutual" would mean "unilateral".
      return { ok: false, code: ErrorCodes.ILLEGAL_ACTION, message: 'Wait for both players before undoing.' };
    }
    this.pendingUndo = {
      by: seat,
      targetSeat: lastAction.seat,
      atVersion: this.match.version,
      effects: last.effects,
      requestedAt: now,
    };
    this.lastActivity = now;
    return { ok: true, pending: this.pendingUndo };
  }

  cancelUndo(): void {
    this.pendingUndo = null;
  }

  /**
   * Record something a player said, and hand back the line to broadcast.
   *
   * Whitespace is collapsed rather than preserved: the input is a single line, and letting a message
   * carry newlines or a run of hard spaces is a cheap way to take over the other player's panel.
   */
  say(seat: Seat, text: string, now = Date.now()): ChatMessage | null {
    const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
    if (cleaned.length === 0) return null;

    const message: ChatMessage = {
      id: (this.chatSeq += 1),
      seat,
      name: this.seatAt(seat)?.name ?? `Player ${seat + 1}`,
      at: now,
      text: cleaned,
    };
    const kept = [...this.chat, message].slice(-CHAT_HISTORY);
    // Replaces the record rather than mutating it, matching how `step` and `syncPlayers` treat it.
    this.match = { ...this.match, record: { ...this.match.record, chat: kept } };
    this.lastActivity = now;
    return message;
  }

  /**
   * Carry out an agreed undo: rewind the match by one action and rebuild everything derived from it.
   *
   * The move log is rebuilt from the replay rather than popped, so it cannot drift from the actions
   * that produced it, and the idempotency cache is cleared — otherwise a client resending the
   * undone action's id would be handed the old result and the move would silently come back.
   */
  applyUndo(): boolean {
    const result = undoLast(this.mod as never, this.match as never);
    this.pendingUndo = null;
    if (!result) return false;

    this.match = result.match as LiveMatch<unknown>;
    this.log.length = 0;
    this.log.push(...result.log);
    this.dedupe.clear();
    this.lastActivity = Date.now();
    this.status = this.outcome().status === 'over' ? 'finished' : this.full ? 'active' : 'lobby';
    return true;
  }

  /** Nothing has happened here worth a row on disk: a lobby whose second player never arrived. */
  get empty(): boolean {
    return this.status === 'lobby' && this.match.record.actions.length === 0;
  }

  /**
   * Write the current record. Called after every move, not just at the end: the store upserts on the
   * match id, so this is idempotent, and it means a crash or a redeploy mid-game loses nothing.
   *
   * Also called the moment a match becomes active, before anyone has moved. Waiting for the first
   * move would leave a freshly-seated match unresumable, which is a strange gap to have — you could
   * close your browser after one move and come back, but not after none.
   */
  async persist(store: ReplayStore): Promise<void> {
    if (this.empty) return;
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
  /** In-flight rehydrations, so concurrent resumes of one match share a single replay. */
  private readonly resuming = new Map<string, Promise<Room | undefined>>();

  constructor(
    private readonly store: ReplayStore,
    private readonly log?: Logger,
  ) {}

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
      room = Room.create(mod, code, parsed.value, Date.now());
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

  /** Resident, or rebuilt from disk. This is the lookup every join path should use. */
  async resumeByCode(code: string): Promise<Room | undefined> {
    return this.byCode.get(code) ?? (await this.rehydrate(`code:${code}`, () => this.store.findByCode(code)));
  }

  /** As `resumeByCode`, for the path where a session token names the match directly. */
  async resumeByMatchId(matchId: string): Promise<Room | undefined> {
    return this.byMatchId.get(matchId) ?? (await this.rehydrate(`id:${matchId}`, () => this.store.load(matchId)));
  }

  /**
   * Load a record and rebuild its room, at most once per match no matter how many callers ask at
   * the same time.
   *
   * Two guards, because there are two distinct races. The in-flight map collapses concurrent calls
   * for the *same* key. The re-check after the await collapses concurrent calls under *different*
   * keys — both players returning at once, one resuming by token and one by code, would otherwise
   * each build a room and the second would evict the first, silently detaching a live socket.
   */
  private async rehydrate(key: string, load: () => Promise<MatchRecord | null>): Promise<Room | undefined> {
    const inFlight = this.resuming.get(key);
    if (inFlight) return inFlight;

    const work = (async (): Promise<Room | undefined> => {
      let record: MatchRecord | null;
      try {
        record = await load();
      } catch (error) {
        reportStoreError(error, `resuming ${key}`, this.log);
        return undefined;
      }
      if (!record) return undefined;

      const resident = this.byMatchId.get(record.matchId);
      if (resident) return resident;

      const mod = getGame(record.gameId);
      if (!mod) {
        this.log?.(`cannot resume match ${record.code}: no game module "${record.gameId}" is registered`);
        return undefined;
      }
      if (record.stateVersion !== mod.stateVersion) {
        // The rules moved on. Replaying the old actions against the new reducer would produce a
        // board that looks plausible and is wrong, so refuse rather than guess.
        this.log?.(
          `cannot resume match ${record.code}: it was recorded against ${record.gameId} state version ` +
            `${record.stateVersion}, and this server runs ${mod.stateVersion}`,
        );
        return undefined;
      }

      let room: Room;
      try {
        room = Room.fromRecord(mod, record, Date.now());
      } catch (error) {
        this.log?.(`cannot resume match ${record.code}: ${(error as Error).message}`);
        return undefined;
      }

      // Only claim the code if nothing else holds it. A code freed by a sweep can be reissued, and
      // the live room owns it.
      if (!this.byCode.has(room.code)) this.byCode.set(room.code, room);
      this.byMatchId.set(room.matchId, room);
      return room;
    })().finally(() => this.resuming.delete(key));

    this.resuming.set(key, work);
    return work;
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
  /** Flush every live match. Used on shutdown, so a redeploy does not drop games in progress. */
  async persistAll(): Promise<number> {
    let saved = 0;
    for (const room of this.byCode.values()) {
      if (room.empty) continue;
      try {
        await room.persist(this.store);
        saved += 1;
      } catch (error) {
        // One bad write must not stop the rest from being saved -- but it is still reported.
        reportStoreError(error, `flushing match ${room.code}`, this.log);
      }
    }
    return saved;
  }

  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const room of [...this.byCode.values()]) {
      if (!room.expired(now)) continue;
      // Persist before evicting: this is exactly the state a later resume will rebuild from.
      if (!room.empty) {
        try {
          await room.persist(this.store);
        } catch (error) {
          // Losing a replay must never take the server down, but it should not be silent either.
          reportStoreError(error, `sweeping match ${room.code}`, this.log);
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
