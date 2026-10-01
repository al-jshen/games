/**
 * What `capture` saw, in a few lines a person can read while it runs.
 *
 * `capture` exists for finding out what BGA's page really holds, and it is mostly run when the
 * adapter's picture of the page is wrong. So nothing here assumes the shapes the rest of the tool
 * relies on: every field is read defensively, and what is missing is named rather than thrown on.
 * The full data is in the saved file; this is the part worth seeing scroll past.
 */

const count = (value) => (Array.isArray(value) ? String(value.length) : '?');
const byLevel = (value, each) => [1, 2, 3].map((level) => each(value?.[level])).join('/');

/** A raw snapshot (what `table.snapshot()` returns, before the schema), as lines of text. */
export function explainSnapshot(raw) {
  if (raw === null || typeof raw !== 'object') return ['nothing was read from the page'];
  const state = raw.gamestate ?? {};
  const data = raw.gamedatas ?? {};
  const ids = data.players !== null && typeof data.players === 'object' ? Object.keys(data.players) : [];
  const seated = ids.includes(String(raw.me));
  return [
    `state "${state.name ?? '?'}", player ${state.active_player ?? '?'} to act`,
    `logged in as player ${raw.me ?? '?'}, ${seated ? 'seated at this table' : 'NOT seated (watching)'}`,
    `players: ${ids.length > 0 ? ids.join(', ') : 'none found'}`,
    `${count(data.board)} tokens on the board, table cards ${byLevel(data.tableCards, count)}, ` +
      `decks ${byLevel(data.cardDeckCount, (n) => n ?? '?')}, ${count(data.royalCards)} royal cards, ` +
      `expansion ${data.expansion === true ? 'ON' : data.expansion === false ? 'off' : '?'}`,
  ];
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** BGA's answer about the table's settings (what `table.facts()` returns as `info`), as lines of text. */
export function explainSettings(info) {
  if (info === null || info === undefined) {
    return ['no answer: the request failed, timed out, or this is not how BGA serves table settings'];
  }
  const data = info.data ?? info;
  const options = data !== null && typeof data === 'object' ? data.options : undefined;
  const hasOptions = options !== null && typeof options === 'object';
  const mode = hasOptions ? options['201'] : undefined;
  return [
    `fields: ${Object.keys(data ?? {}).slice(0, 40).join(', ') || 'none'}`,
    `table id in the answer: ${data?.id ?? 'absent'}`,
    hasOptions ? `options present: ${Object.keys(options).join(', ')}` : 'no `options` in the answer',
    clip(`option 201 (assumed to be the game mode): ${mode === undefined ? 'absent' : JSON.stringify(mode)}`, 300),
  ];
}
