/**
 * Whether this is a table the adapter may sit at.
 *
 * Both `advise` and `play` go through `guard`, and neither does anything until it says yes. The
 * rule is friendly mode only: unrated, with an opponent who has been told the seat is a bot. An
 * advisor that worked on a rated table would be a cheating aid, whatever was intended by building
 * it, so "cannot tell" is a refusal and not a warning.
 */

/**
 * False until the check below has been confirmed against a live friendly table AND a live rated
 * one -- see Task 11 of docs/superpowers/plans/2026-09-30-bga-adapter.md. While it is false, every
 * table is refused. `tableMode` is written from memory of BGA's table settings, not from its
 * published source, and a mode check that has never been seen to say "rated" is not a check.
 */
export const MODE_CHECK_VERIFIED = false;

/** BGA's reserved table option for the game mode: 0 normal, 1 friendly ("training"), 2 arena. */
const GAME_MODE_OPTION = '201';

export function tableMode(info) {
  const data = info?.data ?? info;
  const option = data?.options?.[GAME_MODE_OPTION];
  const value = option !== null && typeof option === 'object' ? option.value : option;
  if (value === undefined || value === null) return 'unknown';
  if (String(value) === '1') return 'friendly';
  if (String(value) === '0' || String(value) === '2') return 'rated';
  return 'unknown';
}

const no = (why) => ({ ok: false, why });

export function guard({ info, tableId, snapshot, verified = MODE_CHECK_VERIFIED }) {
  if (!verified) {
    return no('The friendly-mode check has not been confirmed against live tables yet (tools/bga/README.md, "Calibration").');
  }
  const data = info?.data ?? info;
  if (String(data?.id) !== String(tableId)) {
    return no("Could not read this table's settings, so cannot tell whether it is friendly mode.");
  }
  const mode = tableMode(info);
  if (mode === 'unknown') return no("This table's game mode could not be read, so it is treated as rated.");
  if (mode !== 'friendly') return no('This is a rated table. The adapter only sits at friendly-mode tables.');
  if (snapshot.gamedatas.expansion) return no('The Counterfeiters expansion is enabled on this table.');
  if (!Object.values(snapshot.gamedatas.players).some((p) => p.id === snapshot.me)) {
    return no('The logged-in account is not seated at this table.');
  }
  return { ok: true };
}
