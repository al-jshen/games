import { describe, expect, it } from 'vitest';
import { headlessAllowed, parseArgs } from '../args.mjs';

describe('parseArgs', () => {
  it('reads a command and its --name value pairs', () => {
    expect(parseArgs(['watch', '--table', 'https://x/tableview?table=1', '--iterations', '300'])).toEqual({
      command: 'watch',
      flags: { table: 'https://x/tableview?table=1', iterations: '300' },
    });
    expect(parseArgs(['report'])).toEqual({ command: 'report', flags: {} });
    expect(parseArgs([])).toEqual({ command: undefined, flags: {} });
  });

  it('takes --headless as a switch, wherever it comes', () => {
    expect(parseArgs(['watch', '--table', 'u', '--headless']).flags).toEqual({ table: 'u', headless: true });
    expect(parseArgs(['watch', '--headless', '--table', 'u']).flags).toEqual({ table: 'u', headless: true });
  });

  it('takes --trace as a switch too, for any command', () => {
    expect(parseArgs(['advise', '--trace', '--table', 'u']).flags).toEqual({ table: 'u', trace: true });
    expect(parseArgs(['watch', '--table', 'u', '--headless', '--trace']).flags).toEqual({ table: 'u', headless: true, trace: true });
  });

  it('still refuses a flag with no value, or a value with no flag', () => {
    expect(() => parseArgs(['watch', '--table'])).toThrow(/Expected "--name value"/);
    expect(() => parseArgs(['watch', 'stray'])).toThrow(/Expected "--name value"/);
    // A switch does not swallow the flag after it.
    expect(() => parseArgs(['watch', '--headless', '--table'])).toThrow(/Expected "--name value"/);
  });
});

describe('headlessAllowed', () => {
  it('is for the commands that only read', () => {
    expect(headlessAllowed('watch')).toBe(true);
    expect(headlessAllowed('capture')).toBe(true);
  });

  it('is not for the commands a person has to see the window for', () => {
    // `login`: you type in it. `advise`: you click in it. `play`: it is what you take over on a stop.
    for (const command of ['login', 'advise', 'play']) expect(headlessAllowed(command)).toBe(false);
  });
});
