import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MatchRecord } from '@games/engine';

/**
 * Durable match records, one JSON object per line.
 *
 * Append-only JSONL rather than SQLite on purpose: a match record is a few hundred bytes, the only
 * queries we need are "by code" and "recent", and avoiding a native module keeps the Alpine image
 * free of a build toolchain. The interface is narrow enough to swap for a real database later
 * without touching anything else.
 */
export interface ReplayStore {
  save(record: MatchRecord): Promise<void>;
  load(matchId: string): Promise<MatchRecord | null>;
  findByCode(code: string): Promise<MatchRecord | null>;
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
    for (const record of this.records.values()) if (record.code === code) return record;
    return null;
  }
}
