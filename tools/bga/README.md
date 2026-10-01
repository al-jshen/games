# Playing on BoardGameArena

The published network, at a Splendor Duel table on boardgamearena.com, so that its strength can be
measured against people. Two modes for a table you are seated at, and one for a table you are not:

| | |
| --- | --- |
| `advise` | Reads the position, searches, and tells you what to click. You make every move. |
| `play` | The same, and makes the moves itself. |
| `watch` | A game you are **not** in. Says what the bot would play for whoever is to move. Read-only. |

```bash
npx playwright install chromium        # once
npm run typecheck                      # once after pulling: the tool imports the packages' built output
npm run bga -- login                   # once: sign in to BGA by hand in the window that opens
npm run bga -- advise --table 'https://boardgamearena.com/tableview?table=123456789'
npm run bga -- play   --table '…' --iterations 1000
npm run bga -- watch  --table '…'      # any game you are only spectating
npm run bga -- watch  --table '…' --headless   # the same, with no window
npm run bga -- report
```

It needs a machine with a display: the browser is real and visible, because in `advise` you play in
it and in `play` it is what you take over when the adapter stops. Until the calibration below has
been done, `advise` and `play` refuse every table.

## The conditions it is used under

These are enforced in code, and they are the reason this exists in the form it does.

- **Friendly mode only.** Both modes read the table's settings first and refuse anything that is
  not an unrated friendly-mode table — including a table whose mode they cannot read. Nobody's
  rating is ever at stake against the bot.
- **The opponent is told.** You create the table by hand and say in its description that your seat
  is a bot. Both modes then print a notice and wait until you type `posted` to confirm it is in the
  table chat. The program does not post it for you.
- **It only knows what your seat is shown.** The position is read from the page's game state after
  a reload, and from nowhere else. BGA's notification stream is never read: it carries cards the
  page hides from you.
- **No disguise.** It does not pace itself to look human.
- **It never abandons a game.** When anything is unclear it stops, rings the terminal bell, and
  leaves the browser open. Finish the game by hand; the result is still recorded, marked as handed
  over, and left out of the rating.

BGA has not approved this, and its terms prohibit analysing its code and protocols, which reading a
page's state is. The risk to the account is the account holder's.

## Watching

`watch` is for a game the logged-in account is not playing in, in any mode — friendly, normal or
arena. It sends nothing to the table, so none of the conditions above apply to it, and it needs
neither calibration switch. Its one rule is the mirror of theirs: it refuses a table you are seated
at. Your own seat goes through `advise`, and its guard.

For every decision by either player it prints what the bot would play in that seat, and outlines the
pieces on the page, while the position is still on the table. Two things to know when reading it:

- **It sees what a spectator sees.** BGA shows an onlooker neither player's face-down reservations,
  so the suggestion is what the bot would play knowing only what is public. When it would buy one of
  the mover's face-down cards it says so without naming a card, because it cannot know which.
- **It does not stop.** A position it cannot translate, or one where our rules and BGA's disagree,
  is reported in a line and skipped. Those lines are the cheapest way there is to find translation
  bugs: every game on BGA is a test of the read path, with nobody needing to play the bot.

Nothing is recorded in the results log: a watched game is not a game the network played.

### What a working `watch` says about `advise`

`watch`, `advise` and `play` are one loop (`loop.mjs`) with three settings, and all three begin with
the same introduction (`session.mjs`), which prints both players' names and ratings. Reading the
page, remembering, translating, cross-checking against BGA, searching, wording the move, outlining
it and waiting for the table to move are the same code in every mode; `watch` and `advise` even use
the same strategy and print through the same function. So a `watch` that works at a live table has
run nearly all of `advise`. What it has not run:

- the friendly-mode check, which only a seated mode makes;
- the translation of our own seat, where our reservations arrive face-up;
- the stop path, the result row at the end of the game, and the memory file.

`watch` and `capture` only read, so both take `--headless` to run with no window, on the same saved
profile. Nothing else does: `login`, `advise` and `play` each need a person at the window. A machine
with no display also needs Chromium's system libraries (`npx playwright install-deps chromium`, as
root). Whether BGA serves a headless browser the same page has not been tried.

## When it stops

