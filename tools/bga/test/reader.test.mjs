import { describe, expect, it } from 'vitest';
import { isGameOf, playerIdsOf, sameTable, tableIdOf } from '../reader.mjs';

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

/**
 * Seen live on 2026-10-01: the browser shows `/tableview?table=…`, and the game is in a frame inside
 * it at `/<server number>/splendorduel?table=…`, beside a blank frame of BGA's own. Only the game's
 * frame has `gameui`, so it has to be told from the shell and from every other frame.
 */
describe('isGameOf', () => {
  it('is true for the frame the table’s game runs in', () => {
    expect(isGameOf('https://en.boardgamearena.com/16/splendorduel?table=924604189', '924604189')).toBe(true);
    expect(isGameOf('https://boardgamearena.com/8/splendorduel/?table=924604189', '924604189')).toBe(true);
  });

  it('is false for the shell around it and for BGA’s other frames', () => {
    expect(isGameOf('https://en.boardgamearena.com/tableview?table=924604189', '924604189')).toBe(false);
    expect(isGameOf('https://boardgamearena.com/blank?gsgameurl=/splendorduel?table=924604189', '924604189')).toBe(false);
    expect(isGameOf('chrome-error://chromewebdata/', '924604189')).toBe(false);
    expect(isGameOf('not a url', '924604189')).toBe(false);
  });

  it('is false for another table, and for another game at this table’s id', () => {
    expect(isGameOf('https://en.boardgamearena.com/16/splendorduel?table=1', '924604189')).toBe(false);
    expect(isGameOf('https://en.boardgamearena.com/16/splendor?table=924604189', '924604189')).toBe(false);
  });
});

describe('tableIdOf', () => {
  it('reads the id from a table’s URL in either form, and refuses one without', () => {
    expect(tableIdOf('https://boardgamearena.com/tableview?table=123')).toBe('123');
    expect(tableIdOf('https://boardgamearena.com/1/splendorduel?table=123')).toBe('123');
    expect(() => tableIdOf('https://boardgamearena.com/1/splendorduel')).toThrow(/No table id/);
  });
});

describe('playerIdsOf', () => {
  it('reads the player ids from the keys of a raw snapshot, whatever else is wrong with it', () => {
    expect(playerIdsOf({ gamedatas: { players: { 1000: { id: 'garbled' }, 2000: null } } })).toEqual(['1000', '2000']);
  });

  it('is empty when there are no players to read', () => {
    expect(playerIdsOf(null)).toEqual([]);
    expect(playerIdsOf({})).toEqual([]);
    expect(playerIdsOf({ gamedatas: { players: [] } })).toEqual([]);
    expect(playerIdsOf({ gamedatas: { players: 'x' } })).toEqual([]);
  });
});
