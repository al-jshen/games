#!/usr/bin/env node
/**
 * Build `packages/games/splendor-duel/data/cards.json` from splendortactics.com.
 *
 * Why scrape rather than hand-type: the site's 71 card pages are server-rendered and were diffed
 * field-by-field against the official BoardGameArena implementation (thoun/splendorduel,
 * material.inc.php). Points, crowns, cost and abilities match exactly on all 71 cards.
 *
 * The site has exactly one gap: **bonus count**. Five level-2 cards grant two bonuses of their
 * colour and the page prints only the colour. Those five are patched below.
 *
 * Every published fan dataset we surveyed has at least one transcription error, so this script
 * refuses to emit a file unless a battery of whole-deck totals and one known-bad regression card
 * all check out. Run with `npm run cards`.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME = resolve(HERE, '../../packages/games/splendor-duel');
/** Reviewable artefact, also consumed by the Python SDK and by debugging tools. */
const OUT_JSON = resolve(GAME, 'data/cards.json');
/** What the engine actually imports — a TS module, so no JSON-import flags in Node or Vite. */
const OUT_TS = resolve(GAME, 'src/cards.generated.ts');

const BASE = 'https://splendortactics.com/cards';
const CONCURRENCY = 8;

/** The five level-2 cards whose bonus corner shows two gems; the site renders only the colour. */
const DOUBLE_BONUS = new Set(['l2-04', 'l2-08', 'l2-12', 'l2-16', 'l2-20']);

const COLORS = ['white', 'blue', 'green', 'red', 'black'];
const PAY = [...COLORS, 'pearl'];

/** Site ability wording -> our ability tags. */
const ABILITY = {
  'Take another turn': 'playAgain',
  'Take a gem of the same color': 'takeMatchingToken',
  'Steal a gem from opponent': 'stealToken',
  'Gain a privilege': 'takePrivilege',
};

function slugs() {
  const out = [];
  for (let i = 1; i <= 30; i++) out.push(`l1-${String(i).padStart(2, '0')}`);
  for (let i = 1; i <= 24; i++) out.push(`l2-${String(i).padStart(2, '0')}`);
  for (let i = 1; i <= 13; i++) out.push(`l3-${String(i).padStart(2, '0')}`);
  for (let i = 1; i <= 4; i++) out.push(`royal-${String(i).padStart(2, '0')}`);
  return out;
}

async function fetchText(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'games-monorepo/card-import' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt >= 4) throw new Error(`${url}: ${err.message}`);
    await new Promise((r) => setTimeout(r, 400 * attempt));
    return fetchText(url, attempt + 1);
  }
}

/**
 * Reduce the page's <main> to a flat `|`-separated field list. The site renders a field only when
 * it is non-zero, so absence of `Crowns` means zero, not "unknown".
 */
function fields(html) {
  const main = /<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? html;
  return main
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '|')
    .replace(/\|+/g, '|')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&apos;/g, "'")
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCard(slug, html) {
  const f = fields(html);
  const after = (label) => {
    const i = f.indexOf(label);
    return i === -1 ? null : f[i + 1] ?? null;
  };

  const isRoyal = slug.startsWith('royal-');
  const level = isRoyal ? 0 : Number(slug[1]);

  const points = Number(after('Points') ?? 0);
  const crowns = Number(after('Crowns') ?? 0);

  // Cost entries look like "6 White" / "1 Pearl", between the `Cost` label and the next label.
  const cost = {};
  const ci = f.indexOf('Cost');
  if (ci !== -1) {
    for (let i = ci + 1; i < f.length; i++) {
      const m = /^(\d+)\s+(White|Blue|Green|Red|Black|Pearl)$/.exec(f[i]);
      if (!m) break;
      cost[m[2].toLowerCase()] = Number(m[1]);
    }
  }

  // `Gem Bonus` is a colour, or "Associate" for the wild cards, or absent for the 3 no-bonus cards.
  const gemBonus = after('Gem Bonus');
  let bonusColor = null;
  let wild = false;
  if (gemBonus === 'Associate') wild = true;
  else if (gemBonus) bonusColor = gemBonus.toLowerCase();

  const abilities = [];
  const abilityText = after('Ability');
  if (abilityText) {
    const tag = ABILITY[abilityText];
    if (!tag) throw new Error(`${slug}: unrecognised ability "${abilityText}"`);
    abilities.push(tag);
  }
  // The wild bonus is an ability in its own right (BGA calls it POWER_MULTICOLOR); the site
  // expresses it through `Gem Bonus: Associate` instead of the Ability field.
  if (wild) abilities.push('wildBonus');

  const bonusCount = wild ? 1 : bonusColor ? (DOUBLE_BONUS.has(slug) ? 2 : 1) : 0;

  return {
    id: slug,
    kind: isRoyal ? 'royal' : 'jewel',
    level,
    name: f[0],
    points,
    crowns,
    bonusColor,
    bonusCount,
    wild,
    cost,
    abilities: abilities.sort(),
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/* ------------------------------------------------------------------ validation */

const problems = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) problems.push(`${label}: got ${a}, expected ${e}`);
}

