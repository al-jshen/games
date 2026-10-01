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

const no = (why) => ({ ok: false, why });

/**
 * False until `play` has been watched through one whole live friendly game -- Task 12 Step 11 of
 * docs/superpowers/plans/2026-09-30-bga-adapter.md -- and the page's action API (`perform` in
 * reader.mjs, written from BGA's typings and never run against a live page) has been seen to send
 * every kind of call. Opening the mode check opens `advise`; it does not open `play`, which acts on
 * the table by itself and comes after an advised game in the order of work.
 */
export const PLAY_VERIFIED = false;

/** Whether the `play` command may run at all. Checked before a browser is opened. */
export function playAllowed({ verified = PLAY_VERIFIED } = {}) {
  if (verified !== true) {
    return no(
      '`play` has not yet been watched through a live friendly game (Task 12 Step 11 of docs/superpowers/plans/2026-09-30-bga-adapter.md). Use `advise` until then.',
    );
  }
  return { ok: true };
}

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

export function guard({ info, tableId, snapshot, verified = MODE_CHECK_VERIFIED }) {
  // Exactly `true`: a gate that a stray truthy value can open is not a gate.
  if (verified !== true) {
    return no('The friendly-mode check has not been confirmed against live tables yet (tools/bga/README.md, "Calibration").');
  }
  if (typeof tableId !== 'string' || !/^\d+$/.test(tableId)) {
    return no(`"${String(tableId)}" is not a BGA table id, so there is no table to check.`);
  }
  const data = info?.data ?? info;
  if (String(data?.id) !== tableId) {
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
