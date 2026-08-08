#!/usr/bin/env node
/**
 * Head-to-head matches, and an honest interval around the result.
 *
 * Everything else in this directory measures a *proxy*: held-out mean squared error, cross entropy,
 * agreement with the search. Those are cheap and they are what makes iteration possible, but none of
 * them is the thing we actually want. A leaf evaluator with lower error can still lose games -- it
 * costs more per call, so at a fixed time budget it buys fewer iterations, and a search that is
 * slightly better informed but a third as deep is usually worse. Only playing decides that.
 *
 *   node tools/selfplay/arena.mjs --a '{}' --a-net .data/models/value-gen0 --b '{}'
 *   node tools/selfplay/arena.mjs --a '{"iterations":1200}' --b '{}' --pairs 200
 *   node tools/selfplay/arena.mjs --a random --b '{}' --pairs 50
 *
 * Two things it does that a naive match runner does not, both aimed at the same problem -- that
 * matches are enormously noisy and it is very easy to believe a result that is not there.
 */

import { BASELINE, DEFAULT_CONFIG } from '@games/bot-ismcts';
import { defaultWorkers, runJobs } from './pool.mjs';
import { writeFileSync } from 'node:fs';
import { requireFreshBuild } from './fresh.mjs';

requireFreshBuild();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

/** Paired *deals*. Each one is played twice, so the game count is twice this. */
const PAIRS = Number(flag('pairs', '100'));
const ITERATIONS = Number(flag('iterations', '300'));
const WORKERS = Number(flag('workers', String(defaultWorkers())));
const SEED = flag('seed', 'arena');
const LABEL_A = flag('label-a', 'A');
const LABEL_B = flag('label-b', 'B');
/*
 * Where to write the result as JSON, for a caller that has to *decide* something rather than read
 * it. The orchestrator gates a promotion on the score, and scraping that out of prose printed for a
 * human is the kind of coupling that breaks silently the first time the wording changes.
 */
const REPORT = flag('report', null);

/**
 * A player from a command line argument.
 *
 * `random` for the sanity check, `baseline` for plain ISMCTS with every extra off, and otherwise a
 * JSON patch over the tuned defaults -- so a matchup is written as the difference between the two
 * sides rather than as two full configurations, which is how it is actually thought about.
 */
function parsePlayer(spec, net, policy) {
  if (spec === 'random') return (seed) => ({ kind: 'random', seed });
  const base = spec === 'baseline' ? BASELINE : DEFAULT_CONFIG;
  const overrides = spec === 'baseline' || spec === 'default' ? {} : JSON.parse(spec);
  /*
   * A network implies no rollout, unless the caller insists otherwise. The default leaf is `mixed`,
   * and a network under `mixed` would be called once at the leaf and then up to forty more times
   * inside the playout -- forty times the cost for a playout the network was meant to replace. It is
   * a legitimate configuration and it is never the one anybody means, so it has to be asked for.
   */
  if (net && overrides.leaf === undefined) overrides.leaf = 'evaluate';
  // A policy net is only ever wanted for its priors, and priors are only read under `puct`.
  if (policy && overrides.selection === undefined) overrides.selection = 'puct';
  return (seed) => ({
    kind: 'ismcts',
    config: { ...base, iterations: ITERATIONS, ...overrides, seed },
    net,
    policy,
  });
}

/**
 * Wilson score interval.
 *
 * Not the textbook `p ± 1.96·sqrt(p(1-p)/n)`, which is wrong in exactly the cases a match runner
 * hits: it gives an interval that includes 100% at 20-0, and a zero-width interval at 20-0 or 0-20.
 * Wilson stays inside [0,1] and stays sane at the extremes, which is where a promising new evaluator
 * usually lands on its first fifty games.
 */