function validate(cards) {
  const jewels = cards.filter((c) => c.kind === 'jewel');
  const royals = cards.filter((c) => c.kind === 'royal');
  const byLevel = (n) => jewels.filter((c) => c.level === n);
  const sum = (xs, f) => xs.reduce((t, x) => t + f(x), 0);
  const count = (xs, f) => xs.filter(f).length;

  check('total cards', cards.length, 71);
  check('level 1 count', byLevel(1).length, 30);
  check('level 2 count', byLevel(2).length, 24);
  check('level 3 count', byLevel(3).length, 13);
  check('royal count', royals.length, 4);

  check('jewel prestige total', sum(jewels, (c) => c.points), 92);
  check('royal prestige total', sum(royals, (c) => c.points), 9);
  check('crown total', sum(jewels, (c) => c.crowns), 28);
  check('cards with 1 crown', count(jewels, (c) => c.crowns === 1), 11);
  check('cards with 2 crowns', count(jewels, (c) => c.crowns === 2), 7);
  check('cards with 3 crowns', count(jewels, (c) => c.crowns === 3), 1);
  check('royals carry no crowns', count(royals, (c) => c.crowns !== 0), 0);

  check('double-bonus cards', count(jewels, (c) => c.bonusCount === 2), 5);
  check('double-bonus are all level 2', count(jewels, (c) => c.bonusCount === 2 && c.level === 2), 5);
  check('wild cards', count(jewels, (c) => c.wild), 9);
  check('wild by level', [1, 2, 3].map((n) => count(byLevel(n), (c) => c.wild)), [4, 3, 2]);
  check('no-bonus cards', count(jewels, (c) => !c.wild && c.bonusColor === null), 3);
  check(
    'no-bonus prestige values',
    jewels.filter((c) => !c.wild && c.bonusColor === null).map((c) => c.points).sort((a, b) => a - b),
    [3, 5, 6],
  );

  const withAbility = (tag) => count(jewels, (c) => c.abilities.includes(tag));
  check('playAgain cards', withAbility('playAgain'), 6);
  check('takeMatchingToken cards', withAbility('takeMatchingToken'), 5);
  check('takePrivilege cards', withAbility('takePrivilege'), 5);
  check('stealToken cards', withAbility('stealToken'), 5);
  check('wildBonus cards', withAbility('wildBonus'), 9);
  check('cards with two abilities', count(jewels, (c) => c.abilities.length === 2), 1);
  check(
    'takeMatchingToken is level 1 only',
    count(jewels, (c) => c.abilities.includes('takeMatchingToken') && c.level !== 1),
    0,
  );
  check(
    'steal/privilege are level 2 only',
    count(
      jewels,
      (c) =>
        (c.abilities.includes('stealToken') || c.abilities.includes('takePrivilege')) && c.level !== 2,
    ),
    0,
  );

  // Every colour appears equally often at each level: 5 / 4 / 2 cards per colour.
  for (const [level, per] of [[1, 5], [2, 4], [3, 2]]) {
    for (const color of COLORS) {
      check(`level ${level} ${color} cards`, count(byLevel(level), (c) => c.bonusColor === color), per);
    }
  }

  // Royal abilities: 2pt steal, 2pt extra turn, 2pt privilege, 3pt nothing.
  check(
    'royal signatures',
    royals.map((c) => `${c.points}:${c.abilities.join('+') || 'none'}`).sort(),
    ['2:playAgain', '2:stealToken', '2:takePrivilege', '3:none'],
  );
  check('royals have no cost', count(royals, (c) => Object.keys(c.cost).length > 0), 0);

  // Pearls are never discounted (no pearl bonuses exist) and never exceed 1 in a cost.
  check('max pearls in a cost', Math.max(...jewels.map((c) => c.cost.pearl ?? 0)), 1);
  check('no pearl bonus exists', count(jewels, (c) => c.bonusColor === 'pearl'), 0);

  // Cross-source regression: three published datasets get this card wrong. Reproducing it
  // exactly is strong evidence the ingest is sound.
  const l127 = cards.find((c) => c.id === 'l1-27');
  check(
    'l1-27 regression (wild, 4 white + 1 pearl, 1 crown, 0 points)',
    l127 && { cost: l127.cost, crowns: l127.crowns, points: l127.points, wild: l127.wild },
    { cost: { white: 4, pearl: 1 }, crowns: 1, points: 0, wild: true },
  );

  // Shape sanity on every card.
  for (const c of cards) {
    for (const k of Object.keys(c.cost)) {
      if (!PAY.includes(k)) problems.push(`${c.id}: unknown cost key ${k}`);
      if (!Number.isInteger(c.cost[k]) || c.cost[k] <= 0) problems.push(`${c.id}: bad cost ${k}`);
    }
    if (c.wild && c.bonusColor !== null) problems.push(`${c.id}: wild card must not fix a colour`);
    if (c.kind === 'jewel' && Object.keys(c.cost).length === 0) problems.push(`${c.id}: jewel with no cost`);
  }
}

