/**
 * Copy a trained generation out of a run directory and into the web client, as a playable bot.
 *
 *     node tools/selfplay/publish_bot.mjs --run /mnt/ceph/users/jshen/games/loop --generation 3
 *
 * The web client cannot read a run directory: those live on a cluster filesystem and the browser
 * gets one origin and a `fetch`. So the checkpoints are copied into `apps/web/public/`, which vite
 * serves verbatim, and the bot is whatever is sitting there. This is the whole deployment story, and
 * it is a command rather than a build step because a generation is promoted at human pace -- a few
 * times a week at most -- and burning a rebuild of the site into every self-play loop would be a
 * cost paid every hour for a change that happens rarely.
 *
 * Two things are rewritten on the way.
 *
 * `trained_on` is a list of forty absolute cluster paths, which is provenance nobody in a browser
 * can act on and 2.5KB of it per checkpoint. It becomes a count, and the run directory it came from
 * is recorded once in `bot.json` instead.
 *
 * `bot.json` is added: what generation this is, what it scored against the fixed baselines, and what
 * the held-out numbers were. The client reads it to describe the opponent honestly -- "generation 3,
 * beats the heuristic search 93% of the time" is a claim, and it should come from the run that
 * measured it rather than from a string somebody typed into a component.
 *
 * Nothing here validates the weights beyond the parameter count `@games/net` already checks on load.
 * A checkpoint that loads and plays is the test, and `npm run dev` is thirty seconds away.
 */

import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function flag(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1 || at === process.argv.length - 1) return fallback;
  return process.argv[at + 1];
}

const run = flag('run');
const generation = flag('generation');
const game = flag('game', 'splendor-duel');
const into = flag('into', join(ROOT, 'apps/web/public/bots'));

if (!run || generation === null) {
  console.error('usage: publish_bot.mjs --run <loop dir> --generation <n> [--game splendor-duel] [--into <dir>]');
  process.exit(2);
}

const label = `gen${generation}`;
const destination = join(into, game, label);

/** One checkpoint directory, copied with its sidecar slimmed. Returns what to say about it. */
function publish(head) {
  const from = join(run, 'models', `${label}-${head}`);
  const to = join(destination, head);
  mkdirSync(to, { recursive: true });

  const sidecar = JSON.parse(readFileSync(join(from, 'model.json'), 'utf8'));
  const datasets = Array.isArray(sidecar.trained_on) ? sidecar.trained_on.length : null;
  delete sidecar.trained_on;
  if (datasets !== null) sidecar.trained_on_datasets = datasets;
  writeFileSync(join(to, 'model.json'), `${JSON.stringify(sidecar, null, 2)}\n`);

  copyFileSync(join(from, sidecar.file), join(to, sidecar.file));
  const bytes = statSync(join(to, sidecar.file)).size;
  console.log(`  ${head.padEnd(6)} ${sidecar.architecture ?? '?'} ${sidecar.parameters.toLocaleString()} parameters, ${(bytes / 1024).toFixed(0)}KB`);

  return {
    dir: head,
    architecture: sidecar.architecture ?? null,
    parameters: sidecar.parameters,
    bytes,
    heldOut: sidecar.held_out ?? null,
    baselines: sidecar.baselines ?? null,
    ...(sidecar.temperature === undefined ? {} : { temperature: sidecar.temperature }),
  };
}

console.log(`publishing ${label} from ${run}`);
const value = publish('value');
const policy = publish('policy');

/**
 * What the loop measured about this generation, if the run kept a history.
 *
 * The gate score and the baseline scores are the only numbers here that are about *playing*; every
 * other figure in the sidecars is a held-out loss, which is a proxy. So they are worth carrying even
 * though they live in a different file from the weights.
 */
let measured = null;
try {
  const state = JSON.parse(readFileSync(join(run, 'state.json'), 'utf8'));
  const entry = (state.history ?? []).find((h) => h.generation === Number(generation));
  if (entry) {
    measured = {
      accepted: entry.accepted,
      gate: entry.score,
      baseline: entry.baseline ?? null,
      datasets: entry.datasets?.length ?? null,
    };
  }
} catch {
  // No state.json, or a run that predates the history. The weights are still publishable.
}

const manifest = {
  id: label,
  game,
  generation: Number(generation),
  published: new Date().toISOString().slice(0, 10),
  source: run,
  value,
  policy,
  ...(measured ? { measured } : {}),
};
writeFileSync(join(destination, 'bot.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`  -> ${destination}`);
if (measured?.baseline?.heuristic !== undefined) {
  console.log(`  measured: ${(measured.baseline.heuristic * 100).toFixed(0)}% against the heuristic search`);
}
