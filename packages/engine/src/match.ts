import type { AnyGameModule, GameModule } from './module.js';
import type { Effect, GameError, Outcome, Seat } from './types.js';

/**
 * The durable record of a match. A few hundred bytes that reconstruct everything: exact bug
 * reproduction, the in-UI move log, spectator playback, bot training data, and a CI regression
 * corpus. Snapshots alone give you none of that, which is why this — not the state — is what gets
 * persisted.
 */
export interface MatchRecord {
  matchId: string;
  code: string;
  gameId: string;
  /** Secret. Never sent to a client. */
  seed: string;
  stateVersion: number;
  options: unknown;
  seats: Seat[];
  createdAt: number;
  actions: LoggedAction[];
  finishedAt?: number;
  outcome?: Outcome;
}

export interface LoggedAction {
  /** Match version *after* this action was applied. */
  version: number;
  seat: Seat;
  action: unknown;
  at: number;
}

/**
 * A live match: truth state plus the monotonic version the wire protocol uses for concurrency.
 *
 * The version is owned by the core rather than by the game module, because it is a transport
 * concern (stale-write rejection and idempotency) rather than a rules concern.
 */
export interface LiveMatch<S = unknown> {
  record: MatchRecord;
  state: S;
  version: number;
}

export function createMatch<S, A, V, O>(
  mod: GameModule<S, A, V, O>,
  init: { matchId: string; code: string; seed: string; seats: Seat[]; options: O; now: number },
): LiveMatch<S> {
  const state = mod.setup({ seed: init.seed, seats: init.seats, options: init.options });
  return {
    state,
    version: 0,
    record: {
      matchId: init.matchId,
      code: init.code,
      gameId: mod.id,
      seed: init.seed,
      stateVersion: mod.stateVersion,
      options: init.options,
      seats: init.seats,
      createdAt: init.now,
      actions: [],
    },
  };
}

export type StepResult<S> =
  | { ok: true; match: LiveMatch<S>; effects: Effect[]; outcome: Outcome }
  | { ok: false; error: GameError };

/**
 * Validate and apply one action, advancing the version and appending to the action log.
 *
 * Deliberately does *not* handle `expectVersion` or `clientActionId` — those are transport-level
 * concerns and live in the server, so that a headless self-play runner can drive a match without
 * inventing fake protocol fields.
 */
export function step<S, A, V, O>(
  mod: GameModule<S, A, V, O>,
  match: LiveMatch<S>,
  seat: Seat,
  rawAction: unknown,
  now: number,
): StepResult<S> {
  if (mod.outcome(match.state).status === 'over') {
    return { ok: false, error: { code: 'MATCH_OVER', message: 'The match has already finished.' } };
  }

  const parsed = mod.actionValidator.validate(rawAction);
  if (!parsed.ok) {
    return { ok: false, error: { code: 'BAD_ACTION', message: parsed.error } };
  }
  const action = parsed.value;

  if (!mod.currentActors(match.state).includes(seat)) {
    return { ok: false, error: { code: 'NOT_YOUR_TURN', message: 'It is not your turn.' } };
  }

  const legal = mod.isLegal(match.state, seat, action);
  if (legal !== true) return { ok: false, error: legal };

  const result = mod.apply(match.state, seat, action);
  if (!result.ok) return { ok: false, error: result.error };

  const version = match.version + 1;
  const outcome = mod.outcome(result.state);
  const record: MatchRecord = {
    ...match.record,
    actions: [...match.record.actions, { version, seat, action, at: now }],
  };
  if (outcome.status === 'over') {
    record.finishedAt = now;
    record.outcome = outcome;
  }

  return {
    ok: true,
    match: { record, state: result.state, version },
    effects: result.effects,
    outcome,
  };
}

/**
 * Rebuild a match from its action log. Same seed + same actions must give byte-identical state —
 * that equality is the regression net for every rule change, so it is asserted in CI.
 */
export function replay<S, A, V, O>(
  mod: GameModule<S, A, V, O>,
  record: MatchRecord,
): { state: S; version: number } {
  let state = mod.setup({
    seed: record.seed,
    seats: record.seats,
    options: record.options as O,
  });
  let version = 0;
  for (const logged of record.actions) {
    const parsed = mod.actionValidator.validate(logged.action);
    if (!parsed.ok) {
      throw new Error(`replay: action at version ${logged.version} failed validation: ${parsed.error}`);
    }
    const result = mod.apply(state, logged.seat, parsed.value);
    if (!result.ok) {
      throw new Error(
        `replay: action at version ${logged.version} was rejected: ${result.error.code} ${result.error.message}`,
      );
    }
    state = result.state;
    version = logged.version;
  }
  return { state, version };
}

/** Assert a value survives a JSON round trip unchanged. Used by every game's test suite. */
export function isJsonRoundTrippable(value: unknown): boolean {
  try {
    return JSON.stringify(value) === JSON.stringify(JSON.parse(JSON.stringify(value)));
  } catch {
    return false;
  }
}

export type { AnyGameModule };
