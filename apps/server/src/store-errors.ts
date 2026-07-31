/**
 * Reporting for match-record write failures.
 *
 * These used to be swallowed -- `void room.persist(store).catch(() => undefined)` and a couple of
 * empty catch blocks. That is how a permission problem on the data directory went unnoticed: every
 * write failed, nothing was ever saved, and the server looked perfectly healthy. A failure to persist
 * must never take a live match down, but it must not be invisible either.
 *
 * Throttled per message, because the failure mode is "every move, forever" and an unthrottled log
 * would bury everything else.
 */

const THROTTLE_MS = 60_000;
const lastLogged = new Map<string, number>();

export type Logger = (message: string) => void;

/** Log a store failure at most once a minute per distinct message. */
export function reportStoreError(error: unknown, context: string, log: Logger = console.error): void {
  const detail = error instanceof Error ? error.message : String(error);
  const key = `${context}:${detail}`;
  const now = Date.now();
  const previous = lastLogged.get(key);
  if (previous !== undefined && now - previous < THROTTLE_MS) return;
  lastLogged.set(key, now);

  log(`could not save match record (${context}): ${detail}`);
  if (/unable to open database file|EACCES|EPERM|EROFS/i.test(detail)) {
    log(
      '  This is almost always the data directory not being writable by the user the server runs as. ' +
        `Current uid is ${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}; ` +
        'if DATA_DIR is a Docker bind mount, the host directory needs to be owned by that uid ' +
        '(e.g. `chown -R 1000:1000 ./data`). Matches will not be saved until this is fixed.',
    );
  }
}

/** Test helper: forget the throttle window. */
export function resetStoreErrorThrottle(): void {
  lastLogged.clear();
}
