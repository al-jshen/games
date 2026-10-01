/* global gameui, document */

/**
 * The only code that evaluates anything inside the BGA page.
 *
 * Everything else in the adapter works on plain objects this file hands over, which is what lets it
 * be tested without a browser. What is read here is what the page was given for the logged-in seat:
 * `gameui.gamedatas`, the full state BGA builds on every page load. To get a current one, the page
 * is reloaded -- the same thing pressing F5 does, and the one way the page offers.
 *
 * Deliberately not read: BGA's notification stream. It would save the reloads, and it carries cards
 * this seat is not shown. See the spec.
 */

export function tableIdOf(url) {
  const id = new URL(url).searchParams.get('table');
  if (!id || !/^\d+$/.test(id)) {
    throw new Error(`No table id in "${url}". Pass the game's own URL, like https://boardgamearena.com/1/splendorduel?table=123456789`);
  }
  return id;
}

/**
 * Whether `url` is the page of table `tableId`.
 *
 * The guard vets one table, once. The controlled tab can still be navigated to another Splendor
 * Duel game the account is seated at, and that page would read just as well -- so everything that
 * reads or acts checks first that the page is still the table that was vetted.
 */
export function sameTable(url, tableId) {
  try {
    const id = new URL(url).searchParams.get('table');
    return typeof tableId === 'string' && /^\d+$/.test(tableId) && id === tableId;
  } catch {
    return false;
  }
}

/** Throws unless the page is still on table `tableId`, naming where it is instead. */
function stillOn(page, tableId) {
  const url = page.url();
  if (sameTable(url, tableId)) return;
  let other = null;
  try {
    other = new URL(url).searchParams.get('table');
  } catch {
    // Not a URL at all; name it as it is.
  }
  throw new Error(`The browser is no longer on table ${tableId}: it is on ${other ? `table ${other} (${url})` : `"${url}"`}.`);
}

/**
 * The seated players' ids, from a raw snapshot whether or not the schema accepted it -- so that
 * `capture` can still read ratings from a page whose state has changed shape. Empty when there is
 * nothing to read them from.
 */
export function playerIdsOf(raw) {
  const players = raw?.gamedatas?.players;
  if (players === null || typeof players !== 'object' || Array.isArray(players)) return [];
  return Object.keys(players);
}

async function ready(page) {
  try {
    await page.waitForFunction(
      () => typeof gameui !== 'undefined' && gameui !== null && Boolean(gameui.gamedatas?.gamestate) && Boolean(document.getElementById('board')),
      null,
      { timeout: 60_000 },
    );
  } catch {
    // Say where the browser actually is: the commonest cause is a URL that is about the table but
    // is not the game -- the table's own page carries the same id and none of the game state.
    throw new Error(
      `The page at ${page.url()} did not become a Splendor Duel game within a minute. ` +
        'Is that the game itself (https://boardgamearena.com/<number>/splendorduel?table=…) and not the table\'s page, ' +
        'is the game in progress, and is the browser signed in (`npm run bga -- login`)?',
    );
  }
}

function readRaw(page, tableId) {
  return page.evaluate((id) => {
    const g = gameui.gamedatas;
    // Through JSON, so what crosses to node is data and nothing else: no functions, no DOM nodes.
    return JSON.parse(
      JSON.stringify({
        tableId: id,
        me: gameui.player_id,
        gamestate: { name: g.gamestate.name, active_player: g.gamestate.active_player ?? null, args: g.gamestate.args ?? null },
        gamedatas: {
          players: g.players,
          board: g.board,
          cardDeckCount: g.cardDeckCount,
          cardDeckTop: g.cardDeckTop,
          tableCards: g.tableCards,
          royalCards: g.royalCards,
          expansion: g.expansion,
        },
      }),
    );
  }, tableId);
}

function readPulse(page) {
  return page.evaluate(() => {
    const state = gameui.gamedatas.gamestate;
    return { name: String(state.name), active: Number(state.active_player ?? 0), args: JSON.stringify(state.args ?? null) };
  });
}

/**
 * `log`, when given, is told each thing done to the page as it is done. `capture` passes one, so
 * the person calibrating can watch; `advise` and `play` do not, and stay quiet.
 */
