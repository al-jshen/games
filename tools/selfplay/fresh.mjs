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
const PACKAGES = ['packages/engine', 'packages/bot-ismcts', 'packages/games/splendor-duel'];

/** Newest mtime under a directory, or 0 if it does not exist. */
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
    if (entry.isDirectory()) latest = Math.max(latest, newest(path));
    else latest = Math.max(latest, statSync(path).mtimeMs);
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
  // No build info at all: fall back to the output, which is the best available answer.
  return latest || newest(join(pkg, 'dist'));
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
