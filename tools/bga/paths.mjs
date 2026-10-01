import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

/** The checkpoints the web app ships. The agent on BGA is the one a visitor to the site plays. */
export const PUBLISHED = resolve(ROOT, 'apps/web/public/bots/splendor-duel/current');

/** Results, captures, stop snapshots, per-table memory. Under `/data/`, which git ignores. */
export const DATA = resolve(ROOT, 'data/bga');
export const RESULTS = resolve(DATA, 'results.jsonl');

/** The browser profile holding the operator's BGA session. Under `.cache/`, which git ignores. */
export const PROFILE = resolve(HERE, '.cache/profile');
