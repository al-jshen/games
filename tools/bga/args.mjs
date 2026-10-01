/**
 * The command line, as data.
 *
 * Separate from `cli.mjs` so it can be tested: importing that file runs it.
 */

/** Flags that are switches, taking no value. */
const SWITCHES = new Set(['headless', 'trace']);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; ) {
    const name = rest[i];
    if (name?.startsWith('--') && SWITCHES.has(name.slice(2))) {
      flags[name.slice(2)] = true;
      i += 1;
      continue;
    }
    if (!name?.startsWith('--') || rest[i + 1] === undefined) throw new Error(`Expected "--name value", got "${rest.slice(i).join(' ')}".`);
    flags[name.slice(2)] = rest[i + 1];
    i += 2;
  }
  return { command, flags };
}

/**
 * Which commands may run with no window.
 *
 * Only the ones that read and nothing else. `login` is a person typing into the window; `advise` is
 * a person clicking in it; and `play` hands the game to a person, in that window, the moment it
 * stops -- a `play` nobody can take over from is one that abandons games.
 */
const WINDOWLESS = new Set(['watch', 'capture']);

export function headlessAllowed(command) {
  return WINDOWLESS.has(command);
}
