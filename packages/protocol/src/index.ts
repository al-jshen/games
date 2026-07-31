/**
 * The wire protocol. This file *is* the bot API — see `docs/protocol.md` for the prose version.
 *
 * Design notes that matter if you change anything here:
 *  - One JSON object per WebSocket frame, tagged with `t`. No binary, no msgpack: the whole point
 *    is that a bot in any language is ~30 lines. Frames are 2-6 KB, so compression would cost
 *    more CPU than it saves bytes.
 *  - Bump `PROTOCOL_VERSION` on any incompatible change. The server checks it in the first frame
 *    and tells old tabs to reload; without that a deploy silently breaks every open client.
 *  - `rejected` carries the authoritative snapshot, so a rejection self-heals in the same round
 *    trip instead of requiring the client to ask again.
 */

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ error codes */

export const ErrorCodes = {
  /** `protocolVersion` mismatch — the client must hard-reload. */
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  BAD_FRAME: 'BAD_FRAME',
  /** Sent a frame that needs a match before joining one. */
  NOT_IN_MATCH: 'NOT_IN_MATCH',
  NO_SUCH_MATCH: 'NO_SUCH_MATCH',
  MATCH_FULL: 'MATCH_FULL',
  MATCH_OVER: 'MATCH_OVER',
  UNKNOWN_GAME: 'UNKNOWN_GAME',
  BAD_SESSION: 'BAD_SESSION',
  /** `expectVersion` did not match; the attached snapshot is the truth. */
  STALE: 'STALE',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  ILLEGAL_ACTION: 'ILLEGAL_ACTION',
  BAD_ACTION: 'BAD_ACTION',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/* ------------------------------------------------------------------ shared payloads */

export const zOutcome = z.union([
  z.object({ status: z.literal('active') }),
  z.object({
    status: z.literal('over'),
    winners: z.array(z.number().int()),
    reason: z.string(),
    scores: z.array(z.number()).optional(),
  }),
]);
export type WireOutcome = z.infer<typeof zOutcome>;

export const zPlayerInfo = z.object({
  seat: z.number().int(),
  name: z.string(),
  connected: z.boolean(),
  /** True when this seat is the recipient of the frame. */
  you: z.boolean(),
});
export type PlayerInfo = z.infer<typeof zPlayerInfo>;

/**
 * Everything a client needs to render, in one object.
 *
 * Full snapshots rather than JSON patches: the redacted view is a few KB and one turn happens
 * every several seconds, so deltas would save nothing measurable while adding a second, divergent
 * apply path — and any diff would have to be computed over *redacted* views or it leaks secrets
 * through the patch.
 */
export const zSnapshot = z.object({
  matchId: z.string(),
  code: z.string(),
  gameId: z.string(),
  version: z.number().int(),
  /** Redacted, viewer-specific game state. Shape is game-defined. */
  view: z.unknown(),
  /** Seats allowed to act right now. */
  actors: z.array(z.number().int()),
  outcome: zOutcome,
  players: z.array(zPlayerInfo),
});
export type Snapshot = z.infer<typeof zSnapshot>;

/** One entry of the move log. Effects are already redacted for the recipient. */
export const zLogEntry = z.object({
  version: z.number().int(),
  seat: z.number().int(),
  effects: z.array(z.record(z.string(), z.unknown())),
});
export type LogEntry = z.infer<typeof zLogEntry>;

/* ------------------------------------------------------------------ client -> server */

export const zClientFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    protocolVersion: z.number().int(),
    /** Present when resuming: rebinds this socket to an existing seat. */
    sessionToken: z.string().optional(),
  }),
  z.object({
    t: z.literal('create'),
    gameId: z.string(),
    name: z.string().max(32).optional(),
    options: z.unknown().optional(),
  }),
  z.object({
    t: z.literal('join'),
    code: z.string().min(1).max(16),
    name: z.string().max(32).optional(),
  }),
  z.object({
    t: z.literal('action'),
    /** The version the client believes is current. Mismatch => `rejected{code:'STALE'}`. */
    expectVersion: z.number().int(),
    /** Idempotency key. Resending the same id returns the stored result rather than re-applying. */
    clientActionId: z.string().min(1).max(64),
    action: z.unknown(),
  }),
  /** Ask the server to enumerate legal actions. Essential for bots that can't run the reducer. */
  z.object({ t: z.literal('legalActions') }),
  /** Request a fresh snapshot, e.g. after a suspected desync. */
  z.object({ t: z.literal('resync') }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientFrame = z.infer<typeof zClientFrame>;

/* ------------------------------------------------------------------ server -> client */

export const zServerFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello_ok'),
    protocolVersion: z.number().int(),
    serverTime: z.number().int(),
    games: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        blurb: z.string(),
        minPlayers: z.number().int(),
        maxPlayers: z.number().int(),
        estMinutes: z.tuple([z.number(), z.number()]),
      }),
    ),
    /** Set when the `hello` carried a session token that is still valid. */
    resumed: z.boolean().optional(),
  }),
  z.object({
    t: z.literal('joined'),
    matchId: z.string(),
    code: z.string(),
    gameId: z.string(),
    seat: z.number().int(),
    /** Store this; presenting it in a later `hello` reclaims this seat after a refresh. */
    sessionToken: z.string(),
  }),
  z.object({ t: z.literal('sync'), snapshot: zSnapshot, log: z.array(zLogEntry) }),
  z.object({
    t: z.literal('applied'),
    snapshot: zSnapshot,
    /** Echoes the submitter's id so it can retire its pending move; absent for other recipients. */
    clientActionId: z.string().optional(),
    seat: z.number().int(),
    effects: z.array(z.record(z.string(), z.unknown())),
  }),
  z.object({
    t: z.literal('rejected'),
    clientActionId: z.string().optional(),
    code: z.string(),
    message: z.string(),
    /** Authoritative state, so the client can heal without another round trip. */
    snapshot: zSnapshot,
  }),
  z.object({
    t: z.literal('legal'),
    version: z.number().int(),
    actions: z.array(z.unknown()),
    /** True when the list was capped and is not exhaustive. */
    truncated: z.boolean(),
  }),
  z.object({ t: z.literal('presence'), players: z.array(zPlayerInfo) }),
  z.object({ t: z.literal('over'), snapshot: zSnapshot }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ t: z.literal('pong'), serverTime: z.number().int() }),
]);
export type ServerFrame = z.infer<typeof zServerFrame>;

/* ------------------------------------------------------------------ helpers */

export function parseClientFrame(raw: unknown): { ok: true; frame: ClientFrame } | { ok: false; error: string } {
  const r = zClientFrame.safeParse(raw);
  return r.success ? { ok: true, frame: r.data } : { ok: false, error: r.error.issues[0]?.message ?? 'invalid frame' };
}

export function parseServerFrame(raw: unknown): { ok: true; frame: ServerFrame } | { ok: false; error: string } {
  const r = zServerFrame.safeParse(raw);
  return r.success ? { ok: true, frame: r.data } : { ok: false, error: r.error.issues[0]?.message ?? 'invalid frame' };
}

/**
 * Room codes: 30 symbols, 6 characters (~7.3e8 combinations).
 *
 * Excludes `0/O`, `1/I/L` (misread), and `U` (which removes most accidental profanity). Codes only
 * need to be unique among *live* rooms, so collisions are handled by retrying rather than by
 * making the code longer and more annoying to read aloud.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 6;

/** Accept sloppy user input: lowercase, spaces, and dashes are all fine. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  return [...code].every((ch) => CODE_ALPHABET.includes(ch));
}
