/** Core vocabulary shared by every game module and by the platform core. */

/** Seat index within a match, 0-based. Seat identity is assigned by the server, never claimed. */
export type Seat = number;

/** A spectator has no seat. Kept in the types so redaction has an explicit "knows nothing" case. */
export type Viewer = Seat | null;

/**
 * Why an action was refused. Illegal moves are expected traffic — a probing or buggy bot will
 * send hundreds — so they are returned as values, never thrown.
 */
export interface GameError {
  code: string;
  message: string;
}

export function gameError(code: string, message: string): GameError {
  return { code, message };
}

/**
 * Something that *happened*, as opposed to something that *is*.
 *
 * A state snapshot tells the client the new truth but not which token moved, so diffing two
 * boards to drive an animation is both miserable and ambiguous. Effects carry that semantics and
 * additionally feed the move log. They are redacted separately from state (see `redactEffect`) —
 * an effect naming a card the opponent may not see must have that field nulled.
 */
export interface Effect {
  /** Discriminant, e.g. `'takeTokens'`. The platform core forwards effects without interpreting. */
  k: string;
  [field: string]: unknown;
}

/** Match status. `winners` is a list so future games can express draws or teams. */
export type Outcome =
  | { status: 'active' }
  | {
      status: 'over';
      /** Empty means a draw. */
      winners: Seat[];
      /** Machine-readable cause, e.g. `'prestige'`, `'crowns'`, `'color'`, `'resigned'`. */
      reason: string;
      /** Per-seat final score, for display. */
      scores?: number[];
    };

/**
 * The result of applying an action.
 *
 * `unresolved` means the reducer touched information the actor cannot see (a shuffled bag, a
 * face-down deck), so a client running this same reducer locally produced a guess rather than
 * the truth. The client's prediction rule is exactly "predict unless `unresolved`".
 */
export type ApplyResult<S> =
  | { ok: true; state: S; effects: Effect[]; unresolved?: boolean }
  | { ok: false; error: GameError };

export function applyOk<S>(state: S, effects: Effect[], unresolved?: boolean): ApplyResult<S> {
  return unresolved ? { ok: true, state, effects, unresolved: true } : { ok: true, state, effects };
}

export function applyErr<S>(code: string, message: string): ApplyResult<S> {
  return { ok: false, error: { code, message } };
}

/**
 * Minimal validation interface so the engine does not pin every game to one validator library.
 * Games typically implement this with a couple of lines over a zod schema.
 */
export interface Validator<T> {
  validate(input: unknown): { ok: true; value: T } | { ok: false; error: string };
}

/** JSON-safe values. Game state must round-trip through `JSON.parse(JSON.stringify(x))`. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