| Reason | What it means |
| --- | --- |
| `bad-snapshot` | BGA's page no longer has the shape this reads. BGA changed something. |
| `expansion` | The Counterfeiters expansion is on. Not supported. |
| `spectator` | The signed-in account is not seated at this table. |
| `seated` | (`watch`) The logged-in account is playing at this table. `watch` is for games you are not in. |
| `not-our-turn` | A snapshot taken as our decision says the other seat is to act. |
| `unknown-state` | The table sat in a state there is no translation for. |
| `mid-action` | The table is in the middle of one of our two-part moves (a privilege, a reservation, a wild card). In `play`, it sat there for 30s: the second call never landed. Finish or cancel it by hand. |
| `unmapped` | BGA named a colour, cell or card this has no word for. |
| `inconsistent` | The snapshot cannot be a position of this game. |
| `disagreement` | Our rules and BGA's allow different moves here. Includes being *stuck*, where our rules can only pass, and BGA saying either seat is hoarding every gold and pearl, a rule our engine does not have. |
| `refused` | (`play`) BGA turned down a move, or accepted one and the table did not change. Nothing is retried. |
| `page-error` | The page could not be read — a reload failed — or the tab is no longer on the table that was vetted. Also any error thrown inside the adapter, with its message. |

Every stop saves its snapshot to `data/bga/stops/`. If the stop was a bug in the translation, strip
the names and ids from that snapshot and keep it as a test fixture. The place for those,
`packages/bga-splendor-duel/test/fixtures/live/`, and the test that reads them, `live.test.ts`, are
created by the calibration (Task 11 of the plan, below); from then on a fixture there fails the
test until the bug is fixed.

## The rating

`report` fits one rating, by maximum likelihood under the Elo curve, to the clean games against
opponents whose rating was recorded, and prints a 95% interval. It is in BGA's displayed units.

It prints two caveats every time, because they are easy to forget once there is a number: these
were friendly games, which people may not play at full effort; and the interval reflects only how
many games there were.

## Calibration — do this first

As shipped, `advise` and `play` refuse **every** table, and `play` has a second gate of its own. `MODE_CHECK_VERIFIED` in `mode.mjs` is
`false`, and stays false until the friendly-mode check has been seen to read a live friendly table
as friendly *and* a live rated one as rated. A mode check that has never been seen to say "rated" is
not a check.

How a table reports its mode, where a player's rating is shown, and which action API the page
exposes were written from memory of BGA's site rather than from its published source, so they may
be wrong. Task 11 of `docs/superpowers/plans/2026-09-30-bga-adapter.md` is the procedure, step by
step. In short:

1. `npm run bga -- login`, then `capture` a friendly table you are seated at and a rated game you
   are only watching. `capture` only reads; it is safe on any table. Give it the address the browser
   shows while the game is on screen (`https://boardgamearena.com/tableview?table=…`); the game
   runs in a frame inside that page, and the tool finds it there. It says what it is doing at each
   step, so a capture that reads nothing also says where it stopped.
2. The friendly capture must say `snapshot: matches the schema`, and the two must say
   `game mode as read: friendly` and `rated`. If not, the saved files under `data/bga/captures/`
   show what BGA really sends; fix `tableMode` (and `facts` in `reader.mjs`) until both read
   correctly.
3. Only then set `MODE_CHECK_VERIFIED = true`, recording the date and the two capture files beside
   it. That opens `advise`, and only `advise`.
4. Play one advised game. Then watch `play` through one whole friendly game (Task 12 Step 11): every
   kind of call must reach the table, two-part moves included. `play` refuses to start, before it
   opens a browser, until `PLAY_VERIFIED` in `mode.mjs` is `true`; set it there, recording the date
   and the table, once that game has been watched through.

If BGA later changes how a table reports its mode, set `MODE_CHECK_VERIFIED` back to `false` and
repeat; if it changes how the page sends actions, do the same with `PLAY_VERIFIED`.

## How it is put together

`packages/bga-splendor-duel` is the translation, and is pure: a BGA snapshot in, a `SplendorView`
out; a `SplendorAction` in, words or BGA calls out. This directory is everything that touches a page
or a file. `reader.mjs` is the only code that evaluates anything in BGA's page.

BGA's implementation of the game is public (github.com/thoun/splendorduel). State names, action
names and the shape of the game state come from there.