export function makeTable(page, tableId, { log = () => {} } = {}) {
  return {
    /** A full, current snapshot. Reloads the page. */
    async snapshot() {
      log('reloading the page');
      await page.reload({ waitUntil: 'domcontentloaded' });
      log('waiting for the game to finish loading (gameui, its game state, and the board), up to a minute');
      await ready(page);
      stillOn(page, tableId);
      log('reading the game state the page was given (gameui.gamedatas)');
      return readRaw(page, tableId);
    },

    /** The state's name, whose turn it is, and its arguments. Cheap; does not reload. */
    async pulse() {
      stillOn(page, tableId);
      try {
        return await readPulse(page);
      } catch {
        // The page was mid-navigation. Wait for it to be a game again and ask once more.
        await ready(page);
        stillOn(page, tableId);
        return readPulse(page);
      }
    },

    /** Whether the operator has closed the page. */
    closed() {
      return page.isClosed();
    },

    /** Outline these elements on the page, and nothing else. */
    async show(ids) {
      await page.evaluate((wanted) => {
        const STYLE = 'bga-adapter-style';
        const HINT = 'bga-adapter-hint';
        if (!document.getElementById(STYLE)) {
          const style = document.createElement('style');
          style.id = STYLE;
          style.textContent = `.${HINT} { outline: 5px solid #ff2fd0 !important; outline-offset: 3px; border-radius: 8px; }`;
          document.head.appendChild(style);
        }
        for (const el of document.querySelectorAll(`.${HINT}`)) el.classList.remove(HINT);
        for (const id of wanted) document.getElementById(id)?.classList.add(HINT);
      }, ids);
    },

    /**
     * Send one of the game's own actions through the page, exactly as a click would.
     *
     * UNVERIFIED until the live step of Task 12: which of the two action APIs the page exposes on
     * `gameui`. Both are tried, the current one first. A refusal from BGA rejects here with BGA's
     * own message, and so does a call the page declined to send at all.
     */
    async perform(call) {
      stillOn(page, tableId);
      await page.evaluate(async ({ name, args }) => {
        const current = gameui.bga?.actions;
        const send =
          current && typeof current.performAction === 'function'
            ? (n, a) => current.performAction(n, a)
            : typeof gameui.bgaPerformAction === 'function'
              ? (n, a) => gameui.bgaPerformAction(n, a)
              : null;
        if (!send) throw new Error('This page exposes no action API the adapter knows.');
        // BGA's typings: `performAction` returns `undefined`, not a rejection, when its own
        // `checkAction` stops the call. Awaiting that would read as success for a call never sent.
        const sent = send(name, args);
        if (sent === null || (typeof sent !== 'object' && typeof sent !== 'function') || typeof sent.then !== 'function') {
          throw new Error(`The page did not send ${name}: it is not allowed in the current state.`);
        }
        try {
          await sent;
        } catch (error) {
          // BGA rejects with a string or a `{ message }` object, neither of which survives the trip to node.
          throw new Error(typeof error === 'string' ? error : (error?.message ?? JSON.stringify(error)));
        }
      }, { name: call.name, args: call.args });
    },

    /**
     * What decides whether we may sit here, and what the opponent is rated.
     *
     * UNVERIFIED until Task 11: that `tableinfos` is how a table's settings are fetched, and that
     * `#player_elo_<id>` is where a rating is shown. Both come back `null` when the page does not
     * answer as expected, and `null` is a refusal (mode) or a game left out of the report (rating).
     */
    async facts(playerIds) {
      log("asking BGA for the table's settings (tableinfos, through the page's own ajaxcall), up to 10s");
      const info = await page.evaluate(
        (id) =>
          new Promise((resolve) => {
            const done = (value) => resolve(value ?? null);
            try {
              gameui.ajaxcall('/table/table/tableinfos.html', { id }, gameui, (result) => done(result), (failed) => {
                if (failed) done(null);
              });
            } catch {
              done(null);
            }
            setTimeout(() => done(null), 10_000);
          }),
        tableId,
      );
      log(`reading ratings from the player panels (#player_elo_<id>) for ${playerIds.length > 0 ? playerIds.join(', ') : 'no players'}`);
      const ratings = await page.evaluate(
        (ids) =>
          Object.fromEntries(
            ids.map((id) => {
              const text = document.getElementById(`player_elo_${id}`)?.textContent ?? '';
              const rating = Number.parseInt(text.trim(), 10);
              return [id, Number.isFinite(rating) ? rating : null];
            }),
          ),
        playerIds,
      );
      return { info, ratings };
    },

    /** Every plain value on `gameui`, for calibration. Anything that looks like a credential is left out. */
    async primitives() {
      log('listing the plain values on gameui (credential-looking names left out)');
      return page.evaluate(() =>
        Object.fromEntries(
          Object.entries(gameui).filter(
            ([key, value]) =>
              ['string', 'number', 'boolean'].includes(typeof value) && !/token|secret|key|pass|auth|session|cookie/i.test(key),
          ),
        ),
      );
    },
  };
}
