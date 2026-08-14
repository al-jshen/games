/**
 * Refuse to measure anything against a stale build.
 *
 * The tools here import `@games/bot-ismcts` and `@games/splendor-duel`, and those packages resolve
 * to `dist/` -- built JavaScript, not the TypeScript anyone edits. So a source change that has not
 * been rebuilt is invisible at runtime, and the way it goes wrong is the worst kind.
 *
 * It happened: `leaf: 'heuristic'` was renamed to `leaf: 'evaluate'` in the source, the arena started
 * passing the new value, and `dist/search.js` still tested for the old one. No error, no type
 * complaint -- the comparison simply failed and the code fell through to a *different leaf strategy*.
 * A three hundred game match ran to completion measuring something nobody had asked for, and looked
 * entirely healthy doing it. `tsc --noEmit` and `vitest` both passed throughout, because both read
 * the TypeScript source and neither goes near `dist`.
 *
 * A measurement that is quietly of the wrong thing is worse than one that fails, so this fails.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGES = [
  'packages/engine',
  'packages/net',
  'packages/bot-ismcts',
  'packages/bot-splendor-duel',
  'packages/games/splendor-duel',
];

/**
 * Only the sources that can actually change `dist`.
 *
 * Everything else is noise, and one kind of noise makes this check unclearable rather than merely
 * noisy. `src/ui/**` is `exclude`d by every game package's tsconfig -- it imports CSS and JSX and is
 * built by vite, never emitted here -- so tsc does not read it, has nothing to do when it changes,
 * and does not rewrite `.tsbuildinfo`. Editing a stylesheet therefore left `src` permanently newer
 * than the build, and `npm run build` could not clear it: exactly the "a check nobody can clear is
 * worse than no check" failure this file's own comment warns about, arrived at from a direction it
 * did not anticipate.
 *
 * The same reasoning covers non-TypeScript files generally -- a `.md` or a `.json` fixture beside
 * the source is not something the tools run.
 */
const BUILT = /\.(m|c)?tsx?$/;
const IGNORED_DIRS = new Set(['ui', 'dist', 'node_modules']);

/** Newest mtime among the buildable sources under a directory, or 0 if it does not exist. */
function newest(dir) {
  let latest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      latest = Math.max(latest, newest(path));
    } else if (BUILT.test(entry.name)) {
      latest = Math.max(latest, statSync(path).mtimeMs);
    }
  }
  return latest;
}

/**
 * When tsc last checked this package, rather than when it last wrote a file.
 *
 * Comparing sources against `dist/` looks right and is not: `tsc -b` decides what to emit from the
 * content hashes in `.tsbuildinfo`, so a source whose mtime moved but whose text did not is verified
 * and then skipped, leaving `dist` older than `src` with nothing wrong. A guard on that would say
 * "stale", `npm run build` would correctly do nothing, and it would say "stale" again -- a check
 * nobody can clear is worse than no check.
 *
 * `.tsbuildinfo` is rewritten whenever tsc verifies the build, emit or no emit, which is the actual
 * question being asked.
 */
function lastVerified(pkg) {
  let latest = 0;
  for (const dir of [pkg, join(pkg, 'dist')]) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) {
        latest = Math.max(latest, statSync(join(dir, entry.name)).mtimeMs);
      }
    }
  }
  // No build info at all: fall back to the output, which is the best available answer. Walked
  // unfiltered -- `newest` deliberately only counts sources tsc compiles, and `dist` holds what it
  // emitted, which is a different set of extensions.
  return latest || newestAny(join(pkg, 'dist'));
}

/** Every file, for the one caller that is looking at build output rather than at sources. */
function newestAny(dir) {
  let latest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newestAny(path) : statSync(path).mtimeMs);
  }
  return latest;
}

export function requireFreshBuild() {
  const stale = PACKAGES.filter((pkg) => {
    const built = lastVerified(join(ROOT, pkg));
    // No `dist` at all is a different problem and the import will say so more clearly than this can.
    return built > 0 && newest(join(ROOT, pkg, 'src')) > built;
  });
  if (stale.length === 0) return;
  throw new Error(
    `${stale.join(', ')} ${stale.length === 1 ? 'has' : 'have'} sources newer than dist/.\n` +
      '  These tools run the built output, so the change you are testing is not the code that will\n' +
      '  run, and the failure would be silent rather than loud. Run `npm run build` first.',
  );
}
