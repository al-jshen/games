#!/usr/bin/env node
/**
 * Play Splendor Duel on boardgamearena.com with the published network.
 *
 *   npm run bga -- login                       sign in to BGA, once, by hand
 *   npm run bga -- capture --table <url>       save what the adapter sees at a table; changes nothing
 *   npm run bga -- report                      the rating the results so far support
 *
 * See README.md beside this file for the conditions this is used under. They are not optional.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSnapshot } from '@games/bga-splendor-duel';
import { openBrowser } from './browser.mjs';
import { tableMode } from './mode.mjs';
import { DATA, PROFILE, RESULTS } from './paths.mjs';
import { makeTable, tableIdOf } from './reader.mjs';
import { readResults, report } from './results.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (!name?.startsWith('--') || rest[i + 1] === undefined) throw new Error(`Expected "--name value", got "${rest.slice(i).join(' ')}".`);
    flags[name.slice(2)] = rest[i + 1];
  }
  return { command, flags };
}

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

async function open(url) {
  const tableId = tableIdOf(url);
  const context = await openBrowser(PROFILE);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { context, tableId, table: makeTable(page, tableId) };
}

async function login() {
  const context = await openBrowser(PROFILE);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://boardgamearena.com/account');
  console.log('Sign in to BGA in the window that just opened, then close the window.');
  console.log('This program never sees your password; the session stays in the browser profile.');
  await new Promise((resolve) => context.on('close', resolve));
}

async function capture(flags) {
  const url = need(flags, 'table');
  const { context, tableId, table } = await open(url);
  try {
    const raw = await table.snapshot();
    const parsed = parseSnapshot(raw);
    const playerIds = parsed.ok ? Object.values(parsed.snapshot.gamedatas.players).map((p) => p.id) : [];
    const facts = await table.facts(playerIds);
    const primitives = await table.primitives();
    const file = save('captures', `${tableId}-${stamp()}.json`, {
      url,
      capturedAt: new Date().toISOString(),
      schema: parsed.ok ? 'accepted' : parsed.refusal.detail,
      raw,
      info: facts.info,
      ratings: facts.ratings,
      primitives,
    });
    console.log(`Saved ${file}`);
    console.log(`  snapshot: ${parsed.ok ? 'matches the schema' : `REFUSED: ${parsed.refusal.detail}`}`);
    console.log(`  game mode as read: ${tableMode(facts.info)}   (table settings ${facts.info ? 'received' : 'NOT received'})`);
    console.log(`  ratings as read: ${JSON.stringify(facts.ratings)}`);
  } finally {
    await context.close();
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'login':
      return login();
    case 'capture':
      return capture(flags);
    case 'report':
      return console.log(report(readResults(RESULTS)));
    default:
      console.log('Usage: npm run bga -- <login | capture --table <url> | report>');
      process.exitCode = command ? 2 : 0;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
