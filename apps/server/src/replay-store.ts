import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MatchRecord } from '@games/engine';

/** A match at a glance. Deliberately excludes the record, and therefore the seed. */
export interface MatchSummary {
  matchId: string;
  code: string;
  gameId: string;
  createdAt: number;
  finishedAt?: number;
  moves: number;
  winners?: number[];
  reason?: string;
}

/**
 * Where match records live. `SqliteReplayStore` is the default; the JSONL and in-memory
 * implementations below exist for a file-only deployment and for tests.
 *
 * Records are saved after *every* move, not only when a match finishes, so a crash or a redeploy
 * mid-game loses nothing. That is what pushed this from a flat file to a table: appending a full copy
 * per move would grow the file quadratically, whereas an upsert keyed on the match id does not.
 */
export interface ReplayStore {
  save(record: MatchRecord): Promise<void>;
  load(matchId: string): Promise<MatchRecord | null>;
  findByCode(code: string): Promise<MatchRecord | null>;
  /** Most recent first. */
  list(limit?: number): Promise<MatchSummary[]>;
  close?(): void;
}

function summarise(record: MatchRecord): MatchSummary {
  const outcome = record.outcome;
  return {
    matchId: record.matchId,
    code: record.code,
    gameId: record.gameId,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
    moves: record.actions.length,
    winners: outcome && outcome.status === 'over' ? outcome.winners : undefined,
    reason: outcome && outcome.status === 'over' ? outcome.reason : undefined,
  };
}

export class JsonlReplayStore implements ReplayStore {
  private readonly file: string;
  private ready: Promise<void> | null = null;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'matches.jsonl');
  }

  private async ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  async save(record: MatchRecord): Promise<void> {
    await this.ensureDir();
    // The seed stays in the record: it is what makes the replay reproducible, and this file is
    // server-side only. It must never be echoed to a client.
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  private async all(): Promise<MatchRecord[]> {
    try {
      const text = await readFile(this.file, 'utf8');
      const out: MatchRecord[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as MatchRecord);
        } catch {
          // A torn final line from an interrupted write; skip rather than fail the whole read.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async load(matchId: string): Promise<MatchRecord | null> {
    const all = await this.all();
    // Later entries supersede earlier ones for the same match.
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]?.matchId === matchId) return all[i] ?? null;
    }
    return null;
  }

  async findByCode(code: string): Promise<MatchRecord | null> {
    const all = await this.all();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]?.code === code) return all[i] ?? null;
    }
    return null;
  }

  async list(limit = 50): Promise<MatchSummary[]> {
    const all = await this.all();
    // Later lines supersede earlier ones for the same match, so collapse before summarising.
    const latest = new Map<string, MatchRecord>();
    for (const record of all) latest.set(record.matchId, record);
    return [...latest.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(summarise);
  }
}

/** Used by tests and by anyone who does not want match history on disk. */
export class MemoryReplayStore implements ReplayStore {
  private readonly records = new Map<string, MatchRecord>();

  async save(record: MatchRecord): Promise<void> {
    this.records.set(record.matchId, record);
  }

  async load(matchId: string): Promise<MatchRecord | null> {
    return this.records.get(matchId) ?? null;
  }

  async findByCode(code: string): Promise<MatchRecord | null> {
    let found: MatchRecord | null = null;
    for (const record of this.records.values()) {
      if (record.code === code && (!found || record.createdAt >= found.createdAt)) found = record;
    }
    return found;
  }

  async list(limit = 50): Promise<MatchSummary[]> {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(summarise);
  }
}