function wilson(successes, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

/** The usual conversion, with the ends clamped: an unbeaten player is not infinitely strong on n games. */
function elo(score) {
  const clamped = Math.min(1 - 1e-9, Math.max(1e-9, score));
  return (-400 * Math.log10(1 / clamped - 1));
}

/**
 * Every deal twice, with the seats swapped the second time.
 *
 * `selfplay.mjs` alternates who moves first across *different* deals, which removes the first-player
 * advantage from the average but leaves all the variance of the deals themselves. Playing the same
 * deal both ways instead turns the comparison into a paired one: whatever that particular setup was
 * worth is subtracted out, because both sides got it. In a game where one opening layout can hand
 * over the game, that is most of the noise.
 */
function buildJobs(makeA, makeB) {
  const jobs = [];
  for (let pair = 0; pair < PAIRS; pair++) {
    for (const aFirst of [true, false]) {
      const side = aFirst ? 'x' : 'y';
      jobs.push({
        seed: `${SEED}-${pair}`,
        aFirst,
        a: makeA(`a:${SEED}:${pair}:${side}`),
        b: makeB(`b:${SEED}:${pair}:${side}`),
      });
    }
  }
  return jobs;
}

const NET_A = flag('a-net', null);
const NET_B = flag('b-net', null);
const POLICY_A = flag('a-policy', null);
const POLICY_B = flag('b-policy', null);
const makeA = parsePlayer(flag('a', 'default'), NET_A, POLICY_A);
const makeB = parsePlayer(flag('b', 'default'), NET_B, POLICY_B);
const jobs = buildJobs(makeA, makeB);

const describe = (spec, net, policy, make) => {
  // A random player has no search config at all, which this line used to assume it did.
  const { config } = make('x');
  if (!config) return spec;
  const puct = config.selection === 'puct' ? ` puctDepth=${config.puctDepth} c=${config.puctExploration}` : '';
  return `${spec}${net ? `  net=${net}` : ''}${policy ? `  policy=${policy}` : ''}` +
    `  leaf=${config.leaf} select=${config.selection}${puct} iterations=${config.iterations}`;
};
console.log(`Arena — ${LABEL_A} vs ${LABEL_B}`);
console.log(`  ${PAIRS} deals played both ways = ${jobs.length} games, ${WORKERS} workers`);
console.log(`  A: ${describe(flag('a', 'default'), NET_A, POLICY_A, makeA)}`);
console.log(`  B: ${describe(flag('b', 'default'), NET_B, POLICY_B, makeB)}\n`);

let winsA = 0;
let winsB = 0;
let draws = 0;
let moves = 0;
let done = 0;
const started = Date.now();

await runJobs(jobs, WORKERS, (result) => {
  moves += result.moves;
  if (result.aWon === null) draws += 1;
  else if (result.aWon) winsA += 1;
  else winsB += 1;
  done += 1;
  if (done % 20 === 0 || done === jobs.length) {
    const rate = done / ((Date.now() - started) / 1000);
    const left = (jobs.length - done) / rate;
    process.stdout.write(
      `\r  ${done}/${jobs.length}  ${winsA}-${winsB}${draws ? `-${draws}` : ''}  ` +
        `${rate.toFixed(2)} games/s  ${left > 1 ? `${Math.round(left / 60)}m left` : 'done'}   `,
    );
  }
});
process.stdout.write('\n\n');

const seconds = (Date.now() - started) / 1000;
/*
 * Draws count a half each, the convention every rating system uses. Here they are mostly stalls --
 * the 60-turn house rule firing rather than a genuine tie -- so they are reported separately too:
 * a matchup that stalls often is telling you something the score alone hides.
 */
const score = (winsA + draws / 2) / jobs.length;
const [lo, hi] = wilson(winsA + draws / 2, jobs.length);

/*
 * Both figures are from A's side, and both say so. The convention is universal and it is still not
 * good enough here: a bare "score 0.0%" next to a line reading "random 0 - 12 ismcts" was misread as
 * the search losing every game, which is the opposite of the result. A number meant to settle an
 * argument should not need the reader to know whose side it is on.
 */
console.log(`  ${LABEL_A} ${winsA} — ${winsB} ${LABEL_B}${draws ? `, ${draws} drawn or stalled` : ''}`);
console.log(
  `  ${LABEL_A} scores ${(score * 100).toFixed(1)}%   95% CI [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]`,
);
console.log(
  `  ${LABEL_A} elo ${elo(score) >= 0 ? '+' : ''}${elo(score).toFixed(0)} relative to ${LABEL_B}` +
    `   [${elo(lo).toFixed(0)}, ${elo(hi).toFixed(0)}]`,
);
console.log(`  ${(moves / jobs.length).toFixed(0)} moves/game, ${seconds.toFixed(0)}s total\n`);

/*
 * State the verdict rather than leaving a number to be read hopefully. The interval is the whole
 * point of running the match: 55% over 40 games and 55% over 4,000 games are the same number and
 * completely different findings, and only one of them should change anyone's mind.
 */
if (REPORT) {
  writeFileSync(
    REPORT,
    `${JSON.stringify(
      {
        a: { label: LABEL_A, spec: flag('a', 'default'), net: NET_A, policy: POLICY_A },
        b: { label: LABEL_B, spec: flag('b', 'default'), net: NET_B, policy: POLICY_B },
        games: jobs.length,
        pairs: PAIRS,
        iterations: ITERATIONS,
        winsA,
        winsB,
        draws,
        // Draws count a half, as in the printed line. `score` is A's, like everything else here.
        score,
        ci: [lo, hi],
        elo: elo(score),
        eloCi: [elo(lo), elo(hi)],
        significant: lo > 0.5 || hi < 0.5,
        seconds,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`  wrote ${REPORT}`);
}

if (lo > 0.5) {
  console.log(`  ${LABEL_A} is stronger. The interval clears 50%, so this is a result.`);
} else if (hi < 0.5) {
  console.log(`  ${LABEL_B} is stronger. The interval clears 50%, so this is a result.`);
} else {
  // How many games it would take, at the observed rate, for that interval to clear 50%. Usually the
  // most useful line in the output: it turns "inconclusive" into a decision about whether to bother.
  const edge = Math.abs(score - 0.5);
  const needed = edge < 1e-6 ? Infinity : Math.ceil((1.96 / (2 * edge)) ** 2);
  console.log(`  No result: the interval spans 50%. At this rate it would take about`);
  console.log(
    Number.isFinite(needed)
      ? `  ${needed.toLocaleString()} games (${Math.ceil(needed / 2).toLocaleString()} deals) to separate them, ~${((needed / jobs.length) * seconds / 60).toFixed(0)} minutes.`
      : '  an unbounded number of games — they are indistinguishable.',
  );
}
