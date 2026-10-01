#!/usr/bin/env node
/**
 * Play Splendor Duel on boardgamearena.com with the published network.
 *
 *   npm run bga -- login                                    sign in to BGA, once, by hand
 *   npm run bga -- capture --table <url>                    save what the adapter sees; changes nothing
 *   npm run bga -- advise  --table <url> [--iterations N]   tell the operator what to play
 *   npm run bga -- play    --table <url> [--iterations N]   play the moves itself
 *   npm run bga -- watch   --table <url> [--iterations N]   a game you are not in: what the bot would play
 *
 * `capture` and `watch` only read, and take `--headless` to run with no window.
 *   npm run bga -- report                                   the rating the results so far support
 *
 * See README.md beside this file for the conditions this is used under. They are not optional.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { emptyMemory, parseSnapshot, stateKind } from '@games/bga-splendor-duel';
import { makeAdvise } from './advise.mjs';
import { headlessAllowed, parseArgs } from './args.mjs';
import { openBrowser } from './browser.mjs';
import { explainSettings, explainSnapshot } from './explain.mjs';
import { loadPublished, makeBrain } from './engine.mjs';
import { runTable } from './loop.mjs';
import { makePlay } from './play.mjs';
import { guard, playAllowed, tableMode } from './mode.mjs';
import { DATA, PROFILE, PUBLISHED, RESULTS } from './paths.mjs';
import { makeTable, playerIdsOf, tableIdOf } from './reader.mjs';
import { appendResult, readResults, report, resultOf } from './results.mjs';
import { introduce } from './session.mjs';
import { whoIs } from './suggest.mjs';
import { watchTable } from './watch.mjs';

function need(flags, name) {
  if (!flags[name]) throw new Error(`Missing --${name}.`);
  return flags[name];
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function save(folder, name, value) {
  const dir = join(DATA, folder);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

async function open(url, { log = () => {}, headless = false } = {}) {
  const tableId = tableIdOf(url);
  log(`opening a browser with the saved profile (${PROFILE})${headless ? ', with no window' : ''}`);
  const context = await openBrowser(PROFILE, { headless });
  const page = context.pages()[0] ?? (await context.newPage());
  log(`loading ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  log(`the browser is on ${page.url()}, titled "${await page.title().catch(() => '?')}"`);
  return { context, tableId, table: makeTable(page, tableId, { log }) };
}

async function login() {
  const context = await openBrowser(PROFILE);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://boardgamearena.com/account');
  console.log('Sign in to BGA in the window that just opened, then close the window.');
  console.log('This program never sees your password; the session stays in the browser profile.');
  await new Promise((resolve) => context.on('close', resolve));
}

/**
 * `capture` narrates itself. It is run by someone finding out what BGA's page really holds, usually
 * because something did not read as expected, and a tool that says nothing for a minute and then
 * prints three lines leaves them guessing which step went wrong.
 */
async function capture(flags) {
  const url = need(flags, 'table');
  const started = Date.now();
  const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${line}`);
  const detail = (lines) => lines.forEach((line) => console.log(`         ${line}`));

  log(`table ${tableIdOf(url)}`);

  const { context, tableId, table } = await open(url, { log, headless: flags.headless === true });
  try {
    // A capture is for finding out what the page really holds, so a part that fails is recorded and
    // the rest still taken: a refused snapshot still has ratings, a page that would not load still
    // has its URL and whatever `gameui` offers.
    let raw = null;
    let error = null;
    try {
      raw = await table.snapshot();
      detail(explainSnapshot(raw));
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
      log(`the game state could NOT be read: ${error}`);
    }
    const parsed = raw === null ? null : parseSnapshot(raw);
    if (parsed) log(parsed.ok ? 'checked against the schema: it matches' : `checked against the schema: REFUSED. ${parsed.refusal.detail}`);

    const playerIds = parsed?.ok ? Object.values(parsed.snapshot.gamedatas.players).map((p) => p.id) : playerIdsOf(raw);
    const facts = await table.facts(playerIds).catch((thrown) => {
      log(`asking for settings and ratings failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
      return { info: null, ratings: {} };
    });
    detail(explainSettings(facts.info));
    detail([`ratings: ${JSON.stringify(facts.ratings)}`]);

    const primitives = await table.primitives().catch((thrown) => ({ error: thrown instanceof Error ? thrown.message : String(thrown) }));
    detail([`${Object.keys(primitives).length} value(s) recorded`]);

    const schema = error ? `NOT READ: ${error}` : parsed.ok ? 'accepted' : parsed.refusal.detail;
    const file = save('captures', `${tableId}-${stamp()}.json`, {
      url,
      capturedAt: new Date().toISOString(),
      schema,
      error,
      raw,
      info: facts.info,
      ratings: facts.ratings,
      primitives,
    });
    log('done; closing the browser');
    console.log(`\nSaved ${file}`);
    console.log(`  snapshot: ${error ? `NOT READ: ${error}` : parsed.ok ? 'matches the schema' : `REFUSED: ${parsed.refusal.detail}`}`);
    console.log(`  game mode as read: ${tableMode(facts.info)}   (table settings ${facts.info ? 'received' : 'NOT received'})`);
    console.log(`  ratings as read: ${JSON.stringify(facts.ratings)}`);
  } finally {
    await context.close();
  }
}

