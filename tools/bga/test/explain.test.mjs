import { describe, expect, it } from 'vitest';
import { explainSettings, explainSnapshot, looksLikeGamePage } from '../explain.mjs';

/**
 * `capture` is run by someone trying to find out what BGA's page really holds, usually because the
 * adapter's picture of it is wrong. So these summaries have to stay readable for exactly the inputs
 * that are wrong: a page that gave nothing, or gave something of another shape.
 */

const raw = (over = {}) => ({
  tableId: '123',
  me: 1000,
  gamestate: { name: 'playAction', active_player: '2000', args: {} },
  gamedatas: {
    players: { 1000: { id: '1000' }, 2000: { id: '2000' } },
    board: new Array(25).fill({}),
    cardDeckCount: { 1: 25, 2: 20, 3: 10 },
    tableCards: { 1: new Array(5).fill({}), 2: new Array(4).fill({}), 3: new Array(3).fill({}) },
    royalCards: new Array(4).fill({}),
    expansion: false,
    ...over,
  },
});

describe('explainSnapshot', () => {
  it('says whose turn it is, who we are, and what is on the table', () => {
    const text = explainSnapshot(raw()).join('\n');
    expect(text).toContain('state "playAction"');
    expect(text).toContain('player 2000 to act');
    expect(text).toContain('logged in as player 1000, seated at this table');
    expect(text).toContain('players: 1000, 2000');
    expect(text).toContain('25 tokens on the board');
    expect(text).toContain('table cards 5/4/3');
    expect(text).toContain('decks 25/20/10');
    expect(text).toContain('4 royal cards');
    expect(text).toContain('expansion off');
  });

  it('says so when the logged-in account is only watching', () => {
    expect(explainSnapshot({ ...raw(), me: 77 }).join('\n')).toContain('logged in as player 77, NOT seated (watching)');
  });

  it('says so when the expansion is on', () => {
    expect(explainSnapshot(raw({ expansion: true })).join('\n')).toContain('expansion ON');
  });

  it('describes what is missing instead of throwing on a page of another shape', () => {
    expect(explainSnapshot(null)).toEqual(['nothing was read from the page']);
    const text = explainSnapshot({ gamestate: {}, gamedatas: {} }).join('\n');
    expect(text).toContain('state "?"');
    expect(text).toContain('players: none found');
    expect(text).toContain('? tokens on the board');
  });
});

describe('explainSettings', () => {
  const info = { id: '123', game_name: 'splendorduel', options: { 100: { value: '0' }, 201: { name: 'Game mode', value: '1' } } };

  it('shows the fields BGA sent and the option the mode check reads', () => {
    const text = explainSettings(info).join('\n');
    expect(text).toContain('fields: id, game_name, options');
    expect(text).toContain('table id in the answer: 123');
    expect(text).toContain('options present: 100, 201');
    expect(text).toContain('option 201 (assumed to be the game mode): {"name":"Game mode","value":"1"}');
  });

  it('looks inside a `data` envelope', () => {
    expect(explainSettings({ status: 1, data: info }).join('\n')).toContain('table id in the answer: 123');
  });

  it('says plainly when BGA gave no answer, or one without options', () => {
    expect(explainSettings(null).join('\n')).toMatch(/no answer/);
    const text = explainSettings({ id: '123' }).join('\n');
    expect(text).toContain('no `options` in the answer');
    expect(text).toContain('option 201 (assumed to be the game mode): absent');
  });

  it('cuts a very long option short', () => {
    const long = { id: '1', options: { 201: { values: 'x'.repeat(2000) } } };
    const line = explainSettings(long).find((l) => l.startsWith('option 201'));
    expect(line.length).toBeLessThan(400);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('looksLikeGamePage', () => {
  it('tells the game itself from the table’s own page, which carries the same id', () => {
    expect(looksLikeGamePage('https://boardgamearena.com/8/splendorduel?table=924592695')).toBe(true);
    expect(looksLikeGamePage('https://en.boardgamearena.com/12/splendorduel/?table=1')).toBe(true);
    // The address people most naturally copy.
    expect(looksLikeGamePage('https://boardgamearena.com/tableview?table=924592695')).toBe(false);
    expect(looksLikeGamePage('https://boardgamearena.com/table?table=924592695')).toBe(false);
    expect(looksLikeGamePage('https://boardgamearena.com/gamepanel?game=splendorduel')).toBe(false);
    expect(looksLikeGamePage('not a url')).toBe(false);
  });
});
