import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendResult, readResults, report, resultOf } from '../results.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'games-bga-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const row = (over = {}) => ({
  table: '1',
  at: '2026-10-01T12:00:00.000Z',
  mode: 'advise',
  generation: 11,
  iterations: 1000,
  seat: 0,
  opponent: 42,
  opponentRating: 1500,
  result: 'win',
  reason: 'prestige',
  moves: 30,
  handedOver: false,
  ...over,
});

describe('the results log', () => {
  it('appends a line per game and reads them back, creating the directory on first use', () => {
    const file = join(dir, 'nested', 'results.jsonl');
    expect(readResults(file)).toEqual([]);
    appendResult(file, row());
    appendResult(file, row({ table: '2', result: 'loss' }));
    expect(readResults(file).map((r) => [r.table, r.result])).toEqual([['1', 'win'], ['2', 'loss']]);
  });

  it('skips a torn last line, as a write cut short by a kill leaves it', () => {
    const file = join(dir, 'results.jsonl');
    appendResult(file, row());
    appendResult(file, row({ table: '2' }));
    appendFileSync(file, '{"table":"3","at":"2026-10');
    expect(readResults(file).map((r) => r.table)).toEqual(['1', '2']);
  });

  it('starts a fresh line after a torn one, so the next game is not glued onto it', () => {
    const file = join(dir, 'results.jsonl');
    appendResult(file, row());
    appendFileSync(file, '{"table":"2","at":"2026-10');
    appendResult(file, row({ table: '3' }));
    // The torn row is now an earlier line: an error, but one that names it, and row 3 is intact.
    expect(() => readResults(file)).toThrow(/line 2\b/);
  });

  it('refuses a damaged line anywhere else, naming the file and the line', () => {
    const file = join(dir, 'results.jsonl');
    appendResult(file, row());
    appendFileSync(file, 'not json\n');
    appendResult(file, row({ table: '3' }));
    expect(() => readResults(file)).toThrow(file);
    expect(() => readResults(file)).toThrow(/line 2\b/);
  });

  it('reads who won from the final snapshot', () => {
    const player = (id, score, endReasons) => ({ id, score, endReasons });
    const final = (mine, theirs) => ({ me: 1, gamedatas: { players: { 1: mine, 2: theirs } } });
    expect(resultOf(final(player(1, 1, [2]), player(2, 0, [])))).toEqual({ result: 'win', reason: 'crowns' });
    expect(resultOf(final(player(1, 0, []), player(2, 1, [1, 3])))).toEqual({ result: 'loss', reason: 'prestige' });
    // An abandoned game, or one BGA ended some other way: no winner on the scoreboard.
    expect(resultOf(final(player(1, 0, []), player(2, 0, [])))).toEqual({ result: 'unknown', reason: 'other' });
  });
});

describe('the report', () => {
  it('counts clean games against rated opponents, and says what it left out', () => {
    const rows = [
      row({ opponentRating: 1500, result: 'win' }),
      row({ opponentRating: 1500, result: 'loss', mode: 'play' }),
      row({ opponentRating: 1700, result: 'win', handedOver: true }),
      row({ opponentRating: null, result: 'win' }),
      row({ result: 'unknown' }),
    ];
    const text = report(rows);
    expect(text).toMatch(/2 games counted/);
    expect(text).toMatch(/rating\s+1500/);
    expect(text).toMatch(/1 win, 1 loss/);
    expect(text).toMatch(/1 finished by hand/);
    expect(text).toMatch(/1 with no opponent rating/);
    expect(text).toMatch(/1 with no recorded result/);
    expect(text).toMatch(/advise: 1, play: 1/);
    // The two caveats are part of the output, every time.
    expect(text).toMatch(/friendly/i);
    expect(text).toMatch(/interval/i);
  });

  it('reports a bound when the record is one-sided, and nothing when there are no games', () => {
    expect(report([row(), row(), row()])).toMatch(/at least \d+/);
    expect(report([])).toMatch(/No games counted/);
  });
});