/** What the opponent is told. Printed for the operator to post; this program does not post it. */
const NOTICE =
  'Hello! This seat is played by a bot: an in-house neural network with search that we are evaluating. ' +
  'This is a friendly, unrated game. Good luck, and thank you for playing it.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The search budget, held to the range the web client's dial allows. */
function iterationsOf(flags) {
  const n = Number(flags.iterations ?? 1000);
  if (!Number.isFinite(n)) throw new Error('--iterations must be a number.');
  return Math.min(5000, Math.max(100, Math.round(n)));
}

async function confirmPosted() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await rl.question('Type "posted" once that notice is in the table chat: ');
      if (answer.trim().toLowerCase() === 'posted') return;
    }
  } finally {
    rl.close();
  }
}

const signed = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

/**
 * Sit at a table in one of the two modes. `strategy(table)` returns the loop's `act`.
 *
 * The order here is the conditions of use, in code: nothing is advised or played until the table
 * has been shown to be friendly mode and the operator has confirmed the opponent was told.
 */
async function sit(mode, flags, strategy, { midActionPatienceMs = Infinity } = {}) {
  const url = need(flags, 'table');
  const iterations = iterationsOf(flags);
  const engine = loadPublished(PUBLISHED);
  const { context, tableId, table } = await open(url);

  // Until the loop starts nothing has been played, so any failure here closes the browser. Once it
  // has started, nothing below closes it: a game is in progress and the operator finishes it there.
  let mine, theirs, facts, memoryFile, seen;
  try {
    console.log(`\nTable ${tableId}:`);
    const first = await introduce({ table, say: (line) => console.log(line) });
    if (!first.ok) throw new Error(first.why);
    const players = Object.values(first.snapshot.gamedatas.players);
    facts = first.facts;
    const verdict = guard({ info: facts.info, tableId, snapshot: first.snapshot });
    if (!verdict.ok) {
      await context.close();
      console.error(`Refusing this table. ${verdict.why}`);
      process.exitCode = 2;
      return;
    }
    mine = players.find((p) => p.id === first.snapshot.me);
    theirs = players.find((p) => p.id !== first.snapshot.me);

    console.log(`\nFriendly mode. Playing generation ${engine.generation} at ${iterations} iterations, mode "${mode}".`);
    console.log('\nBefore the first move, post this in the table chat:\n');
    console.log(`  ${NOTICE}\n`);
    await confirmPosted();

    // Only the cards seen survive a restart. The rest of memory is about the turn in progress, and a
    // turn the adapter did not watch begin is one it should not pretend to remember.
    memoryFile = join(DATA, `${tableId}.memory.json`);
    seen = existsSync(memoryFile) ? JSON.parse(readFileSync(memoryFile, 'utf8')).seen : {};
    mkdirSync(DATA, { recursive: true });
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }

  const result = await runTable({
    table,
    brain: makeBrain(engine, iterations, tableId),
    act: strategy(table),
    say: (line) => console.log(line),
    sleep,
    memory: { ...emptyMemory(), seen },
    onMemory: (memory) => writeFileSync(memoryFile, JSON.stringify({ seen: memory.seen })),
    midActionPatienceMs,
  });

  let final = result.outcome === 'finished' ? result.snapshot : null;
  if (result.outcome === 'stopped') {
    process.stdout.write('\x07');
    const file = save('stops', `${tableId}-${stamp()}.json`, { refusal: result.refusal, raw: result.raw });
    console.log(`\nSTOPPED (${result.refusal.reason}). ${result.refusal.detail}`);
    console.log(`The snapshot is in ${file}.`);
    console.log('Finish the game by hand in the browser. This program does nothing more at this table,');
    console.log('and records the result once the game is over.');
    // Polls only, until the game is over or the operator closes the page. A page that has gone, or
    // a last reload that fails, is a result nobody can read: `unknown`, rather than a crash.
    for (;;) {
      if (table.closed()) break;
      const pulse = await table.pulse().catch(() => null);
      if (pulse && stateKind(pulse.name) === 'over') break;
      await sleep(2000);
    }
    if (!table.closed()) {
      const last = await table.snapshot().then(parseSnapshot, () => null);
      final = last?.ok ? last.snapshot : null;
    }
  }

  const row = {
    table: tableId,
    at: new Date().toISOString(),
    mode,
    generation: engine.generation,
    iterations,
    seat: (mine?.playerNo ?? 1) - 1,
    opponent: theirs?.id ?? null,
    opponentRating: theirs ? (facts.ratings[theirs.id] ?? null) : null,
    ...(final ? resultOf(final) : { result: 'unknown', reason: 'other' }),
    moves: result.moves,
    handedOver: result.outcome === 'stopped',
  };
  appendResult(RESULTS, row);
  console.log(`\nGame over: ${row.result} (${row.reason}). Recorded in ${RESULTS}.`);
  await context.close().catch(() => {});
}

