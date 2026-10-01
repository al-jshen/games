import { describe, expect, it } from 'vitest';
import { sameTable, tableIdOf } from '../reader.mjs';

/**
 * The guard vets one table. Everything after it must still be looking at that table, or the vetting
 * says nothing about where the bot is playing -- the controlled tab can be navigated to another
 * Splendor Duel game the account is seated at, and the page would read just as well.
 */

describe('sameTable', () => {
  const at = (id) => `https://boardgamearena.com/1/splendorduel?table=${id}`;

  it('is true on the vetted table', () => {
    expect(sameTable(at('123456789'), '123456789')).toBe(true);
    expect(sameTable(`${at('123456789')}&foo=bar#log`, '123456789')).toBe(true);
  });

  it('is false on another table', () => {
    expect(sameTable(at('987654321'), '123456789')).toBe(false);
    expect(sameTable(at('1234567890'), '123456789')).toBe(false);
  });

  it('is false on a page with no table parameter', () => {
    expect(sameTable('https://boardgamearena.com/lobby', '123456789')).toBe(false);
    expect(sameTable('https://boardgamearena.com/1/splendorduel?table=', '')).toBe(false);
  });

  it('is false for something that is not a URL', () => {
    expect(sameTable('not a url', '123456789')).toBe(false);
    expect(sameTable('', '123456789')).toBe(false);
    expect(sameTable(undefined, '123456789')).toBe(false);
  });
});

describe('tableIdOf', () => {
  it('reads the id from a game URL, and refuses one without', () => {
    expect(tableIdOf('https://boardgamearena.com/1/splendorduel?table=123')).toBe('123');
    expect(() => tableIdOf('https://boardgamearena.com/1/splendorduel')).toThrow(/No table id/);
  });
});
