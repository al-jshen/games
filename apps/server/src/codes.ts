import { randomBytes } from 'node:crypto';
import { CODE_ALPHABET, CODE_LENGTH } from '@games/protocol';

/**
 * Codes are read aloud and typed by hand, so the alphabet drops every glyph pair that gets
 * misread: no `0/O`, no `1/I/L`, and no `U` (which removes most accidental profanity from a
 * vowel-poor alphabet). See `@games/protocol` for the alphabet itself.
 */

/** A handful of strings worth regenerating on, since `A` and `E` do survive the alphabet. */
const BLOCKED = ['ASSHAT', 'BADASS', 'DAMNED', 'FANNY', 'PENIS', 'SEXSEX', 'WANKER'];

function randomCode(): string {
  // Rejection sampling so every symbol is equally likely; modulo over 256 would bias the first
  // 16 characters of a 30-symbol alphabet.
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH * 2)) {
      if (byte >= limit) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/**
 * Generate a code not currently in use.
 *
 * `isTaken` must be checked and the code reserved in one synchronous block by the caller — a
 * check-then-insert with an `await` in between is a real race.
 */
export function generateCode(isTaken: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = randomCode();
    if (BLOCKED.some((bad) => code.includes(bad))) continue;
    if (!isTaken(code)) return code;
  }
  throw new Error('could not allocate an unused room code');
}