/**
 * Put a suggestion in front of the person at the terminal: who is to move, the move, the clicks it
 * takes, and the pieces outlined on the page. `advise` and `watch` both print through this, so what
 * one shows for a position is what the other would.
 */
const presenter = (table) => async ({ seat, playerId, name, text, steps, highlight, value }) => {
  console.log(`\n▶ ${whoIs({ name, playerId, seat })} to move. The bot would play: ${text}    (search value ${signed(value)})`);
  steps.forEach((step, i) => console.log(`   ${i + 1}. ${step}`));
  await table.show(highlight);
};

const advise = (flags) => sit('advise', flags, (table) => makeAdvise({ present: presenter(table) }));

// In `play` the program makes both clicks of a two-part move itself, so a table left between them
// for half a minute is one whose second click never landed. In `advise` the operator takes as long
// as they like.
function play(flags) {
  const allowed = playAllowed();
  if (!allowed.ok) {
    console.error(`Refusing to play. ${allowed.why}`);
    process.exitCode = 2;
    return undefined;
  }
  return sit('play', flags, (table) => makePlay({ perform: (call) => table.perform(call), say: (line) => console.log(`\n${line}`) }), {
    midActionPatienceMs: 30_000,
  });
}

/**
 * A game the logged-in account is not in, with the bot's suggestion for whoever is to move.
 *
 * No guard, no notice, no result row: nothing is sent to the table and nobody at it is ours. The
 * one refusal is `watchTable`'s own -- a table we are seated at is not one to watch.
 */
async function watch(flags) {
  const url = need(flags, 'table');
  const iterations = iterationsOf(flags);
  const engine = loadPublished(PUBLISHED);
  const { context, tableId, table } = await open(url, { headless: flags.headless === true });
  try {
    console.log(`\nWatching table ${tableId}:`);
    const first = await introduce({ table, say: (line) => console.log(line) });
    if (!first.ok) throw new Error(first.why);
    console.log(`\nSuggestions are generation ${engine.generation} at ${iterations} iterations, made from what a spectator`);
    console.log("can see: neither player's face-down reservations are known.");
    const result = await watchTable({
      table,
      brain: makeBrain(engine, iterations, tableId),
      present: presenter(table),
      say: (line) => console.log(line),
      sleep,
    });
    if (result.outcome === 'refused') {
      console.error(`Not watching this table. ${result.why}`);
      process.exitCode = 2;
    } else if (result.outcome === 'stopped') {
      console.error(`\nStopped watching (${result.refusal.reason}). ${result.refusal.detail}`);
      process.exitCode = 1;
    } else {
      console.log(`\nThe game is over. ${result.suggestions} position(s) looked at.`);
    }
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.headless && !headlessAllowed(command)) {
    throw new Error(`--headless is for \`watch\` and \`capture\`, which only read. \`${command}\` needs the window: a person signs in, clicks, or takes the game over in it.`);
  }
  switch (command) {
    case 'login':
      return login();
    case 'capture':
      return capture(flags);
    case 'advise':
      return advise(flags);
    case 'play':
      return play(flags);
    case 'watch':
      return watch(flags);
    case 'report':
      return console.log(report(readResults(RESULTS)));
    default:
      console.log('Usage: npm run bga -- <login | capture --table <url> | advise --table <url> [--iterations N] | play --table <url> [--iterations N] | watch --table <url> [--iterations N] | report>   (capture and watch take --headless)');
      process.exitCode = command ? 2 : 0;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