/* ------------------------------------------------------------------ main */

const ids = slugs();
process.stdout.write(`Fetching ${ids.length} card pages from splendortactics.com ...\n`);
const cards = await mapLimit(ids, CONCURRENCY, async (slug) =>
  parseCard(slug, await fetchText(`${BASE}/${slug}`)),
);

validate(cards);
if (problems.length > 0) {
  console.error(`\nCard data FAILED validation (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nRefusing to write cards.json.');
  process.exit(1);
}

const PROVENANCE =
  'Generated by tools/scrape-cards -- DO NOT EDIT BY HAND.\n' +
  'Source: splendortactics.com card pages, verified field-by-field against the official\n' +
  'BoardGameArena implementation (thoun/splendorduel, material.inc.php).\n' +
  'bonusCount for l2-04/08/12/16/20 is patched to 2: those five level-2 cards grant two bonuses\n' +
  'of their colour and the source renders only the colour, not its multiplicity.\n' +
  'Regenerate with `npm run cards`; the generator self-validates against whole-deck totals and\n' +
  'refuses to write on any mismatch.';

await mkdir(dirname(OUT_JSON), { recursive: true });
await writeFile(OUT_JSON, `${JSON.stringify({ $comment: PROVENANCE, cards }, null, 2)}\n`);

await mkdir(dirname(OUT_TS), { recursive: true });
const ts = [
  '/* eslint-disable */',
  `/**\n${PROVENANCE.split('\n').map((l) => ` * ${l}`).join('\n')}\n */`,
  '',
  "import type { CardDef } from './types.js';",
  '',
  'export const CARD_DEFS: readonly CardDef[] = [',
  ...cards.map((c) => `  ${JSON.stringify(c)},`),
  '];',
  '',
].join('\n');
await writeFile(OUT_TS, ts);

process.stdout.write(`All checks passed.\n  wrote ${OUT_JSON}\n  wrote ${OUT_TS}\n`);
