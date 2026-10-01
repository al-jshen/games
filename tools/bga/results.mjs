/**
 * The record of what happened, one line per game, and what can be said from it.
 *
 * JSONL because it is appended to by a program that may be killed at any moment and read by a
 * person with `less`. A row is written when a game ends and never rewritten.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fitRating } from './rating.mjs';

export function appendResult(file, row) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

export function readResults(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** BGA's `endReasons`, from `getEndReasons` in thoun/splendorduel. */
const REASON = { 1: 'prestige', 2: 'crowns', 3: 'colour' };

/**
 * Who won, from the snapshot of a finished game.
 *
 * BGA sets the winner's score to 1 and leaves the loser's at 0. Anything else -- an abandoned
 * table, a game BGA closed -- has no winner on the scoreboard and is recorded as `unknown`, which
 * the report then leaves out rather than guessing at.
 */
export function resultOf(snapshot) {
  const players = Object.values(snapshot.gamedatas.players);
  const mine = players.find((p) => p.id === snapshot.me);
  const theirs = players.find((p) => p.id !== snapshot.me);
  if (!mine || !theirs || mine.score === theirs.score) return { result: 'unknown', reason: 'other' };
  const winner = mine.score > theirs.score ? mine : theirs;
  return {
    result: winner === mine ? 'win' : 'loss',
    reason: REASON[winner.endReasons?.[0]] ?? 'other',
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function report(rows) {
  const decided = rows.filter((r) => r.result === 'win' || r.result === 'loss');
  const undecided = rows.length - decided.length;
  const byHand = decided.filter((r) => r.handedOver);
  const clean = decided.filter((r) => !r.handedOver);
  const unrated = clean.filter((r) => !Number.isFinite(r.opponentRating));
  const counted = clean.filter((r) => Number.isFinite(r.opponentRating));

  const left = [
    `  ${byHand.length} finished by hand after the adapter stopped`,
    `  ${unrated.length} with no opponent rating recorded`,
    `  ${undecided} with no recorded result`,
  ];
  if (counted.length === 0) return ['No games counted yet.', '', 'Not counted:', ...left].join('\n');

  const fit = fitRating(counted.map((r) => ({ opponent: r.opponentRating, score: r.result === 'win' ? 1 : 0 })));
  const wins = counted.filter((r) => r.result === 'win').length;
  const ratings = counted.map((r) => r.opponentRating);
  const mean = Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length);
  const modes = ['advise', 'play'].map((m) => `${m}: ${counted.filter((r) => r.mode === m).length}`).join(', ');

  let headline;
  if (fit.bound === 'at-least') headline = `  rating  at least ${Math.round(fit.low)}   (won every game; no upper estimate)`;
  else if (fit.bound === 'at-most') headline = `  rating  at most ${Math.round(fit.high)}   (lost every game; no lower estimate)`;
  else headline = `  rating  ${Math.round(fit.rating)}   95% interval ${Math.round(fit.low)} to ${Math.round(fit.high)}`;

  return [
    `Splendor Duel on BGA: ${plural(counted.length, 'game')} counted`,
    headline,
    `  record  ${plural(wins, 'win')}, ${plural(counted.length - wins, 'loss', 'losses')}   (${modes})`,
    `  opponents rated ${Math.min(...ratings)} to ${Math.max(...ratings)}, mean ${mean}`,
    '',
    'Not counted:',
    ...left,
    '',
    'Read this with care:',
    '  - These were friendly games against people who knew they were playing a bot. They may not have',
    '    played as they would for rating points, so treat this as a lower bar than an arena rating.',
    `  - The interval reflects only the number of games (${counted.length}). With few games it is wide enough`,
    '    that the middle of it means little.',
  ].join('\n');
}
