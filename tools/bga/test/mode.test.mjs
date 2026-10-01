import { describe, expect, it } from 'vitest';
import { PLAY_VERIFIED, guard, playAllowed, tableMode } from '../mode.mjs';

/**
 * The gate both modes pass through. It is the one piece of this tool whose failure mode is not
 * "the bot plays badly" but "the bot plays somewhere it must not", so every way it can be unsure
 * has to come out as a refusal.
 */

const info = (mode, id = '123') => ({ id, options: { 100: { value: '0' }, 201: { value: mode } } });
const snapshot = (over = {}) => ({
  me: 1,
  gamedatas: { expansion: false, players: { 1: { id: 1 }, 2: { id: 2 } }, ...over },
});

describe('tableMode', () => {
  it('reads the game-mode option', () => {
    expect(tableMode(info('1'))).toBe('friendly');
    expect(tableMode(info(1))).toBe('friendly');
    expect(tableMode(info('0'))).toBe('rated');
    expect(tableMode(info('2'))).toBe('rated');
  });

  it('accepts the same answer wrapped in a `data` envelope', () => {
    expect(tableMode({ status: 1, data: info('1') })).toBe('friendly');
  });

  it('is unknown for anything it does not recognise', () => {
    expect(tableMode(null)).toBe('unknown');
    expect(tableMode({})).toBe('unknown');
    expect(tableMode({ options: {} })).toBe('unknown');
    expect(tableMode(info('7'))).toBe('unknown');
    expect(tableMode(info(undefined))).toBe('unknown');
  });
});

describe('guard', () => {
  const pass = { info: info('1'), tableId: '123', snapshot: snapshot(), verified: true };

  it('lets a friendly, base-game table we are seated at through', () => {
    expect(guard(pass)).toEqual({ ok: true });
  });

  it('refuses everything until the mode check has been verified against live tables', () => {
    const verdict = guard({ ...pass, verified: undefined });
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/not been confirmed/);
  });

  it('takes the gate as open only when it is exactly true', () => {
    for (const verified of [false, 1, 'true', 'yes', {}, []]) {
      const verdict = guard({ ...pass, verified });
      expect(verdict.ok, String(verified)).toBe(false);
      expect(verdict.why).toMatch(/not been confirmed/);
    }
  });

  it('refuses without a table id it can trust, even when the settings carry none either', () => {
    // Both sides missing used to compare equal ("undefined" === "undefined").
    const noId = { options: { 201: { value: '1' } } };
    expect(guard({ ...pass, tableId: undefined, info: noId }).ok).toBe(false);
    expect(guard({ ...pass, tableId: '', info: { ...noId, id: '' } }).ok).toBe(false);
    expect(guard({ ...pass, tableId: '12a', info: info('1', '12a') }).ok).toBe(false);
    expect(guard({ ...pass, tableId: ' 123', info: info('1', ' 123') }).ok).toBe(false);
    expect(guard({ ...pass, tableId: '-123', info: info('1', '-123') }).ok).toBe(false);
  });

  it('refuses a rated table', () => {
    for (const mode of ['0', '2']) {
      const verdict = guard({ ...pass, info: info(mode) });
      expect(verdict.ok).toBe(false);
      expect(verdict.why).toMatch(/friendly/);
    }
  });

  it('refuses when it cannot tell', () => {
    expect(guard({ ...pass, info: null }).ok).toBe(false);
    expect(guard({ ...pass, info: {} }).ok).toBe(false);
    // Settings for some other table are not settings for this one.
    expect(guard({ ...pass, info: info('1', '999') }).ok).toBe(false);
  });

  it('refuses the expansion, and a table we are only watching', () => {
    expect(guard({ ...pass, snapshot: snapshot({ expansion: true }) }).why).toMatch(/expansion/i);
    expect(guard({ ...pass, snapshot: { ...snapshot(), me: 9 } }).why).toMatch(/not seated/);
  });
});

describe('playAllowed', () => {
  it('ships closed', () => {
    expect(PLAY_VERIFIED).toBe(false);
    expect(playAllowed()).toMatchObject({ ok: false });
  });

  it('refuses `play` until it has been watched through a live game, and names the step', () => {
    for (const verified of [undefined, false, 1, 'true', {}]) {
      const verdict = playAllowed({ verified });
      expect(verdict.ok, String(verified)).toBe(false);
      expect(verdict.why).toMatch(/Task 12 Step 11/);
    }
  });

  it('allows it once that is recorded, and only by an exact true', () => {
    expect(playAllowed({ verified: true })).toEqual({ ok: true });
  });
});
