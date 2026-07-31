import type { Redacted } from './redact.js';
import type { ApplyResult, Effect, GameError, Outcome, Seat, Validator, Viewer } from './types.js';

/** Display metadata for the lobby. Purely cosmetic — the core never branches on it. */
export interface GameMeta {
  title: string;
  blurb: string;
  minPlayers: number;
  maxPlayers: number;
  /** Rough length in minutes, `[min, max]`. */
  estMinutes: [number, number];
}

/**
 * The contract every game implements. The platform core knows nothing else about a game.
 *
 * Hard rules, enforced by tests and by a dependency lint:
 *  - `apply` is **pure and deterministic**: no `Math.random`, no `Date.now`, no I/O, no mutation
 *    of its input. All randomness comes from `seed` + a counter carried in state.
 *  - Game modules must not import `node:*`. They run in the browser too — that is what makes
 *    optimistic prediction and in-process bot search possible.
 *  - State must be plain JSON: no `Map`, `Set`, `Date`, class instances, or `undefined` in arrays.
 *
 * @typeParam S - server truth state
 * @typeParam A - action (one atomic player choice)
 * @typeParam V - per-viewer redacted view; structurally different from `S` on purpose
 * @typeParam O - match options
 */
export interface GameModule<S, A, V, O = Record<string, never>> {
  readonly id: string;
  /** Bump when the shape of `S` changes, so persisted matches can be detected as stale. */
  readonly stateVersion: number;
  readonly meta: GameMeta;

  readonly actionValidator: Validator<A>;
  readonly optionsValidator: Validator<O>;

  setup(ctx: { seed: string; seats: Seat[]; options: O }): S;

  /**
   * Who may act right now. Plural to leave room for simultaneous-action games; for Splendor Duel
   * it is always exactly one seat, or none once the match is over.
   */
  currentActors(state: S): Seat[];

  /**
   * Every action `seat` could legally take. A convenience for bots and for UI affordances — the
   * authority is `isLegal`. `truncated` signals the list was capped and is not exhaustive.
   */
  legalActions(state: S, seat: Seat): { actions: A[]; truncated: boolean };

  /** The arbiter. Property-tested to agree with `legalActions`. */
  isLegal(state: S, seat: Seat, action: A): true | GameError;

  /** Pure reducer. Must return `{ok:false}` for anything `isLegal` rejects, and never throw. */
  apply(state: S, seat: Seat, action: A): ApplyResult<S>;

  outcome(state: S): Outcome;

  /** The only function permitted to produce a wire view. */
  redactFor(viewer: Viewer, state: S): Redacted<V>;

  /** Redact one effect for one viewer. Return `null` to drop it entirely. */
  redactEffect(viewer: Viewer, effect: Effect, state: S): Effect | null;

  /**
   * Client-side prediction hook: run the reducer against a redacted view instead of truth.
   *
   * Implemented by treating masked zones (a bag known only by composition, a deck known only by
   * count) as opaque and returning `unresolved: true` on contact. Omit it and the client simply
   * waits a round trip for every move, which is correct but slower.
   */
  applyToView?(view: V, seat: Seat, action: A): ApplyResult<V>;

  /** Legal actions from a viewer's redacted view, so bots can search without the truth state. */
  legalActionsFromView?(view: V, seat: Seat): { actions: A[]; truncated: boolean };
}

/** A game module with its type parameters erased, for storage in the server's registry. */
export type AnyGameModule = GameModule<any, any, any, any>;
