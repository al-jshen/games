import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { MatchRecord } from '@games/engine';
import type { MatchSummary, ReplayStore } from './replay-store.js';

/**
 * Match records in SQLite, via Node's built-in `node:sqlite`.
 *
 * Built in means no native module and no build toolchain in the image, which was the whole reason the
 * first cut used append-only JSONL. What a real table buys over that file:
 *
 *  - **Upsert by match id.** A match is saved after *every* move rather than only when it finishes, so
 *    a crash or a redeploy mid-game loses nothing. Appending a fresh copy per move to a flat file
 *    would have grown it quadratically.
 *  - **Queries.** "recent matches", "by code", "how many finished" are indexed lookups instead of
 *    reading and parsing the entire history.
 *  - **Atomic writes.** No torn final line to skip over.
 *
 * `DatabaseSync` is synchronous, which is a feature here: a save cannot interleave with the next move,
 * so there is no write-ordering hazard to reason about. The records are a few KB, so the cost per move
 * is negligible.
 */

/*
 * Loaded through `createRequire` with a specifier assembled at runtime, rather than a plain
 * `import ... from 'node:sqlite'`.
 *
 * Vite's list of Node builtins predates `node:sqlite`, so it strips the `node:` prefix and then fails
 * to resolve `sqlite` as an npm package — which breaks the test runner even though the server itself
 * is fine. Marking it external does not help, because the rewrite happens first. The type import
 * below is erased at compile time, so the types stay exact while nothing statically analysable
 * remains for a bundler to trip over.
 */
type SqliteModule = typeof import('node:sqlite');

function loadSqlite(): SqliteModule {
  const require = createRequire(import.meta.url);
  return require(['node', 'sqlite'].join(':')) as SqliteModule;
}
export class SqliteReplayStore implements ReplayStore {
  private readonly db: InstanceType<SqliteModule['DatabaseSync']>;

  constructor(private readonly file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(file);
    // WAL so a reader cannot block the move that is being written.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    /*
     * Saving after every move rewrites the whole record, so a 120-move match writes on the order of a
     * megabyte in total. That is the price of never losing a game in progress, and it is nothing for a
     * self-hosted server -- but the default WAL checkpoint threshold (~4MB) lets the sidecar file grow
     * further than it needs to for this write pattern, so check in more often.
     */
    this.db.exec('PRAGMA wal_autocheckpoint = 200');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        match_id    TEXT PRIMARY KEY,
        code        TEXT NOT NULL,
        game_id     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        finished_at INTEGER,
        moves       INTEGER NOT NULL,
        winners     TEXT,
        reason      TEXT,
        -- The whole MatchRecord, seed included. Server-side only: the seed is handed out solely for a
        -- finished match, since until then it would reveal every future shuffle.
        record      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS matches_code ON matches (code);
      CREATE INDEX IF NOT EXISTS matches_created ON matches (created_at DESC);
    `);
  }

  save(record: MatchRecord): Promise<void> {
    const outcome = record.outcome;
    this.db
      .prepare(
        `INSERT INTO matches
           (match_id, code, game_id, created_at, updated_at, finished_at, moves, winners, reason, record)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_id) DO UPDATE SET
           updated_at  = excluded.updated_at,
           finished_at = excluded.finished_at,
           moves       = excluded.moves,
           winners     = excluded.winners,
           reason      = excluded.reason,
           record      = excluded.record`,
      )
      .run(
        record.matchId,
        record.code,
        record.gameId,
        record.createdAt,
        Date.now(),
        record.finishedAt ?? null,
        record.actions.length,
        outcome && outcome.status === 'over' ? JSON.stringify(outcome.winners) : null,
        outcome && outcome.status === 'over' ? outcome.reason : null,
        JSON.stringify(record),
      );
    return Promise.resolve();
  }

  load(matchId: string): Promise<MatchRecord | null> {
    const row = this.db.prepare('SELECT record FROM matches WHERE match_id = ?').get(matchId) as
      | { record: string }
      | undefined;
    return Promise.resolve(row ? (JSON.parse(row.record) as MatchRecord) : null);
  }

  findByCode(code: string): Promise<MatchRecord | null> {
    // Codes are reused once a room is gone, so the most recent one wins.
    const row = this.db
      .prepare('SELECT record FROM matches WHERE code = ? ORDER BY created_at DESC LIMIT 1')
      .get(code) as { record: string } | undefined;
    return Promise.resolve(row ? (JSON.parse(row.record) as MatchRecord) : null);
  }

  list(limit = 50): Promise<MatchSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT match_id, code, game_id, created_at, finished_at, moves, winners, reason
           FROM matches ORDER BY created_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500))) as {
      match_id: string;
      code: string;
      game_id: string;
      created_at: number;
      finished_at: number | null;
      moves: number;
      winners: string | null;
      reason: string | null;
    }[];

    // Deliberately no `record`, and therefore no seed: this endpoint is safe to expose.
    return Promise.resolve(
      rows.map((row) => ({
        matchId: row.match_id,
        code: row.code,
        gameId: row.game_id,
        createdAt: row.created_at,
        finishedAt: row.finished_at ?? undefined,
        moves: row.moves,
        winners: row.winners ? (JSON.parse(row.winners) as number[]) : undefined,
        reason: row.reason ?? undefined,
      })),
    );
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM matches').get() as { n: number };
    return row.n;
  }

  close(): void {
    try {
      // Fold the WAL back into the database so a stopped server leaves one tidy file to copy.
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Not worth failing a shutdown over.
    }
    this.db.close();
  }
}
