# BGA Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the published Splendor Duel network play disclosed, unrated friendly games on boardgamearena.com — first by telling an operator what to click (`advise`), then by submitting moves itself (`play`) — and estimate its rating from the results.

**Architecture:** A pure TypeScript package translates a BGA page snapshot into our `SplendorView` and translates a `SplendorAction` back into either words for a human or BGA action calls. A node tool drives a real, visible, logged-in browser with Playwright: it reloads the page to get a full snapshot, runs the same search the web client runs, and either prints the move or performs it. Nothing reads BGA's notification stream; nothing runs on a rated table.

**Tech Stack:** TypeScript (NodeNext, strict), zod 4, vitest 4, Playwright 1.62 (already locked), node ≥ 22.

**Spec:** `docs/superpowers/specs/2026-09-30-bga-adapter-design.md` — read it first. This plan argues from it.

## Global Constraints

- **Friendly mode only.** Both `advise` and `play` refuse a table that is not unrated friendly mode, and refuse when they cannot tell. `MODE_CHECK_VERIFIED` in `tools/bga/mode.mjs` stays `false` — refusing every table — until Task 11 confirms the check against a live friendly table *and* a live rated one.
- **Disclosed.** Both modes print the bot notice and block until the operator types `posted`. The program never posts chat itself.
- **Only what the seat is shown.** Position comes from `gameui.gamedatas` after a page reload and from nowhere else. Never subscribe to, read, or log BGA notifications: the `reserveCard` notification carries the full card to both players.
- **No disguise.** No randomised or human-shaped delays. The only waits are polls for the page's state.
- **Never guess, never abandon.** Any refusal stops the adapter, rings the bell, saves the snapshot, leaves the browser open, and waits for the operator to finish the game by hand.
- **No expansion.** A table with the Counterfeiters expansion is refused.
- **No lobby automation.** The operator creates the table and passes its URL.
- **Purity.** `packages/bga-splendor-duel/src` imports only `@games/engine`, `@games/splendor-duel` and `zod`. No `node:*`, no Playwright, no clock, no `Math.random`. Enforced by lint (Task 1).
- **No credentials in code or on disk outside the browser profile.** The profile lives in `tools/bga/.cache/profile` (already git-ignored by `tools/*/.cache/`). Results and captures live in `data/bga/` (already git-ignored by `/data/`).
- **Code style:** match the repo — doc comments that explain *why*, British spelling in prose (`colour`), `.js` suffixes on relative TS imports, `noUncheckedIndexedAccess` is on.
- **Commit messages** follow the repo's voice: one imperative sentence saying what changed for the reader, e.g. `Name BGA's colours, cells and cards in our own words`. Work on a branch, `bga-adapter`, not on `master`.

## Before starting

- **Node is not installed on this host.** `fnm list` shows only `system`, and there is no `node` on `PATH`. Install one first: `~/.local/share/fnm/fnm install 22 && ~/.local/share/fnm/fnm default 22`, then open a shell where `node --version` prints `v22.x`. Ask the user before installing.
- `node_modules` is absent: run `npm install` at the repo root, then `npm run typecheck` once (the tools import the packages' built `dist/`, which `tsc -b` emits).
- Baseline: `npm test` must pass before any change. If it does not, stop and report.
- Tasks 9, 11 and the live half of 12 need a machine **with a display and the operator's BGA login**; this host is headless. Everything else runs anywhere.
- BGA's implementation of this game is public: `git clone --depth 1 https://github.com/thoun/splendorduel`. Shapes and names in this plan were read from it at commit `6110fdb` (2026-09-04). When something on a live table disagrees with this plan, that repository is the place to look.

## File structure

```
packages/bga-splendor-duel/            pure translation; no IO
  package.json, tsconfig.json
  src/ids.ts                           colours, cells, card ids: BGA's numbering ↔ ours
  src/refusal.ts                       the typed "stop" every layer returns
  src/states.ts                        which BGA states are decisions, mid-action, or the end
  src/snapshot.ts                      zod schema + types for what the reader hands over
  src/memory.ts                        cards seen, turn baseline, previous-snapshot summary
  src/toView.ts                        BgaSnapshot + Memory → SplendorView
  src/locate.ts                        where each of our cells/cards lives on the BGA page
  src/crosscheck.ts                    our legal moves vs. what BGA's state args allow
  src/instruct.ts                      SplendorAction → words + DOM ids to highlight
  src/toBgaCalls.ts                    SplendorAction → BGA action calls
  src/index.ts                         exports
  test/fixtures/bga-cards.ts           BGA's 71 card definitions, transcribed
  test/support/play.ts                 random playthroughs
  test/support/synth.ts                SplendorState → a BGA-shaped snapshot (the inverse, for tests)
  test/support/fakeTable.ts            a BGA table made of our engine (for loop tests)
  test/*.test.ts

tools/bga/                             everything that touches a page or a file
  package.json, README.md
  paths.mjs                            where the profile, results and checkpoints live
  engine.mjs                           load the published checkpoint; one search → one action
  rating.mjs                           maximum-likelihood Elo with an interval
  results.mjs                          the JSONL log, and the report
  mode.mjs                             friendly-mode check + the guard both modes pass through
  browser.mjs                          launch the persistent, visible browser
  reader.mjs                           the only code that evaluates anything in the page
  loop.mjs                             settle → snapshot → translate → decide → act
  advise.mjs                           act = tell the operator
  play.mjs                             act = perform the calls
  cli.mjs                              login | capture | advise | play | report
  test/*.test.mjs

Modified: package.json, vitest.config.ts, eslint.config.mjs, Dockerfile, README.md,
          packages/bot-splendor-duel/src/index.ts, apps/web/src/bot/engine.ts
```

---

### Task 1: The package, and BGA's three vocabularies

**Files:**
- Create: `packages/bga-splendor-duel/package.json`, `packages/bga-splendor-duel/tsconfig.json`
- Create: `packages/bga-splendor-duel/src/ids.ts`, `packages/bga-splendor-duel/src/index.ts`
- Create: `packages/bga-splendor-duel/test/fixtures/bga-cards.ts`, `packages/bga-splendor-duel/test/ids.test.ts`
- Modify: `package.json` (workspaces, `typecheck`), `vitest.config.ts` (alias), `eslint.config.mjs` (purity block), `Dockerfile` (manifest copy)

**Interfaces:**
- Consumes: `SPIRAL`, `tryCard`, `GemColor`, `TokenColor` from `@games/splendor-duel`.
- Produces (from `src/ids.ts`):
  - `BGA_COLORLESS = 9`
  - `tokenColorFromBga(token: { type: number; color: number }): TokenColor | null`
  - `gemFromBga(color: number): GemColor | null`
  - `colorToBga(color: TokenColor): number`
  - `BGA_BOARD_COORDINATES: readonly (readonly [number, number])[]` — index `position - 1` → `[row, column]`, both 1-based
  - `cellFromBga(position: number): number | null`, `cellToBga(cell: number): number`
  - `cardIdFromBga(level: number, index: number): string | null`, `royalIdFromBga(index: number): string | null`

- [ ] **Step 1: Create the branch and the package manifests**

```bash
git switch -c bga-adapter
git add docs/superpowers
git commit -m "Write down how the BGA adapter is meant to work, and in what order"
mkdir -p packages/bga-splendor-duel/src packages/bga-splendor-duel/test/fixtures packages/bga-splendor-duel/test/support
```

(The spec and this plan are untracked on `master` when the plan is handed over; they travel onto the branch with the switch and are committed there.)

`packages/bga-splendor-duel/package.json`:

```json
{
  "name": "@games/bga-splendor-duel",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b"
  },
  "dependencies": {
    "@games/engine": "*",
    "@games/splendor-duel": "*",
    "zod": "^4.4.3"
  }
}
```

`packages/bga-splendor-duel/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../engine" }, { "path": "../games/splendor-duel" }]
}
```

- [ ] **Step 2: Wire the package into the repo**

In the root `package.json`, add `"packages/bga-splendor-duel",` to `workspaces` directly after `"packages/bot-splendor-duel",`, and in the `typecheck` script insert `packages/bga-splendor-duel` after `packages/bot-splendor-duel` in the `tsc -b` list:

```json
"typecheck": "tsc -b packages/engine packages/protocol packages/client-sdk packages/net packages/games/tic-tac-toe packages/games/splendor-duel packages/bot-ismcts packages/bot-splendor-duel packages/bga-splendor-duel apps/server && tsc -p packages/games/splendor-duel/tsconfig.ui.json && tsc -p packages/games/tic-tac-toe/tsconfig.ui.json && tsc -p apps/web/tsconfig.json",
```

In `vitest.config.ts`, add this alias directly after the `@games/bot-ismcts` line:

```ts
      { find: '@games/bga-splendor-duel', replacement: fileURLToPath(new URL('./packages/bga-splendor-duel/src/index.ts', import.meta.url)) },
```

In `eslint.config.mjs`, add this block directly after the game-reducers block (the one whose `files` is `['packages/games/*/src/**/*.ts']`):

```js
  {
    // The BGA translation is held to the standard of a game module: pure functions of their inputs.
    // Everything that touches a page, a file or a clock lives in tools/bga, so that what the bot is
    // told about a position can be tested without a browser and cannot depend on when it was asked.
    files: ['packages/bga-splendor-duel/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'The translation must not read the clock.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'The translation must be deterministic.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'playwright', 'playwright/*', '@playwright/*', '@games/protocol', '@games/client-sdk'],
              message: 'packages/bga-splendor-duel is pure. Page and file access belong in tools/bga.',
            },
          ],
        },
      ],
    },
  },
```

In `Dockerfile`, add after the `COPY packages/bot-splendor-duel/package.json …` line (the image's `npm run typecheck` now builds this package, and an uncopied manifest is silently not linked):

```dockerfile
COPY packages/bga-splendor-duel/package.json packages/bga-splendor-duel/
```

Run: `npm install`
Expected: exits 0; `ls node_modules/@games/bga-splendor-duel` shows the new package linked.

- [ ] **Step 3: Write BGA's card definitions as a fixture**

`packages/bga-splendor-duel/test/fixtures/bga-cards.ts` — transcribed from `modules/php/Game.php` in thoun/splendorduel, in BGA's own numbers (colours: `0` pearl, `1` blue, `2` white, `3` green, `4` black, `5` red, `9` grey/any; powers: `1` play again, `2` joker, `3` take matching token, `4` take privilege, `5` steal):

```ts
/**
 * BGA's own definition of every card, transcribed from `modules/php/Game.php` in thoun/splendorduel.
 *
 * Kept in BGA's numbers on purpose. The point of this file is to be a second, independent statement
 * of what each card is, so that "BGA card (2, 7) is our l2-07" is something a test proves rather
 * than something the id scheme assumes.
 */

/** [level, index, colour, cost, provides, points, crowns, powers] */
export type BgaCardRow = readonly [
  number,
  number,
  number,
  Readonly<Record<number, number>>,
  Readonly<Record<number, number>>,
  number,
  number,
  readonly number[],
];

export const BGA_CARDS: readonly BgaCardRow[] = [
  [1, 1, 2, {1: 1, 3: 1, 5: 1, 4: 1}, {2: 1}, 0, 0, []],
  [1, 2, 2, {1: 3}, {2: 1}, 0, 1, []],
  [1, 3, 2, {1: 2, 3: 2, 0: 1}, {2: 1}, 0, 0, [1]],
  [1, 4, 2, {5: 2, 4: 2}, {2: 1}, 0, 0, [3]],
  [1, 5, 2, {3: 2, 5: 3}, {2: 1}, 1, 0, []],
  [1, 6, 1, {2: 1, 3: 1, 5: 1, 4: 1}, {1: 1}, 0, 0, []],
  [1, 7, 1, {3: 3}, {1: 1}, 0, 1, []],
  [1, 8, 1, {3: 2, 5: 2, 0: 1}, {1: 1}, 0, 0, [1]],
  [1, 9, 1, {2: 2, 4: 2}, {1: 1}, 0, 0, [3]],
  [1, 10, 1, {5: 2, 4: 3}, {1: 1}, 1, 0, []],
  [1, 11, 3, {2: 1, 1: 1, 5: 1, 4: 1}, {3: 1}, 0, 0, []],
  [1, 12, 3, {5: 3}, {3: 1}, 0, 1, []],
  [1, 13, 3, {5: 2, 4: 2, 0: 1}, {3: 1}, 0, 0, [1]],
  [1, 14, 3, {2: 2, 1: 2}, {3: 1}, 0, 0, [3]],
  [1, 15, 3, {2: 3, 4: 2}, {3: 1}, 1, 0, []],
  [1, 16, 4, {2: 1, 1: 1, 3: 1, 5: 1}, {4: 1}, 0, 0, []],
  [1, 17, 4, {2: 3}, {4: 1}, 0, 1, []],
  [1, 18, 4, {2: 2, 1: 2, 0: 1}, {4: 1}, 0, 0, [1]],
  [1, 19, 4, {3: 2, 5: 2}, {4: 1}, 0, 0, [3]],
  [1, 20, 4, {1: 2, 3: 3}, {4: 1}, 1, 0, []],
  [1, 21, 5, {2: 1, 1: 1, 3: 1, 4: 1}, {5: 1}, 0, 0, []],
  [1, 22, 5, {4: 3}, {5: 1}, 0, 1, []],
  [1, 23, 5, {2: 2, 4: 2, 0: 1}, {5: 1}, 0, 0, [1]],
  [1, 24, 5, {1: 2, 3: 2}, {5: 1}, 0, 0, [3]],
  [1, 25, 5, {2: 2, 1: 3}, {5: 1}, 1, 0, []],
  [1, 26, 9, {4: 4, 0: 1}, {9: 1}, 1, 0, [2]],
  [1, 27, 9, {2: 4, 0: 1}, {9: 1}, 0, 1, [2]],
  [1, 28, 9, {5: 4, 0: 1}, {}, 3, 0, []],
  [1, 29, 9, {1: 2, 5: 2, 4: 1, 0: 1}, {9: 1}, 1, 0, [2]],
  [1, 30, 9, {2: 2, 3: 2, 4: 1, 0: 1}, {9: 1}, 1, 0, [2]],

  [2, 1, 2, {3: 2, 5: 2, 4: 2, 0: 1}, {2: 1}, 2, 1, []],
  [2, 2, 2, {1: 4, 5: 3}, {2: 1}, 1, 0, [5]],
  [2, 3, 2, {2: 4, 4: 2, 0: 1}, {2: 1}, 2, 0, [4]],
  [2, 4, 2, {1: 5, 3: 2}, {2: 2}, 1, 0, []],
  [2, 5, 1, {2: 2, 5: 2, 4: 2, 0: 1}, {1: 1}, 2, 1, []],
  [2, 6, 1, {3: 4, 4: 3}, {1: 1}, 1, 0, [5]],
  [2, 7, 1, {2: 2, 1: 4, 0: 1}, {1: 1}, 2, 0, [4]],
  [2, 8, 1, {3: 5, 5: 2}, {1: 2}, 1, 0, []],
  [2, 9, 3, {2: 2, 1: 2, 4: 2, 0: 1}, {3: 1}, 2, 1, []],
  [2, 10, 3, {2: 3, 5: 4}, {3: 1}, 1, 0, [5]],
  [2, 11, 3, {1: 2, 3: 4, 0: 1}, {3: 1}, 2, 0, [4]],
  [2, 12, 3, {5: 5, 4: 2}, {3: 2}, 1, 0, []],
  [2, 13, 4, {1: 2, 3: 2, 5: 2, 0: 1}, {4: 1}, 2, 1, []],
  [2, 14, 4, {2: 4, 3: 3}, {4: 1}, 1, 0, [5]],
  [2, 15, 4, {5: 2, 4: 4, 0: 1}, {4: 1}, 2, 0, [4]],
  [2, 16, 4, {2: 5, 1: 2}, {4: 2}, 1, 0, []],
  [2, 17, 5, {2: 2, 1: 2, 3: 2, 0: 1}, {5: 1}, 2, 1, []],
  [2, 18, 5, {1: 3, 4: 4}, {5: 1}, 1, 0, [5]],
  [2, 19, 5, {3: 2, 5: 4, 0: 1}, {5: 1}, 2, 0, [4]],
  [2, 20, 5, {2: 2, 4: 5}, {5: 2}, 1, 0, []],
  [2, 21, 9, {3: 6, 0: 1}, {9: 1}, 2, 0, [2]],
  [2, 22, 9, {3: 6, 0: 1}, {9: 1}, 0, 2, [2]],
  [2, 23, 9, {1: 6, 0: 1}, {9: 1}, 0, 2, [2]],
  [2, 24, 9, {1: 6, 0: 1}, {}, 5, 0, []],

  [3, 1, 2, {1: 3, 5: 5, 4: 3, 0: 1}, {2: 1}, 3, 2, []],
  [3, 2, 2, {2: 6, 1: 2, 4: 2}, {2: 1}, 4, 0, []],
  [3, 3, 1, {2: 3, 3: 3, 4: 5, 0: 1}, {1: 1}, 3, 2, []],
  [3, 4, 1, {2: 2, 1: 6, 3: 2}, {1: 1}, 4, 0, []],
  [3, 5, 3, {2: 5, 1: 3, 5: 3, 0: 1}, {3: 1}, 3, 2, []],
  [3, 6, 3, {1: 2, 3: 6, 5: 2}, {3: 1}, 4, 0, []],
  [3, 7, 4, {2: 3, 3: 5, 5: 3, 0: 1}, {4: 1}, 3, 2, []],
  [3, 8, 4, {2: 2, 5: 2, 4: 6}, {4: 1}, 4, 0, []],
  [3, 9, 5, {1: 5, 3: 3, 4: 3, 0: 1}, {5: 1}, 3, 2, []],
  [3, 10, 5, {3: 2, 5: 6, 4: 2}, {5: 1}, 4, 0, []],
  [3, 11, 9, {5: 8}, {9: 1}, 3, 0, [2, 1]],
  [3, 12, 9, {4: 8}, {9: 1}, 0, 3, [2]],
  [3, 13, 9, {2: 8}, {}, 6, 0, []],
];

/** [index, points, powers] */
export const BGA_ROYALS: readonly (readonly [number, number, readonly number[]])[] = [
  [1, 2, [5]],
  [2, 2, [1]],
  [3, 2, [4]],
  [4, 3, []],
];
```

- [ ] **Step 4: Write the failing test**

`packages/bga-splendor-duel/test/ids.test.ts`:

```ts
import { ALL_LINES, CARD_DEFS, SPIRAL, TOKEN_COLORS, card } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import {
  BGA_BOARD_COORDINATES,
  cardIdFromBga,
  cellFromBga,
  cellToBga,
  colorToBga,
  gemFromBga,
  royalIdFromBga,
  tokenColorFromBga,
} from '../src/ids.js';
import { BGA_CARDS, BGA_ROYALS } from './fixtures/bga-cards.js';

/**
 * The three vocabularies BGA and this repo each have a version of.
 *
 * Every one of these is a place where the two could disagree without anything crashing: a colour
 * off by one is still a colour, a rotated board is still a board, and a mislabelled card is still a
 * card. The bot would simply be shown a position that is not the one on the table.
 */

const POWER: Record<number, string> = {
  1: 'playAgain',
  2: 'wildBonus',
  3: 'takeMatchingToken',
  4: 'takePrivilege',
  5: 'stealToken',
};

describe('colours', () => {
  it('round-trips every token colour', () => {
    for (const color of TOKEN_COLORS) {
      const bga = colorToBga(color);
      expect(tokenColorFromBga({ type: color === 'gold' ? 1 : 2, color: bga })).toBe(color);
    }
  });

  it('reads gold from the token type, whatever the colour field says', () => {
    expect(tokenColorFromBga({ type: 1, color: -1 })).toBe('gold');
    expect(tokenColorFromBga({ type: 1, color: 0 })).toBe('gold');
  });

  it('has no word for the expansion colour', () => {
    expect(tokenColorFromBga({ type: 2, color: 6 })).toBeNull();
    expect(gemFromBga(6)).toBeNull();
    // Pearl and gold are tokens, not gems: no card has either as its bonus.
    expect(gemFromBga(0)).toBeNull();
    expect(gemFromBga(-1)).toBeNull();
  });
});

describe('board cells', () => {
  it('maps the 25 BGA positions onto the 25 cells, in the order both sides refill', () => {
    const cells = Array.from({ length: 25 }, (_, i) => cellFromBga(i + 1));
    expect(cells).toEqual([...SPIRAL]);
    for (const cell of SPIRAL) expect(cellFromBga(cellToBga(cell))).toBe(cell);
    expect(cellFromBga(0)).toBeNull();
    expect(cellFromBga(26)).toBeNull();
  });

  it("is BGA's board turned half a turn, which keeps every line a line", () => {
    /*
     * BGA numbers its positions from the centre going *down* first; our spiral goes up first. That
     * is a 180-degree rotation, and the reason it is harmless is checked rather than asserted: a
     * rotation of the square sends straight runs to straight runs.
     */
    BGA_BOARD_COORDINATES.forEach(([row, column], i) => {
      const rowMajor = (row - 1) * 5 + (column - 1);
      expect(cellFromBga(i + 1)).toBe(24 - rowMajor);
    });
    const lines = new Set(ALL_LINES.map((line) => line.join(',')));
    for (const line of ALL_LINES) {
      const turned = line.map((cell) => 24 - cell).sort((a, b) => a - b);
      expect(lines.has(turned.join(','))).toBe(true);
    }
  });
});

describe('cards', () => {
  it('agrees with BGA on every jewel card, field by field', () => {
    for (const [level, index, colour, cost, provides, points, crowns, powers] of BGA_CARDS) {
      const id = cardIdFromBga(level, index);
      expect(id, `BGA card (${level}, ${index})`).not.toBeNull();
      const def = card(id as string);

      const [bonus] = Object.entries(provides);
      const expectedCost = Object.fromEntries(
        Object.entries(cost).map(([c, n]) => [tokenColorFromBga({ type: 2, color: Number(c) }), n]),
      );
      expect(
        {
          level: def.level,
          points: def.points,
          crowns: def.crowns,
          bonusColor: def.bonusColor,
          bonusCount: def.bonusCount,
          wild: def.wild,
          cost: def.cost,
          abilities: [...def.abilities].sort(),
        },
        id as string,
      ).toEqual({
        level,
        points,
        crowns,
        bonusColor: colour === 9 ? null : gemFromBga(colour),
        bonusCount: bonus ? bonus[1] : 0,
        wild: bonus ? Number(bonus[0]) === 9 : false,
        cost: expectedCost,
        abilities: powers.map((p) => POWER[p]).sort(),
      });
    }
  });

  it('covers the whole deck, and nothing outside it', () => {
    const jewels = CARD_DEFS.filter((c) => c.kind === 'jewel').map((c) => c.id).sort();
    const mapped = BGA_CARDS.map(([level, index]) => cardIdFromBga(level, index)).sort();
    expect(mapped).toEqual(jewels);
    expect(cardIdFromBga(1, 31)).toBeNull();
    expect(cardIdFromBga(4, 1)).toBeNull();
  });

  it('agrees with BGA on the four royals, and refuses the expansion ones', () => {
    for (const [index, points, powers] of BGA_ROYALS) {
      const def = card(royalIdFromBga(index) as string);
      expect(def.kind).toBe('royal');
      expect(def.points).toBe(points);
      expect([...def.abilities].sort()).toEqual(powers.map((p) => POWER[p]).sort());
    }
    expect(royalIdFromBga(5)).toBeNull();
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run packages/bga-splendor-duel/test/ids.test.ts`
Expected: FAIL — cannot resolve `../src/ids.js`.

- [ ] **Step 6: Implement `ids.ts`**

`packages/bga-splendor-duel/src/ids.ts`:

```ts
import { SPIRAL, tryCard, type GemColor, type TokenColor } from '@games/splendor-duel';

/**
 * BGA's numbering of everything, next to ours.
 *
 * All of it is read from BGA's published implementation of this game (thoun/splendorduel:
 * `modules/php/constants.inc.php`, `Object/Token.php`, `Game.php`) rather than inferred from a
 * running page. `test/ids.test.ts` holds a second copy of BGA's card list and proves the two sides
 * mean the same card by the same number.
 */

const TOKEN_BY_BGA: Readonly<Record<number, TokenColor>> = {
  [-1]: 'gold',
  0: 'pearl',
  1: 'blue',
  2: 'white',
  3: 'green',
  4: 'black',
  5: 'red',
};

const GEM_BY_BGA: Readonly<Record<number, GemColor>> = {
  1: 'blue',
  2: 'white',
  3: 'green',
  4: 'black',
  5: 'red',
};

/** The "colour" BGA files a card under when it has no bonus colour of its own. */
export const BGA_COLORLESS = 9;

/**
 * A token's colour. Gold is a token *type* on BGA (`type: 1`) rather than a colour, so the type is
 * read first. `null` for anything this game does not have without the expansion (glassware, `6`).
 */
export function tokenColorFromBga(token: { type: number; color: number }): TokenColor | null {
  if (token.type === 1) return 'gold';
  if (token.type !== 2 || token.color === -1) return null;
  return TOKEN_BY_BGA[token.color] ?? null;
}

/** A bonus colour — one of the five gems. Pearl and gold are not bonuses, so they are `null`. */
export function gemFromBga(color: number): GemColor | null {
  return GEM_BY_BGA[color] ?? null;
}

export function colorToBga(color: TokenColor): number {
  for (const [bga, ours] of Object.entries(TOKEN_BY_BGA)) {
    if (ours === color) return Number(bga);
  }
  throw new Error(`no BGA colour for ${color}`);
}

/**
 * BGA's board positions 1-25 as [row, column], both 1-based. Index is `position - 1`.
 *
 * BGA numbers positions in refill order and refills in that order, which is exactly what `SPIRAL`
 * is for us. So position k *is* `SPIRAL[k - 1]` and the two boards refill identically — the one
 * thing the orientation of the spiral decides. The coordinates are kept for talking to a person:
 * "row 2, column 4" is what they can find on the screen.
 */
export const BGA_BOARD_COORDINATES: readonly (readonly [number, number])[] = [
  [3, 3], [4, 3], [4, 2], [3, 2], [2, 2],
  [2, 3], [2, 4], [3, 4], [4, 4], [5, 4],
  [5, 3], [5, 2], [5, 1], [4, 1], [3, 1],
  [2, 1], [1, 1], [1, 2], [1, 3], [1, 4],
  [1, 5], [2, 5], [3, 5], [4, 5], [5, 5],
];

export function cellFromBga(position: number): number | null {
  if (!Number.isInteger(position)) return null;
  return SPIRAL[position - 1] ?? null;
}

export function cellToBga(cell: number): number {
  const at = SPIRAL.indexOf(cell);
  if (at < 0) throw new Error(`no such board cell: ${cell}`);
  return at + 1;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** BGA identifies a jewel card by (level, index within the level). So do we, as `l2-07`. */
export function cardIdFromBga(level: number, index: number): string | null {
  const id = `l${level}-${two(index)}`;
  return tryCard(id)?.kind === 'jewel' ? id : null;
}

/** Royals 1-4 are the base game's. 5 and up belong to the expansion and have no card here. */
export function royalIdFromBga(index: number): string | null {
  const id = `royal-${two(index)}`;
  return tryCard(id)?.kind === 'royal' ? id : null;
}
```

`packages/bga-splendor-duel/src/index.ts`:

```ts
export * from './ids.js';
```

- [ ] **Step 7: Run the test and the gates**

Run: `npx vitest run packages/bga-splendor-duel/test/ids.test.ts`
Expected: PASS, 8 tests.

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/bga-splendor-duel package.json package-lock.json vitest.config.ts eslint.config.mjs Dockerfile
git commit -m "Name BGA's colours, cells and cards in our own words"
```

---

### Task 2: What a snapshot is, and a way to make one from our own engine

**Files:**
- Create: `packages/bga-splendor-duel/src/refusal.ts`, `src/states.ts`, `src/snapshot.ts`
- Create: `packages/bga-splendor-duel/test/support/play.ts`, `test/support/synth.ts`, `test/snapshot.test.ts`
- Modify: `packages/bga-splendor-duel/src/index.ts`

**Interfaces:**
- Consumes: Task 1's `ids.ts`.
- Produces:
  - `refusal.ts`: `type RefusalReason = 'bad-snapshot' | 'expansion' | 'spectator' | 'not-our-turn' | 'unknown-state' | 'mid-action' | 'unmapped' | 'inconsistent' | 'disagreement' | 'refused'`; `interface Refusal { reason: RefusalReason; detail: string }`
  - `states.ts`: `type StateKind = 'decision' | 'mid-action' | 'over' | 'unknown'`; `stateKind(name: string): StateKind`
  - `snapshot.ts`: `zBgaSnapshot`, `type BgaSnapshot`, `type BgaPlayer`, `type BgaToken`, `type BgaCard`, `type BgaRoyal`, `zPlayActionArgs`, `zTakeBoardTokenArgs`, `zDiscardArgs`, `buyableIds(args): number[]`, `parseSnapshot(raw: unknown): { ok: true; snapshot: BgaSnapshot } | { ok: false; refusal: Refusal }`
  - `test/support/play.ts`: `walk(seed: string, moves: number, visit: (state: SplendorState) => void): void`, `pick(actions: SplendorAction[], rng: RandomCursor): SplendorAction`
  - `test/support/synth.ts`: `PLAYER_ID: readonly [number, number]`, `bgaCardId(id: string): number`, `cardIdOfBga(bga: number): string`, `bgaRoyalId(id: string): number`, `royalIdOfBga(bga: number): string`, `boardTokenId(cell: number): number`, `heldTokenColor(id: number): TokenColor`, `stateOf(state: SplendorState): { name: string; args: unknown }`, `synthSnapshot(state: SplendorState, viewer: 0 | 1, override?: { name: string; args: unknown }): unknown`, `snap(state: SplendorState, viewer: 0 | 1): BgaSnapshot`

- [ ] **Step 1: Write the test support — random playthroughs**

`packages/bga-splendor-duel/test/support/play.ts`:

```ts
import { RandomCursor } from '@games/engine';
import { apply, legalActions, setup, type SplendorAction, type SplendorState } from '@games/splendor-duel';

/**
 * A move for a random game that still gets somewhere.
 *
 * Uniformly random Splendor Duel is mostly token-shuffling: purchases are a small share of the legal
 * moves, so a uniform walk rarely reaches the states that matter here — an ability to resolve, a
 * royal to claim, a discard. Preferring a purchase when one exists gets a game through all of them
 * in a couple of hundred moves.
 */
export function pick(actions: SplendorAction[], rng: RandomCursor): SplendorAction {
  const buys = actions.filter((a) => a.t === 'purchase');
  const pool = buys.length > 0 && rng.int(10) < 6 ? buys : actions;
  return pool[rng.int(pool.length)] as SplendorAction;
}

/** Play a seeded game, calling `visit` on the opening position and after every single action. */
export function walk(seed: string, moves: number, visit: (state: SplendorState) => void): void {
  let state = setup({ seed, seats: [0, 1], options: {} });
  const rng = new RandomCursor(`${seed}:play`, 0);
  visit(state);
  for (let i = 0; i < moves && state.stage !== 'over'; i++) {
    const seat = state.turn;
    const { actions } = legalActions(state, seat);
    const result = apply(state, seat, pick(actions, rng));
    if (!result.ok) throw new Error(`walk: ${result.error.message}`);
    state = result.state;
    visit(state);
  }
}
```

- [ ] **Step 2: Write the test support — the inverse translation**

`packages/bga-splendor-duel/test/support/synth.ts`:

```ts
import {
  CARD_DEFS,
  SPIRAL,
  TOKEN_COLORS,
  legalActions,
  type SplendorState,
  type TokenColor,
} from '@games/splendor-duel';
import { BGA_BOARD_COORDINATES, colorToBga } from '../../src/ids.js';
import { parseSnapshot, type BgaSnapshot } from '../../src/snapshot.js';

/**
 * A position from our own engine, dressed as BGA would send it.
 *
 * This is the translation run backwards, and it exists so the forward direction can be tested
 * without a BGA table: play a game here, dress every position up, translate it back, and the result
 * has to be the view our own redaction produces. It follows `getAllDatas` and the `arg*` methods in
 * thoun/splendorduel, including the parts that are awkward on purpose — ids arrive as strings, an
 * opponent's reserved card arrives without its face, an empty PHP map arrives as `[]`.
 *
 * It shares this repo's assumptions about BGA's shapes with the code under test, so it cannot catch
 * a wrong assumption. Captured fixtures from live tables are what catch those (see tools/bga).
 */

export const PLAYER_ID: readonly [number, number] = [1000, 2000];

const JEWELS = CARD_DEFS.filter((c) => c.kind === 'jewel').map((c) => c.id);
const ROYALS = CARD_DEFS.filter((c) => c.kind === 'royal').map((c) => c.id);

/** BGA card ids are database row ids with no meaning. Here they are just a stable numbering. */
export const bgaCardId = (id: string): number => JEWELS.indexOf(id) + 1;
export const cardIdOfBga = (bga: number): string => JEWELS[bga - 1] as string;
export const bgaRoyalId = (id: string): number => ROYALS.indexOf(id) + 1;
export const royalIdOfBga = (bga: number): string => ROYALS[bga - 1] as string;

/** Board tokens are 100 + cell; a held token is its owner's id + 10 x colour + a counter. */
export const boardTokenId = (cell: number): number => 100 + cell;
const heldTokenId = (seat: 0 | 1, color: TokenColor, n: number): number =>
  PLAYER_ID[seat] + TOKEN_COLORS.indexOf(color) * 10 + n;
export const heldTokenColor = (id: number): TokenColor =>
  TOKEN_COLORS[Math.floor((id % 1000) / 10)] as TokenColor;

function cardJson(id: string, location: string, locationArg: number, faceUp: boolean) {
  const match = /^l(\d)-(\d+)$/.exec(id);
  if (!match) throw new Error(`synth: not a jewel card: ${id}`);
  return {
    id: bgaCardId(id),
    location,
    locationArg,
    level: Number(match[1]),
    index: faceUp ? Number(match[2]) : null,
  };
}

function royalJson(id: string, location: string, locationArg: number) {
  return { id: bgaRoyalId(id), location, locationArg, index: bgaRoyalId(id) };
}

/** The BGA state a position is in, and the arguments BGA would send with it. */
export function stateOf(state: SplendorState): { name: string; args: unknown } {
  if (state.stage === 'over') return { name: 'gameEnd', args: null };
  const seat = state.turn as 0 | 1;
  const me = state.players[seat];
  const pending = state.pending;
  if (pending?.k === 'matchingToken') {
    return { name: 'takeBoardToken', args: { number: 1, color: colorToBga(pending.color), canTakeAnyColorOrTwoOfColor: false } };
  }
  if (pending?.k === 'steal') return { name: 'takeOpponentToken', args: { opponentId: PLAYER_ID[(1 - seat) as 0 | 1] } };
  if (pending?.k === 'royal') return { name: 'takeRoyalCard', args: null };
  if (pending?.k === 'discard') return { name: 'discardTokens', args: { number: pending.count } };

  const boardCount = state.board.filter((t) => t !== null).length;
  const privileges = state.replenishedThisTurn || boardCount === 0 ? 0 : me.privileges;
  const canRefill = state.bag.length > 0 && boardCount < 25 && !state.replenishedThisTurn;
  const buyable: Record<string, unknown[]> = {};
  for (const action of legalActions(state, seat).actions) {
    if (action.t !== 'purchase') continue;
    const id =
      action.from.t === 'pyramid'
        ? (state.pyramid[action.from.level][action.from.slot] as string)
        : action.from.cardId;
    buyable[String(bgaCardId(id))] = [{}];
  }
  const canReserve = me.reserved.length < 3;
  const onlyGold = state.board.every((t) => t === null || t === 'gold');
  const canTakeTokens = boardCount > 0 && !(!canReserve && onlyGold);
  const canBuyCard = Object.keys(buyable).length > 0;
  return {
    name: 'playAction',
    args: {
      privileges,
      canRefill,
      mustRefill: canRefill && !canTakeTokens && !canBuyCard,
      canTakeTokens,
      canReserve,
      canBuyCard,
      // PHP encodes an empty map as a list. The schema has to take both, so the fixture sends both.
      buyableCards: canBuyCard ? buyable : [],
      reducedCosts: [],
      playerAntiPlaying: false,
      opponentAntiPlaying: false,
    },
  };
}

function playerJson(state: SplendorState, seat: 0 | 1, viewer: 0 | 1) {
  const player = state.players[seat];
  const pid = PLAYER_ID[seat];
  const tokens = TOKEN_COLORS.flatMap((color) =>
    Array.from({ length: player.tokens[color] }, (_, n) => ({
      id: heldTokenId(seat, color, n),
      location: 'player',
      locationArg: pid,
      type: color === 'gold' ? 1 : 2,
      color: colorToBga(color),
    })),
  );
  const cards = [
    ...player.stacks.flatMap((stack) =>
      stack.cardIds.map((id, i) => cardJson(id, `player${pid}-${colorToBga(stack.color)}`, i, true)),
    ),
    ...player.colorless.map((id, i) => cardJson(id, `player${pid}-9`, i, true)),
    // BGA orders one query across every column by position, so colours arrive interleaved.
  ].sort((a, b) => a.locationArg - b.locationArg);
  return {
    id: String(pid),
    score: state.winner === seat ? 1 : 0,
    playerNo: seat + 1,
    privileges: player.privileges,
    tokens,
    cards,
    // `Card::onlyIds`: an opponent's reservation has no face, whether or not it was taken face-up.
    reserved: player.reserved.map((held) => cardJson(held.cardId, 'reserved', pid, seat === viewer)),
    royalCards: player.royals.map((id) => royalJson(id, 'player', pid)),
    endReasons: [],
  };
}

export function synthSnapshot(
  state: SplendorState,
  viewer: 0 | 1,
  override?: { name: string; args: unknown },
): unknown {
  const { name, args } = override ?? stateOf(state);
  const byLevel = <T>(make: (level: 1 | 2 | 3) => T) => ({ 1: make(1), 2: make(2), 3: make(3) });
  return {
    tableId: 'synthetic',
    me: PLAYER_ID[viewer],
    gamestate: { name, active_player: String(PLAYER_ID[state.turn as 0 | 1]), args },
    gamedatas: {
      players: {
        [PLAYER_ID[0]]: playerJson(state, 0, viewer),
        [PLAYER_ID[1]]: playerJson(state, 1, viewer),
      },
      board: state.board.flatMap((color, cell) => {
        if (color === null) return [];
        const position = SPIRAL.indexOf(cell) + 1;
        const [row, column] = BGA_BOARD_COORDINATES[position - 1] as readonly [number, number];
        return [{ id: boardTokenId(cell), location: 'board', locationArg: position, type: color === 'gold' ? 1 : 2, color: colorToBga(color), row, column }];
      }),
      cardDeckCount: byLevel((level) => state.decks[level].length),
      cardDeckTop: byLevel((level) => {
        const top = state.decks[level][0];
        return top ? cardJson(top, `deck${level}`, state.decks[level].length, false) : null;
      }),
      tableCards: byLevel((level) =>
        state.pyramid[level].flatMap((id, slot) => (id ? [cardJson(id, `table${level}`, slot + 1, true)] : [])),
      ),
      royalCards: state.royals.flatMap((id, i) => (id ? [royalJson(id, 'deck', i)] : [])),
      expansion: false,
    },
  };
}

/** `synthSnapshot`, through the schema, or a thrown error — for tests that are about something else. */
export function snap(state: SplendorState, viewer: 0 | 1): BgaSnapshot {
  const parsed = parseSnapshot(synthSnapshot(state, viewer));
  if (!parsed.ok) throw new Error(`synth produced a snapshot the schema refuses: ${parsed.refusal.detail}`);
  return parsed.snapshot;
}
```

- [ ] **Step 3: Write the failing test**

`packages/bga-splendor-duel/test/snapshot.test.ts`:

```ts
import { setup } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { buyableIds, parseSnapshot, zPlayActionArgs } from '../src/snapshot.js';
import { stateKind } from '../src/states.js';
import { PLAYER_ID, synthSnapshot } from './support/synth.js';
import { walk } from './support/play.js';

/**
 * The schema is the adapter's only defence against BGA changing shape under it. Anything it lets
 * through is treated as the position on the table, so what it must not do is let through something
 * it half-understands.
 */

const opening = () => setup({ seed: 'snapshot', seats: [0, 1], options: {} });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('the snapshot schema', () => {
  it('accepts every position of a whole game, from either seat', () => {
    let checked = 0;
    walk('snapshot-walk', 250, (state) => {
      for (const viewer of [0, 1] as const) {
        const parsed = parseSnapshot(clone(synthSnapshot(state, viewer)));
        expect(parsed.ok, parsed.ok ? '' : parsed.refusal.detail).toBe(true);
        checked += 1;
      }
    });
    expect(checked).toBeGreaterThan(100);
  });

  it('turns the numeric strings BGA sends into numbers', () => {
    const parsed = parseSnapshot(clone(synthSnapshot(opening(), 0)));
    if (!parsed.ok) throw new Error(parsed.refusal.detail);
    const ids = Object.values(parsed.snapshot.gamedatas.players).map((p) => p.id);
    expect(ids.sort()).toEqual([...PLAYER_ID]);
    expect(typeof parsed.snapshot.gamestate.active_player).toBe('number');
  });

  it('refuses a snapshot with a part missing, and says which', () => {
    const raw = clone(synthSnapshot(opening(), 0)) as { gamedatas: Record<string, unknown> };
    delete raw.gamedatas.board;
    const parsed = parseSnapshot(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.reason).toBe('bad-snapshot');
    expect(parsed.refusal.detail).toContain('gamedatas.board');
  });

  it('refuses a field of the wrong type rather than coercing it', () => {
    const raw = clone(synthSnapshot(opening(), 0)) as { gamedatas: { board: { id: unknown }[] } };
    (raw.gamedatas.board[0] as { id: unknown }).id = 'twelve';
    expect(parseSnapshot(raw).ok).toBe(false);
    expect(parseSnapshot(null).ok).toBe(false);
    expect(parseSnapshot('gamedatas').ok).toBe(false);
  });
});

describe('state arguments', () => {
  it('reads buyable cards whether PHP sent a map or an empty list', () => {
    const base = { privileges: 0, canRefill: false, mustRefill: false, canTakeTokens: true, canReserve: true, canBuyCard: false };
    expect(buyableIds(zPlayActionArgs.parse({ ...base, buyableCards: [] }))).toEqual([]);
    expect(buyableIds(zPlayActionArgs.parse({ ...base, buyableCards: { 12: [{}], 40: [{}] } }))).toEqual([12, 40]);
  });
});

describe('state names', () => {
  it('sorts the states this adapter knows from the ones it does not', () => {
    for (const name of ['playAction', 'takeBoardToken', 'takeOpponentToken', 'takeRoyalCard', 'discardTokens']) {
      expect(stateKind(name)).toBe('decision');
    }
    for (const name of ['usePrivilege', 'reserveCard', 'placeJoker']) expect(stateKind(name)).toBe('mid-action');
    expect(stateKind('gameEnd')).toBe('over');
    // Expansion states and anything BGA adds later.
    expect(stateKind('beforeEndTurn')).toBe('unknown');
    expect(stateKind('takeCounterfeiterCard')).toBe('unknown');
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npx vitest run packages/bga-splendor-duel/test/snapshot.test.ts`
Expected: FAIL — cannot resolve `../src/snapshot.js`.

- [ ] **Step 5: Implement `refusal.ts`, `states.ts`, `snapshot.ts`**

`packages/bga-splendor-duel/src/refusal.ts`:

```ts
/**
 * Why the adapter stopped.
 *
 * Every layer returns one of these as a value instead of throwing or guessing. The rule they exist
 * to enforce: when our picture of the table and BGA's might differ, the bot does not move. A person
 * finishes the game, and the snapshot that caused the stop is kept so it can become a test.
 */
export type RefusalReason =
  /** The page did not hand over the shape we read. BGA changed, or the page was not a game. */
  | 'bad-snapshot'
  /** The Counterfeiters expansion, which our engine does not model. */
  | 'expansion'
  /** The logged-in account is not seated at this table. */
  | 'spectator'
  | 'not-our-turn'
  /** A BGA state with no translation. */
  | 'unknown-state'
  /** Half-way through something that is a single action to us. Finish or cancel it. */
  | 'mid-action'
  /** A colour, cell or card BGA named that we have no word for. */
  | 'unmapped'
  /** The snapshot contradicts itself, or cannot be a position of this game. */
  | 'inconsistent'
  /** Our rules and BGA's allow different moves here. */
  | 'disagreement'
  /** BGA turned down a move we submitted. */
  | 'refused';

export interface Refusal {
  reason: RefusalReason;
  detail: string;
}
```

`packages/bga-splendor-duel/src/states.ts`:

```ts
/**
 * BGA's state machine for this game, sorted by what it means to us.
 *
 * Names are from `states.inc.php` in thoun/splendorduel. Three of BGA's states are the *middle* of
 * something our engine treats as one action — pick a gold then pick the card it reserves, buy a wild
 * card then pick its column, press "use privilege" then pick the token. There is no `SplendorView`
 * for those, so they are never a decision point: `play` walks through them itself, and `advise`
 * waits for the operator to come out the other side.
 */
export type StateKind = 'decision' | 'mid-action' | 'over' | 'unknown';

const DECISION = new Set(['playAction', 'takeBoardToken', 'takeOpponentToken', 'takeRoyalCard', 'discardTokens']);
const MID_ACTION = new Set(['usePrivilege', 'reserveCard', 'placeJoker']);

export function stateKind(name: string): StateKind {
  if (DECISION.has(name)) return 'decision';
  if (MID_ACTION.has(name)) return 'mid-action';
  if (name === 'gameEnd') return 'over';
  // Everything else: BGA's own transient states, the expansion's states, and whatever comes later.
  return 'unknown';
}
```

`packages/bga-splendor-duel/src/snapshot.ts`:

```ts
import { z } from 'zod';
import type { Refusal } from './refusal.js';

/**
 * What the reader hands over: the page's full game state, as BGA built it for this seat.
 *
 * The shape follows `getAllDatas` in thoun/splendorduel. Only what the translation reads is listed;
 * zod drops the rest, which is most of it — BGA's framework adds a great deal that is none of our
 * business. What is listed is required: a snapshot missing any of it is refused whole, because a
 * half-read position is worse than none.
 */

/**
 * BGA sends database integers as strings in some places and numbers in others. Accept both, and
 * nothing else — `z.coerce.number()` would also turn `null`, `''` and `true` into numbers, which is
 * exactly the kind of quiet misreading this schema is here to prevent.
 */
const int = z.union([
  z.number().int(),
  z.string().regex(/^-?\d+$/).transform((s) => Number(s)),
]);

const zToken = z.object({
  id: int,
  location: z.string(),
  locationArg: int,
  /** 1 = gold, 2 = a coloured token. */
  type: int,
  color: int,
  /** Board tokens only. */
  row: int.nullish(),
  column: int.nullish(),
});

const zCard = z.object({
  id: int,
  location: z.string(),
  locationArg: int,
  level: int,
  /** Absent when BGA is not showing this seat the card's face. */
  index: int.nullish(),
});

const zRoyal = z.object({
  id: int,
  location: z.string(),
  locationArg: int,
  index: int,
});

const zPlayer = z.object({
  id: int,
  /** 1 once the game is won by this player. */
  score: int,
  /** 1 or 2, in turn order. */
  playerNo: int,
  privileges: int,
  tokens: z.array(zToken),
  cards: z.array(zCard),
  reserved: z.array(zCard),
  royalCards: z.array(zRoyal),
  endReasons: z.array(int).default([]),
});

const byLevel = <T extends z.ZodType>(item: T) => z.object({ 1: item, 2: item, 3: item });

export const zBgaSnapshot = z.object({
  tableId: z.string(),
  /** The logged-in player's id. */
  me: int,
  gamestate: z.object({
    name: z.string(),
    active_player: int.nullish(),
    args: z.unknown(),
  }),
  gamedatas: z.object({
    players: z.record(z.string(), zPlayer),
    board: z.array(zToken),
    cardDeckCount: byLevel(int),
    cardDeckTop: byLevel(zCard.nullable()),
    tableCards: byLevel(z.array(zCard)),
    /** The royals still on the table. */
    royalCards: z.array(zRoyal),
    expansion: z.boolean(),
  }),
});

export type BgaSnapshot = z.infer<typeof zBgaSnapshot>;
export type BgaPlayer = z.infer<typeof zPlayer>;
export type BgaToken = z.infer<typeof zToken>;
export type BgaCard = z.infer<typeof zCard>;
export type BgaRoyal = z.infer<typeof zRoyal>;

/** `argPlayAction`. `buyableCards` is a map by card id — which PHP sends as `[]` when it is empty. */
export const zPlayActionArgs = z.object({
  privileges: int,
  canRefill: z.boolean(),
  mustRefill: z.boolean(),
  canTakeTokens: z.boolean(),
  canReserve: z.boolean(),
  canBuyCard: z.boolean(),
  buyableCards: z.union([z.array(z.unknown()).max(0), z.record(z.string(), z.unknown())]),
});
export type PlayActionArgs = z.infer<typeof zPlayActionArgs>;

export function buyableIds(args: PlayActionArgs): number[] {
  if (Array.isArray(args.buyableCards)) return [];
  return Object.keys(args.buyableCards).map(Number).sort((a, b) => a - b);
}

/** `argTakeBoardToken`. */
export const zTakeBoardTokenArgs = z.object({ color: int, number: int });

/** `argDiscardTokens`. */
export const zDiscardArgs = z.object({ number: int });

export function parseSnapshot(raw: unknown): { ok: true; snapshot: BgaSnapshot } | { ok: false; refusal: Refusal } {
  const parsed = zBgaSnapshot.safeParse(raw);
  if (parsed.success) return { ok: true, snapshot: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return {
    ok: false,
    refusal: { reason: 'bad-snapshot', detail: `The page's game state is not the shape this adapter reads. ${issues}` },
  };
}
```

Append to `packages/bga-splendor-duel/src/index.ts`:

```ts
export * from './refusal.js';
export * from './states.js';
export * from './snapshot.js';
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run packages/bga-splendor-duel`
Expected: PASS, both files.

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/bga-splendor-duel
git commit -m "Say exactly what a BGA snapshot is, and refuse anything else"
```

---

### Task 3: Memory — what a single snapshot cannot say

**Files:**
- Create: `packages/bga-splendor-duel/src/memory.ts`, `packages/bga-splendor-duel/test/memory.test.ts`
- Modify: `packages/bga-splendor-duel/src/index.ts`

**Interfaces:**
- Consumes: `BgaSnapshot`, `BgaPlayer` (Task 2); `cardIdFromBga`, `royalIdFromBga` (Task 1); `stateKind` (Task 2).
- Produces (from `src/memory.ts`):
  - `interface Summary { state: string; ours: boolean; boardCount: number; holdings: string }`
  - `interface Memory { seen: Record<string, string>; baseline: { cards: string[]; royals: string[] } | null; prev: Summary | null; replenished: boolean }`
  - `emptyMemory(): Memory`
  - `summarise(snapshot: BgaSnapshot): Summary`
  - `sameSummary(a: Summary, b: Summary): boolean`
  - `ownedCards(player: BgaPlayer): string[]`, `ownedRoyals(player: BgaPlayer): string[]`
  - `remember(memory: Memory, snapshot: BgaSnapshot): Memory` — must be called with each snapshot **before** `toView` is given that snapshot.

- [ ] **Step 1: Write the failing test**

`packages/bga-splendor-duel/test/memory.test.ts`:

```ts
import { apply, legalActions, setup, type SplendorAction, type SplendorState } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { emptyMemory, remember } from '../src/memory.js';
import { bgaCardId, snap } from './support/synth.js';
import { walk } from './support/play.js';

/**
 * Three things a snapshot does not carry, and the adapter needs.
 *
 * Each is tested through the engine rather than with hand-built snapshots: the question is always
 * "after this real sequence of moves, does memory say the true thing", and a hand-built snapshot
 * would only show that memory agrees with whoever built it.
 */

function must(state: SplendorState, action: SplendorAction): SplendorState {
  const result = apply(state, state.turn, action);
  if (!result.ok) throw new Error(result.error.message);
  return result.state;
}

/** Every position of a game, in order. */
function positions(seed: string, moves: number): SplendorState[] {
  const out: SplendorState[] = [];
  walk(seed, moves, (state) => out.push(state));
  return out;
}

describe('cards seen face-up', () => {
  it('knows an opponent reservation that was taken from the table, and not one taken from a deck', () => {
    const opening = setup({ seed: 'memory-reserve', seats: [0, 1], options: {} });
    const opponent = opening.turn as 0 | 1;
    const viewer = (1 - opponent) as 0 | 1;
    const reserves = legalActions(opening, opponent).actions.filter(
      (a): a is Extract<SplendorAction, { t: 'reserve' }> => a.t === 'reserve',
    );
    const fromTable = reserves.find((a) => a.from.t === 'pyramid');
    const fromDeck = reserves.find((a) => a.from.t === 'deck');
    if (!fromTable || !fromDeck || fromTable.from.t !== 'pyramid') throw new Error('the opening always offers both');

    const taken = opening.pyramid[fromTable.from.level][fromTable.from.slot] as string;
    let memory = remember(emptyMemory(), snap(opening, viewer));
    memory = remember(memory, snap(must(opening, fromTable), viewer));
    expect(memory.seen[String(bgaCardId(taken))]).toBe(taken);

    const blind = must(opening, fromDeck);
    const hidden = blind.players[opponent].reserved[0]?.cardId as string;
    const fresh = remember(remember(emptyMemory(), snap(opening, viewer)), snap(blind, viewer));
    expect(fresh.seen[String(bgaCardId(hidden))]).toBeUndefined();
  });
});

describe('the turn baseline', () => {
  it('holds what we owned before this turn’s purchase, through every decision the purchase causes', () => {
    let memory = emptyMemory();
    let checked = 0;
    const all = positions('memory-baseline', 400);
    all.forEach((state, i) => {
      if (state.stage === 'over') return;
      const viewer = 0;
      memory = remember(memory, snap(state, viewer));
      if (state.turn !== viewer || state.pending === null) return;
      // Walk back to the start of this turn: the last position where it was our optional stage.
      let start = i;
      while (start > 0 && !(all[start]!.turn === viewer && all[start]!.stage === 'optional')) start -= 1;
      const before = all[start]!.players[viewer];
      const owned = [...before.stacks.flatMap((s) => s.cardIds), ...before.colorless].sort();
      expect([...(memory.baseline?.cards ?? [])].sort()).toEqual(owned);
      expect([...(memory.baseline?.royals ?? [])].sort()).toEqual([...before.royals].sort());
      checked += 1;
    });
    expect(checked).toBeGreaterThan(5);
  });
});

describe('our own replenish', () => {
  it('is recognised when it happens, and only then', () => {
    let seen = 0;
    for (const viewer of [0, 1] as const) {
      let memory = emptyMemory();
      walk('memory-replenish', 500, (state) => {
        if (state.stage === 'over') return;
        memory = remember(memory, snap(state, viewer));
        if (state.turn !== viewer) return;
        expect(memory.replenished, `turn ${state.turn}, stage ${state.stage}`).toBe(state.replenishedThisTurn);
        if (state.replenishedThisTurn) seen += 1;
      });
    }
    // The property is vacuous if the game never replenished.
    expect(seen).toBeGreaterThan(0);
  });

  it('is not forgotten when the same position is looked at twice', () => {
    let memory = emptyMemory();
    let repeated = 0;
    walk('memory-replenish', 500, (state) => {
      if (state.stage === 'over') return;
      memory = remember(memory, snap(state, 0));
      if (state.turn === 0 && state.replenishedThisTurn) {
        // A page reload, or the adapter restarting its loop, shows the identical snapshot again.
        memory = remember(memory, snap(state, 0));
        expect(memory.replenished).toBe(true);
        repeated += 1;
      }
    });
    expect(repeated).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/bga-splendor-duel/test/memory.test.ts`
Expected: FAIL — cannot resolve `../src/memory.js`.

- [ ] **Step 3: Implement `memory.ts`**

`packages/bga-splendor-duel/src/memory.ts`:

```ts
import { cardIdFromBga, royalIdFromBga } from './ids.js';
import type { BgaPlayer, BgaSnapshot } from './snapshot.js';

/**
 * The little that has to be carried from one snapshot to the next.
 *
 * A BGA snapshot is the whole position *as BGA shows it to this seat*, and that is nearly a
 * `SplendorView` — but three things our view states outright are, on BGA, only knowable by having
 * been watching:
 *
 *  - **Which of the opponent's reserved cards we saw.** BGA sends an opponent's reservation without
 *    its face even when it was taken from the table in front of us. But BGA's card ids are stable,
 *    so a reserved id we once saw face-up is a card we know. One never seen is `hidden`, which is
 *    less than we were entitled to in the rare case we were not looking, and never more.
 *  - **What we bought this turn.** At a discard it decides whether an extra turn follows, and BGA
 *    keeps that flag server-side. Comparing against what we owned when the turn began recovers it.
 *  - **Whether we replenished this turn.** Recoverable from BGA's arguments only while we hold a
 *    privilege; recognised here by the board growing between two of our own snapshots.
 *
 * Everything here is plain JSON, and everything is derived from snapshots — the same information
 * the page shows the operator. Nothing is read from BGA's notification stream, deliberately: that
 * stream carries cards this seat is not shown.
 */

export interface Summary {
  state: string;
  /** Is the logged-in player the one to act? */
  ours: boolean;
  boardCount: number;
  /** Both players' tokens, purchased cards, and reservation and royal counts. Not privileges. */
  holdings: string;
}

export interface Memory {
  /** BGA card id → our card id, for every jewel card this seat has seen face-up. */
  seen: Record<string, string>;
  /** What our seat owned at the start of its current turn. `null` until a turn has been seen start. */
  baseline: { cards: string[]; royals: string[] } | null;
  /** The last snapshot remembered, in brief. */
  prev: Summary | null;
  /** Whether our seat has replenished in the turn the last snapshot belongs to. */
  replenished: boolean;
}

export function emptyMemory(): Memory {
  return { seen: {}, baseline: null, prev: null, replenished: false };
}

export function ownedCards(player: BgaPlayer): string[] {
  return player.cards.flatMap((held) => {
    const id = held.index == null ? null : cardIdFromBga(held.level, held.index);
    return id ? [id] : [];
  });
}

export function ownedRoyals(player: BgaPlayer): string[] {
  return player.royalCards.flatMap((held) => {
    const id = royalIdFromBga(held.index);
    return id ? [id] : [];
  });
}

function holdingsOf(player: BgaPlayer): string {
  const tokens = player.tokens.map((t) => `${t.type}:${t.color}`).sort().join(',');
  const cards = player.cards.map((c) => c.id).sort((a, b) => a - b).join(',');
  return `${tokens}|${cards}|${player.reserved.length}|${player.royalCards.length}`;
}

export function summarise(snapshot: BgaSnapshot): Summary {
  const players = Object.values(snapshot.gamedatas.players).sort((a, b) => a.id - b.id);
  return {
    state: snapshot.gamestate.name,
    ours: snapshot.gamestate.active_player === snapshot.me,
    boardCount: snapshot.gamedatas.board.length,
    holdings: players.map(holdingsOf).join('/'),
  };
}

export function sameSummary(a: Summary, b: Summary): boolean {
  return a.state === b.state && a.ours === b.ours && a.boardCount === b.boardCount && a.holdings === b.holdings;
}

/**
 * Fold one snapshot into memory. Call it with every snapshot taken, before translating that
 * snapshot: `toView` reads `replenished` and `baseline` as facts about the snapshot it is given.
 */
export function remember(memory: Memory, snapshot: BgaSnapshot): Memory {
  const seen = { ...memory.seen };
  const note = (held: { id: number; level: number; index?: number | null }) => {
    if (held.index == null) return;
    const id = cardIdFromBga(held.level, held.index);
    if (id) seen[String(held.id)] = id;
  };
  for (const level of [1, 2, 3] as const) snapshot.gamedatas.tableCards[level].forEach(note);
  for (const player of Object.values(snapshot.gamedatas.players)) {
    player.cards.forEach(note);
    player.reserved.forEach(note);
  }

  const now = summarise(snapshot);
  // The same position again — a reload, a retry. Nothing happened, so nothing is concluded from it;
  // in particular a replenish already recognised must not be un-recognised by looking twice.
  if (memory.prev && sameSummary(memory.prev, now)) return { ...memory, seen };

  /*
   * The baseline is "what we owned before this turn's purchase". Our holdings cannot change on the
   * opponent's turn or before our mandatory action, so any snapshot taken then is a correct
   * baseline for the turn that follows. Once we are past the mandatory action — resolving an
   * ability, claiming a royal, discarding — the purchase is already in our holdings, so the
   * baseline is kept, not retaken.
   */
  const mine = Object.values(snapshot.gamedatas.players).find((p) => p.id === snapshot.me);
  const beforePurchase = !now.ours || now.state === 'playAction';
  const baseline =
    mine && beforePurchase ? { cards: ownedCards(mine), royals: ownedRoyals(mine) } : memory.baseline;

  /*
   * Our replenish, seen from outside: two consecutive snapshots of our own `playAction`, the board
   * fuller in the second, and nobody's tokens or cards different. An opponent's replenish cannot
   * look like this — their turn does not end until they have also taken, reserved or bought, which
   * changes their holdings. The flag then rides along through the rest of our turn.
   */
  const justReplenished =
    now.ours &&
    now.state === 'playAction' &&
    memory.prev !== null &&
    memory.prev.ours &&
    memory.prev.state === 'playAction' &&
    now.boardCount > memory.prev.boardCount &&
    now.holdings === memory.prev.holdings;
  const replenished = !now.ours ? false : now.state === 'playAction' ? justReplenished : memory.replenished;

  return { seen, baseline, prev: now, replenished };
}
```

Append to `packages/bga-splendor-duel/src/index.ts`:

```ts
export * from './memory.js';
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/bga-splendor-duel/test/memory.test.ts`
Expected: PASS, 4 tests.

If `the turn baseline` or `our own replenish` reports that its counter is zero (the seeded game never reached that situation), change the seed string in that test — try `'memory-baseline-2'`, `'-3'`, … — until it does. Do not lower the threshold; the property is vacuous without at least one case.

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/bga-splendor-duel
git commit -m "Remember what one snapshot cannot say"
```

---

### Task 4: `toView` — a BGA snapshot as the position our bot understands

**Files:**
- Create: `packages/bga-splendor-duel/src/toView.ts`, `packages/bga-splendor-duel/test/toView.test.ts`
- Modify: `packages/bga-splendor-duel/src/index.ts`

**Interfaces:**
- Consumes: `ids.ts` (Task 1); `Refusal`, `stateKind`, `BgaSnapshot`, `BgaPlayer`, `BgaCard`, `zPlayActionArgs`, `zTakeBoardTokenArgs`, `zDiscardArgs` (Task 2); `Memory`, `summarise`, `sameSummary` (Task 3); `RandomCursor` from `@games/engine`; `determinize`, score helpers and types from `@games/splendor-duel`.
- Produces (from `src/toView.ts`):
  - `interface Translation { view: SplendorView; seat: 0 | 1; warnings: string[] }`
  - `type ToViewResult = ({ ok: true } & Translation) | { ok: false; refusal: Refusal }`
  - `toView(snapshot: BgaSnapshot, memory: Memory): ToViewResult` — `memory` must already have been through `remember(memory, snapshot)`; throws a plain `Error` if it has not (a programming mistake, not a refusal).

How each view field BGA does not publish is derived — this table is the contract the round-trip test enforces:

| Field | At `playAction` | At an ability / royal decision | At `discardTokens` |
| --- | --- | --- | --- |
| `stage`, `pending` | `optional`, none | from the state name (see code) | `cleanup`, `discard` |
| `replenishedThisTurn` | `memory.replenished`, or args: we hold a privilege, BGA offers none, board not empty | `memory.replenished` | `memory.replenished` |
| `boughtThisTurn` | `false` | `true` (these states only follow a purchase) | baseline says; else `false` + warning |
| `extraTurns` | `0` | `0` (no card pairs "play again" with a choice or with crowns) | count of "play again" among what was bought or claimed this turn; else `0` + warning |
| `abilityQueue` | `[]` | `[]` | `[]` |
| `royalsTaken` | royals held | royals held | royals held |
| `turnsWithoutPurchase`, `options` | `0`, `{}` | `0`, `{}` | `0`, `{}` |

- [ ] **Step 1: Write the failing test**

`packages/bga-splendor-duel/test/toView.test.ts`:

```ts
import {
  GEM_COLORS,
  apply,
  legalActions,
  legalActionsFromView,
  redactFor,
  setup,
  type SplendorState,
  type SplendorView,
} from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { emptyMemory, remember, type Memory } from '../src/memory.js';
import { parseSnapshot } from '../src/snapshot.js';
import { toView } from '../src/toView.js';
import { PLAYER_ID, snap, synthSnapshot } from './support/synth.js';
import { walk } from './support/play.js';

/**
 * The whole contract in one property.
 *
 * Play a game in our engine. At every decision, dress the position up as BGA would send it to the
 * player deciding, translate that back, and the result has to be the view our own redaction gives
 * that player. If it is, the bot on BGA is looking at the same thing the bot in the arena looked at
 * — which is the only reason to believe a number measured there says anything about a game here.
 *
 * "The same" modulo four things that are orderings rather than facts, and two fields BGA has no
 * counterpart for and the network never sees. `canonical` is the complete list.
 */
function canonical(view: SplendorView): unknown {
  const royals = view.royals.filter((r): r is string => r !== null).sort();
  return {
    ...view,
    // No stall rule on BGA, and neither field is an input to the encoder or to legality.
    options: {},
    turnsWithoutPurchase: 0,
    // Which table slot a royal sits in is arbitrary on both sides.
    royals: [...royals, ...new Array<null>(4 - royals.length).fill(null)],
    players: view.players.map((p) => ({
      ...p,
      stacks: [...p.stacks].sort((a, b) => GEM_COLORS.indexOf(a.color) - GEM_COLORS.indexOf(b.color)),
      reserved: [...p.reserved].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      royals: [...p.royals].sort(),
      colorless: [...p.colorless].sort(),
    })),
  };
}

const viewOf = (state: SplendorState, seat: 0 | 1): SplendorView =>
  JSON.parse(JSON.stringify(redactFor(seat, state))) as SplendorView;

describe('toView', () => {
  it('gives back exactly the view our own redaction produces, at every decision of a game', () => {
    const pendingSeen = new Set<string>();
    let checked = 0;
    for (const seed of ['toview-a', 'toview-b', 'toview-c']) {
      const memory: [Memory, Memory] = [emptyMemory(), emptyMemory()];
      walk(seed, 400, (state) => {
        if (state.stage === 'over') return;
        for (const viewer of [0, 1] as const) {
          const snapshot = snap(state, viewer);
          memory[viewer] = remember(memory[viewer], snapshot);
          if (state.turn !== viewer) continue;

          const result = toView(snapshot, memory[viewer]);
          expect(result.ok, result.ok ? '' : `${result.refusal.reason}: ${result.refusal.detail}`).toBe(true);
          if (!result.ok) return;
          const expected = viewOf(state, viewer);
          expect(result.seat).toBe(viewer);
          expect(canonical(result.view)).toEqual(canonical(expected));
          expect(result.warnings).toEqual([]);
          // Implied by the equality above, and stated anyway: it is the property the bot lives on.
          // As a set, because the order moves are listed in follows the orderings `canonical` ignores.
          const moves = (view: SplendorView) =>
            legalActionsFromView(view, viewer).actions.map((a) => JSON.stringify(a)).sort();
          expect(moves(result.view)).toEqual(moves(expected));
          pendingSeen.add(state.pending?.k ?? 'none');
          checked += 1;
        }
      });
    }
    expect(checked).toBeGreaterThan(300);
    // The property is only as good as the states it visited.
    for (const kind of ['none', 'discard', 'royal', 'matchingToken', 'steal']) {
      expect(pendingSeen.has(kind), `no position with pending "${kind}" was reached; add a seed`).toBe(true);
    }
  });

  it('falls back to hidden for an opponent reservation it never saw face-up', () => {
    // Memory that starts only now: the reservation was made while nobody was watching.
    const opening = setup({ seed: 'toview-late', seats: [0, 1], options: {} });
    const opponent = opening.turn as 0 | 1;
    const viewer = (1 - opponent) as 0 | 1;
    const reserve = legalActions(opening, opponent).actions.find((a) => a.t === 'reserve' && a.from.t === 'pyramid');
    if (!reserve) throw new Error('the opening always offers a table reservation');
    const after = apply(opening, opponent, reserve);
    if (!after.ok) throw new Error(after.error.message);

    const snapshot = snap(after.state, viewer);
    const result = toView(snapshot, remember(emptyMemory(), snapshot));
    if (!result.ok) throw new Error(result.refusal.detail);
    expect(result.view.players[opponent].reserved).toEqual([{ hidden: true }]);
  });
});

describe('what toView refuses', () => {
  const opening = setup({ seed: 'toview-refusals', seats: [0, 1], options: {} });
  const mover = opening.turn as 0 | 1;
  const raw = () => JSON.parse(JSON.stringify(synthSnapshot(opening, mover))) as any;
  const run = (mutate: (snapshot: any) => void) => {
    const edited = raw();
    mutate(edited);
    const parsed = parseSnapshot(edited);
    if (!parsed.ok) throw new Error(parsed.refusal.detail);
    return toView(parsed.snapshot, remember(emptyMemory(), parsed.snapshot));
  };
  const reasonOf = (mutate: (snapshot: any) => void) => {
    const result = run(mutate);
    return result.ok ? 'accepted' : result.refusal.reason;
  };

  it('accepts the unedited opening, so each refusal below is about the edit', () => {
    expect(reasonOf(() => {})).toBe('accepted');
  });

  it('the expansion', () => {
    expect(reasonOf((s) => (s.gamedatas.expansion = true))).toBe('expansion');
  });

  it('a state it has no translation for, and one that is the middle of an action', () => {
    expect(reasonOf((s) => (s.gamestate.name = 'beforeEndTurn'))).toBe('unknown-state');
    expect(reasonOf((s) => (s.gamestate.name = 'reserveCard'))).toBe('mid-action');
  });

  it('a table the logged-in account is not seated at', () => {
    expect(reasonOf((s) => (s.me = 999))).toBe('spectator');
  });

  it("the opponent's turn", () => {
    expect(reasonOf((s) => (s.gamestate.active_player = PLAYER_ID[(1 - mover) as 0 | 1]))).toBe('not-our-turn');
  });

  it('a token colour this game does not have', () => {
    // Type 2 as well: BGA marks gold by type, so a gold token's colour field is never read.
    expect(reasonOf((s) => Object.assign(s.gamedatas.board[0], { type: 2, color: 6 }))).toBe('unmapped');
  });

  it('a board that contradicts itself: two tokens on one cell', () => {
    expect(reasonOf((s) => (s.gamedatas.board[1].locationArg = s.gamedatas.board[0].locationArg))).toBe('inconsistent');
  });

  it('a card it has seen twice', () => {
    // The same face in two table slots: no deal of this deck looks like that.
    expect(
      reasonOf((s) => {
        s.gamedatas.tableCards[1][1].index = s.gamedatas.tableCards[1][0].index;
      }),
    ).toBe('inconsistent');
  });

  it('insists on being given memory that has seen this snapshot', () => {
    const snapshot = snap(opening, mover);
    expect(() => toView(snapshot, emptyMemory())).toThrow(/remember/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/bga-splendor-duel/test/toView.test.ts`
Expected: FAIL — cannot resolve `../src/toView.js`.

- [ ] **Step 3: Implement `toView.ts`**

`packages/bga-splendor-duel/src/toView.ts`:

```ts
import { RandomCursor } from '@games/engine';
import {
  BOARD_CELLS,
  GEM_COLORS,
  LEVELS,
  PYRAMID_WIDTH,
  TOKEN_LIMIT,
  TOTAL_PRIVILEGES,
  bonuses,
  card,
  colorPoints,
  determinize,
  emptyTokens,
  tokenTotal,
  totalCrowns,
  totalPoints,
  type Ability,
  type GemColor,
  type Level,
  type Pending,
  type PlayerState,
  type PlayerView,
  type ReservedView,
  type SplendorView,
  type Stage,
  type TokenColor,
} from '@games/splendor-duel';
import type { z } from 'zod';
import { BGA_COLORLESS, cardIdFromBga, cellFromBga, gemFromBga, royalIdFromBga, tokenColorFromBga } from './ids.js';
import { sameSummary, summarise, type Memory } from './memory.js';
import type { Refusal, RefusalReason } from './refusal.js';
import {
  zDiscardArgs,
  zPlayActionArgs,
  zTakeBoardTokenArgs,
  type BgaCard,
  type BgaPlayer,
  type BgaSnapshot,
} from './snapshot.js';
import { stateKind } from './states.js';

/**
 * A BGA snapshot, as the position our bot understands.
 *
 * The output is a `SplendorView` for the logged-in seat — the type `determinize` and `encodeView`
 * take — so the search and the network run on a BGA game exactly as they do on one of ours, with
 * nothing in either of them knowing the difference.
 *
 * The translation is strict. It has no fallbacks for things it does not recognise, because a
 * fallback here would be a guess about the position, and a bot that plays a guessed position plays
 * moves nobody chose. Anything unrecognised is a `Refusal`. The few places where something has to be
 * *assumed* rather than read — the adapter was started mid-turn, so there is no memory of how the
 * turn began — are returned as `warnings` and shown to the operator.
 */

export interface Translation {
  view: SplendorView;
  seat: 0 | 1;
  /** What had to be assumed rather than read. Never empty silently: the caller shows these. */
  warnings: string[];
}

export type ToViewResult = ({ ok: true } & Translation) | { ok: false; refusal: Refusal };

class Stop extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.detail);
  }
}

function stop(reason: RefusalReason, detail: string): never {
  throw new Stop({ reason, detail });
}

export function toView(snapshot: BgaSnapshot, memory: Memory): ToViewResult {
  if (!memory.prev || !sameSummary(memory.prev, summarise(snapshot))) {
    throw new Error('toView: call remember(memory, snapshot) with this snapshot first');
  }
  try {
    return { ok: true, ...translate(snapshot, memory) };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

function seatOf(player: BgaPlayer): 0 | 1 {
  if (player.playerNo === 1) return 0;
  if (player.playerNo === 2) return 1;
  return stop('bad-snapshot', `Player ${player.id} has turn order ${player.playerNo}; expected 1 or 2.`);
}

function jewel(held: BgaCard): string {
  const id = held.index == null ? null : cardIdFromBga(held.level, held.index);
  return id ?? stop('unmapped', `BGA card ${held.id} (level ${held.level}, index ${String(held.index)}) is not a card we know.`);
}

function args<T>(schema: z.ZodType<T>, snapshot: BgaSnapshot): T {
  const parsed = schema.safeParse(snapshot.gamestate.args);
  if (!parsed.success) {
    stop('bad-snapshot', `State "${snapshot.gamestate.name}" came with arguments this adapter does not recognise.`);
  }
  return parsed.data;
}

function buildPlayer(player: BgaPlayer, mine: boolean, memory: Memory): PlayerView {
  const tokens = emptyTokens();
  for (const token of player.tokens) {
    const color =
      tokenColorFromBga(token) ??
      stop('unmapped', `Player ${player.id} holds a token of BGA colour ${token.color}, which the base game does not have.`);
    tokens[color] += 1;
  }

  const byColor = new Map<GemColor, string[]>();
  const colorless: string[] = [];
  // BGA files a purchased card under `player<id>-<column>`, and orders within a column by position.
  for (const held of [...player.cards].sort((a, b) => a.locationArg - b.locationArg)) {
    const id = jewel(held);
    const def = card(id);
    const column = Number(held.location.slice(held.location.lastIndexOf('-') + 1));
    if (column === BGA_COLORLESS) {
      if (def.wild) stop('mid-action', `Wild card ${id} has been bought but not yet placed on a column.`);
      if (def.bonusColor) stop('inconsistent', `Card ${id} has a ${def.bonusColor} bonus but sits with the colourless cards.`);
      colorless.push(id);
      continue;
    }
    const gem = gemFromBga(column) ?? stop('unmapped', `Card ${id} sits in "${held.location}", which is not a gem column.`);
    if (!def.wild && def.bonusColor !== gem) {
      stop('inconsistent', `Card ${id} has a ${String(def.bonusColor)} bonus but sits in the ${gem} column.`);
    }
    byColor.set(gem, [...(byColor.get(gem) ?? []), id]);
  }
  const stacks = GEM_COLORS.filter((color) => byColor.has(color)).map((color) => ({
    color,
    cardIds: byColor.get(color) as string[],
  }));

  const royals = player.royalCards.map(
    (held) => royalIdFromBga(held.index) ?? stop('expansion', `Royal card ${held.index} belongs to the Counterfeiters expansion.`),
  );

  const reserved: ReservedView[] = player.reserved.map((held) => {
    if (held.index != null) return { cardId: jewel(held) };
    if (mine) stop('bad-snapshot', `Our own reserved card ${held.id} arrived without its face.`);
    // BGA never shows an opponent's reservation. If we saw this card id on the table earlier, it
    // was reserved in front of us and we know it; otherwise it came off a deck, or we were not
    // watching, and either way it is hidden.
    const known = memory.seen[String(held.id)];
    return known ? { cardId: known } : { hidden: true };
  });

  // Only the fields the score helpers read; `reserved` is irrelevant to every one of them.
  const scored: PlayerState = {
    tokens,
    privileges: player.privileges,
    reserved: [],
    stacks,
    colorless,
    royals,
    royalsTaken: royals.length,
  };
  return {
    seat: seatOf(player),
    tokens,
    tokenTotal: tokenTotal(tokens),
    privileges: player.privileges,
    reserved,
    stacks,
    colorless,
    royals,
    // A royal is only ever claimed by crossing a crown threshold, one per threshold, and with four
    // royals for two players the table cannot run out. So the count of one is the count of the other.
    royalsTaken: royals.length,
    points: totalPoints(scored),
    crowns: totalCrowns(scored),
    bonuses: bonuses(scored),
    colorPoints: colorPoints(scored),
  };
}

interface TurnFacts {
  stage: Stage;
  pending: Pending | null;
  replenished: boolean;
  bought: boolean;
  extraTurns: number;
}

/**
 * Where in the turn we are: the part of a view that BGA expresses as a state name and a few
 * server-side flags, and we express as fields.
 */
function turnFacts(snapshot: BgaSnapshot, mine: PlayerView, memory: Memory, warnings: string[]): TurnFacts {
  const has = (id: string, ability: Ability): boolean => card(id).abilities.includes(ability);
  const owned = [...mine.stacks.flatMap((s) => s.cardIds), ...mine.colorless];

  // What this turn added, by comparison with how the turn began. At most one card and one royal can
  // arrive in a turn, so more than that means the baseline is from some earlier turn and is no use.
  const base = memory.baseline;
  let bought = base ? owned.filter((id) => !base.cards.includes(id)) : null;
  let claimed = base ? mine.royals.filter((id) => !base.royals.includes(id)) : null;
  if ((bought && bought.length > 1) || (claimed && claimed.length > 1)) {
    bought = null;
    claimed = null;
  }

  const replenished = memory.replenished;
  switch (snapshot.gamestate.name) {
    case 'playAction': {
      const a = args(zPlayActionArgs, snapshot);
      // BGA stops offering privileges once the board has been replenished this turn. If we hold one,
      // the board has something on it, and none is on offer, that is what happened. This is the
      // fallback for a first snapshot; memory recognises the replenish directly when it saw it.
      const locked = mine.privileges > 0 && a.privileges === 0 && snapshot.gamedatas.board.length > 0;
      return { stage: 'optional', pending: null, replenished: replenished || locked, bought: false, extraTurns: 0 };
    }

    case 'takeBoardToken': {
      const a = args(zTakeBoardTokenArgs, snapshot);
      const color = gemFromBga(a.color) ?? stop('expansion', `"Take a token" of BGA colour ${a.color} is an expansion power.`);
      // The card that granted this is the one just bought, which is the newest in its own column.
      const cardId =
        mine.stacks.find((s) => s.color === color)?.cardIds.at(-1) ??
        stop('inconsistent', `BGA asks for a ${color} token for a ${color} card, and we own no ${color} card.`);
      return { stage: 'abilities', pending: { k: 'matchingToken', color, cardId }, replenished, bought: true, extraTurns: 0 };
    }

    case 'takeOpponentToken': {
      const royal = mine.royals.find((id) => has(id, 'stealToken'));
      const cards = owned.filter((id) => has(id, 'stealToken'));
      let fromRoyal: boolean;
      if (claimed) {
        fromRoyal = claimed.some((id) => has(id, 'stealToken'));
      } else if (royal && cards.length === 0) {
        fromRoyal = true;
      } else {
        fromRoyal = false;
        if (royal) warnings.push('Started mid-turn: cannot tell whether a card or a royal granted this steal; assumed the card.');
      }
      if (fromRoyal) {
        const cardId = royal ?? stop('inconsistent', 'BGA asks for a steal and we hold nothing that grants one.');
        // A royal's ability resolves in the crowns stage, after the card's own.
        return { stage: 'crowns', pending: { k: 'steal', source: 'royal', cardId }, replenished, bought: true, extraTurns: 0 };
      }
      const cardId =
        bought?.find((id) => has(id, 'stealToken')) ??
        cards.at(-1) ??
        stop('inconsistent', 'BGA asks for a steal and we hold nothing that grants one.');
      return { stage: 'abilities', pending: { k: 'steal', source: 'card', cardId }, replenished, bought: true, extraTurns: 0 };
    }

    case 'takeRoyalCard':
      return { stage: 'crowns', pending: { k: 'royal' }, replenished, bought: true, extraTurns: 0 };

    case 'discardTokens': {
      const a = args(zDiscardArgs, snapshot);
      const count = mine.tokenTotal - TOKEN_LIMIT;
      if (count <= 0 || count !== a.number) {
        stop('inconsistent', `BGA asks for ${a.number} discard(s); we count ${mine.tokenTotal} tokens.`);
      }
      const pending: Pending = { k: 'discard', count };
      if (!bought || !claimed) {
        warnings.push('Started mid-turn: cannot tell whether an extra turn follows this discard; assumed not.');
        return { stage: 'cleanup', pending, replenished, bought: false, extraTurns: 0 };
      }
      // "Play again" is the one ability whose effect outlives the turn's other decisions, and BGA
      // keeps the flag server-side. What was bought or claimed this turn says the same thing.
      const extraTurns = [...bought, ...claimed].filter((id) => has(id, 'playAgain')).length;
      return { stage: 'cleanup', pending, replenished, bought: bought.length > 0, extraTurns };
    }

    default:
      return stop('unknown-state', `No translation for BGA state "${snapshot.gamestate.name}".`);
  }
}

function translate(snapshot: BgaSnapshot, memory: Memory): Translation {
  const { gamedatas, gamestate } = snapshot;
  if (gamedatas.expansion) stop('expansion', 'The Counterfeiters expansion is enabled on this table.');

  const kind = stateKind(gamestate.name);
  if (kind === 'mid-action') {
    stop('mid-action', `The table is in "${gamestate.name}", the middle of an action. Finish or cancel it.`);
  }
  if (kind !== 'decision') stop('unknown-state', `No translation for BGA state "${gamestate.name}".`);

  const players = Object.values(gamedatas.players);
  if (players.length !== 2) stop('bad-snapshot', `Expected 2 players, found ${players.length}.`);
  const mine = players.find((p) => p.id === snapshot.me) ?? stop('spectator', 'The logged-in account is not seated at this table.');
  const theirs = players.find((p) => p.id !== snapshot.me) ?? stop('bad-snapshot', 'No opponent at this table.');
  if (gamestate.active_player !== mine.id) stop('not-our-turn', 'It is not our seat that is to act.');

  const me = buildPlayer(mine, true, memory);
  const them = buildPlayer(theirs, false, memory);
  if (me.seat === them.seat) stop('bad-snapshot', 'Both players report the same turn order.');
  const seat = me.seat as 0 | 1;

  const board: (TokenColor | null)[] = new Array<TokenColor | null>(BOARD_CELLS).fill(null);
  for (const token of gamedatas.board) {
    const cell = cellFromBga(token.locationArg) ?? stop('unmapped', `Board token ${token.id} is at position ${token.locationArg}.`);
    const color = tokenColorFromBga(token) ?? stop('unmapped', `Board token ${token.id} has BGA colour ${token.color}.`);
    if (board[cell] !== null) stop('inconsistent', `Two tokens on board position ${token.locationArg}.`);
    board[cell] = color;
  }

  const pyramid = {} as Record<Level, (string | null)[]>;
  const decks = {} as Record<Level, number>;
  for (const level of LEVELS) {
    const row = new Array<string | null>(PYRAMID_WIDTH[level]).fill(null);
    for (const held of gamedatas.tableCards[level]) {
      const slot = held.locationArg - 1;
      if (held.level !== level || slot < 0 || slot >= row.length) {
        stop('inconsistent', `Table card ${held.id} claims level ${held.level}, slot ${held.locationArg}, in the level ${level} row.`);
      }
      row[slot] = jewel(held);
    }
    pyramid[level] = row;
    decks[level] = gamedatas.cardDeckCount[level];
  }

  const onTable = gamedatas.royalCards
    .map((held) => royalIdFromBga(held.index) ?? stop('expansion', `Royal card ${held.index} belongs to the Counterfeiters expansion.`))
    .sort();
  if (onTable.length > 4) stop('inconsistent', `${onTable.length} royal cards on the table.`);
  // Slot order is arbitrary on both sides; claimed royals leave `null`s, as they do in our engine.
  const royals: (string | null)[] = [...onTable, ...new Array<null>(4 - onTable.length).fill(null)];

  const privilegePool = TOTAL_PRIVILEGES - me.privileges - them.privileges;
  if (privilegePool < 0) stop('inconsistent', 'The two players hold more than three privileges between them.');
  const bagTotal = BOARD_CELLS - gamedatas.board.length - me.tokenTotal - them.tokenTotal;
  if (bagTotal < 0) stop('inconsistent', 'More than 25 tokens are in play.');

  const warnings: string[] = [];
  const facts = turnFacts(snapshot, me, memory, warnings);

  const view: SplendorView = {
    v: 1,
    you: seat,
    bag: { total: bagTotal },
    board,
    decks,
    pyramid,
    royals,
    privilegePool,
    players: seat === 0 ? [me, them] : [them, me],
    turn: seat,
    stage: facts.stage,
    pending: facts.pending,
    extraTurns: facts.extraTurns,
    replenishedThisTurn: facts.replenished,
    // Empty at every decision point: no card queues a second ability behind a choice.
    abilityQueue: [],
    // BGA has no stall rule, and neither of these reaches the network or the legality check.
    turnsWithoutPurchase: 0,
    boughtThisTurn: facts.bought,
    options: {},
    winner: null,
    winReason: null,
  };

  /*
   * The last check is the search's own first step. `determinize` rebuilds the bag and the decks by
   * subtraction, and throws if the counts cannot be a real position — a card seen twice, a colour
   * with five tokens. Better found here, as a refusal with the snapshot attached, than as an
   * exception a thousand iterations into a search.
   */
  try {
    determinize(view, seat, new RandomCursor('bga-consistency', 0));
  } catch (error) {
    stop('inconsistent', `The snapshot is not a possible position: ${(error as Error).message}`);
  }

  return { view, seat, warnings };
}
```

Append to `packages/bga-splendor-duel/src/index.ts`:

```ts
export * from './toView.js';
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/bga-splendor-duel/test/toView.test.ts`
Expected: PASS, 11 tests.

How to read a failure of the round-trip property — the diff names the field:
- `pending.cardId` or `pending.source`: the derivation in `turnFacts` for that state is wrong; compare with how `apply.ts` sets `state.pending`.
- `replenishedThisTurn`, `boughtThisTurn`, `extraTurns`: compare with the table at the top of this task; the bug is in `turnFacts` or in `remember`.
- a `players[..]` field: `buildPlayer`, or `playerJson` in `test/support/synth.ts` disagreeing with BGA's `getAllDatas` — re-read that method before changing either.
- `no position with pending "…" was reached`: add another seed to the list in the test. Do not delete the kind.
- `a card it has seen twice` not refused: `determinize` did not throw for a duplicate face. Then add to `translate`, before the `determinize` call, an explicit check that no card id appears twice across the pyramid, both players' stacks, colourless piles and visible reservations, and `stop('inconsistent', …)` if one does.

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/bga-splendor-duel
git commit -m "Read a BGA table as the position our bot already understands"
```

---

### Task 5: `locate` and `crossCheck` — where things are, and whether BGA agrees

**Files:**
- Create: `packages/bga-splendor-duel/src/locate.ts`, `src/crosscheck.ts`, `packages/bga-splendor-duel/test/crosscheck.test.ts`
- Modify: `packages/bga-splendor-duel/src/index.ts`

**Interfaces:**
- Consumes: `BgaSnapshot`, `BgaToken`, `zPlayActionArgs`, `buyableIds` (Task 2); `ids.ts` (Task 1); `legalActionsFromView`, `LEVELS` from `@games/splendor-duel`.
- Produces:
  - `locate.ts`:
    ```ts
    interface Located {
      boardToken: Map<number, BgaToken>;            // our cell → the BGA token on it
      myTokens: Record<TokenColor, number[]>;       // BGA token ids we hold, by colour, ascending
      theirTokens: Record<TokenColor, number[]>;
      cardBgaId: Map<string, number>;               // our card id → BGA id (table + our reserve)
      ourCardId: Map<number, string>;               // the same, the other way
      royalBgaId: Map<string, number>;              // royals on the table
      deckTop: Record<1 | 2 | 3, number | null>;    // BGA id of the top card of each deck
    }
    locate(snapshot: BgaSnapshot): Located
    ```
  - `crosscheck.ts`: `crossCheck(view: SplendorView, seat: 0 | 1, snapshot: BgaSnapshot): string[]` — one sentence per disagreement; empty means the two rule sets agree about this position.

- [ ] **Step 1: Write the failing test**

`packages/bga-splendor-duel/test/crosscheck.test.ts`:

```ts
import { legalActionsFromView, setup } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { crossCheck } from '../src/crosscheck.js';
import { locate } from '../src/locate.js';
import { emptyMemory, remember, type Memory } from '../src/memory.js';
import { parseSnapshot, type BgaSnapshot } from '../src/snapshot.js';
import { toView } from '../src/toView.js';
import { bgaCardId, boardTokenId, snap, synthSnapshot } from './support/synth.js';
import { walk } from './support/play.js';

/**
 * Two implementations of the same rules, asked the same question.
 *
 * BGA tells the active player what they may do — whether they can replenish, whether they can
 * reserve, exactly which cards they can afford. Our engine works the same things out from the view.
 * Where the two differ, one of them is looking at a different position, and that is the moment to
 * stop: it is the cheapest possible detector for every translation bug nobody thought to test.
 */

function translated(snapshot: BgaSnapshot, memory: Memory) {
  const result = toView(snapshot, memory);
  if (!result.ok) throw new Error(result.refusal.detail);
  return result;
}

describe('crossCheck', () => {
  it('finds nothing to object to in a whole game, except being stuck', () => {
    let checked = 0;
    const memory: [Memory, Memory] = [emptyMemory(), emptyMemory()];
    walk('crosscheck', 400, (state) => {
      if (state.stage === 'over') return;
      for (const viewer of [0, 1] as const) {
        const snapshot = snap(state, viewer);
        memory[viewer] = remember(memory[viewer], snapshot);
        if (state.turn !== viewer) continue;
        const { view, seat } = translated(snapshot, memory[viewer]);
        const problems = crossCheck(view, seat, snapshot);
        const { actions } = legalActionsFromView(view, seat);
        const stuck = actions.length === 1 && actions[0]?.t === 'pass';
        if (stuck) expect(problems.join(' ')).toMatch(/stuck/);
        else expect(problems).toEqual([]);
        checked += 1;
      }
    });
    expect(checked).toBeGreaterThan(100);
  });

  const opening = setup({ seed: 'crosscheck-opening', seats: [0, 1], options: {} });
  const mover = opening.turn as 0 | 1;
  const edited = (mutate: (snapshot: any) => void) => {
    const raw = JSON.parse(JSON.stringify(synthSnapshot(opening, mover))) as any;
    mutate(raw);
    const parsed = parseSnapshot(raw);
    if (!parsed.ok) throw new Error(parsed.refusal.detail);
    const result = toView(parsed.snapshot, remember(emptyMemory(), parsed.snapshot));
    if (!result.ok) throw new Error(result.refusal.detail);
    return crossCheck(result.view, result.seat, parsed.snapshot);
  };

  it('objects when BGA would let us replenish and we would not', () => {
    // The opening has an empty bag, so neither side should offer it.
    expect(edited(() => {})).toEqual([]);
    expect(edited((s) => (s.gamestate.args.canRefill = true)).join(' ')).toMatch(/replenish/i);
  });

  it('objects when BGA and we disagree about which cards can be bought', () => {
    const anyTableCard = bgaCardId(opening.pyramid[1][0] as string);
    const problems = edited((s) => {
      s.gamestate.args.canBuyCard = true;
      s.gamestate.args.buyableCards = { [anyTableCard]: [{}] };
    });
    expect(problems.join(' ')).toMatch(/afford/i);
    expect(problems.join(' ')).toContain(opening.pyramid[1][0] as string);
  });

  it('objects when BGA says we cannot reserve and we think we can', () => {
    expect(edited((s) => (s.gamestate.args.canReserve = false)).join(' ')).toMatch(/reserve/i);
  });
});

describe('locate', () => {
  it('finds every cell, card and deck the legal moves of a position refer to', () => {
    const opening = setup({ seed: 'locate', seats: [0, 1], options: {} });
    const mover = opening.turn as 0 | 1;
    const at = locate(snap(opening, mover));
    opening.board.forEach((color, cell) => {
      if (color !== null) expect(at.boardToken.get(cell)?.id).toBe(boardTokenId(cell));
    });
    for (const level of [1, 2, 3] as const) {
      for (const id of opening.pyramid[level]) {
        if (id) expect(at.cardBgaId.get(id)).toBe(bgaCardId(id));
        if (id) expect(at.ourCardId.get(bgaCardId(id))).toBe(id);
      }
      expect(at.deckTop[level]).toBe(bgaCardId(opening.decks[level][0] as string));
    }
    expect(at.royalBgaId.size).toBe(4);
    expect(Object.values(at.myTokens).flat()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/bga-splendor-duel/test/crosscheck.test.ts`
Expected: FAIL — cannot resolve `../src/crosscheck.js`.

- [ ] **Step 3: Implement `locate.ts`**

`packages/bga-splendor-duel/src/locate.ts`:

```ts
import type { TokenColor } from '@games/splendor-duel';
import { cardIdFromBga, cellFromBga, royalIdFromBga, tokenColorFromBga } from './ids.js';
import type { BgaPlayer, BgaSnapshot, BgaToken } from './snapshot.js';

/**
 * Where everything our actions name actually is on the BGA table.
 *
 * Our actions talk about positions and kinds — "cell 7", "two blue", "the card in level 2, slot 1".
 * BGA's talk about individual objects by database id. This is the index between them, built once
 * per snapshot, and it is what both the instructions for a person and the calls for the page are
 * written from, so the two cannot point at different things.
 *
 * It assumes a snapshot `toView` has already accepted, and skips anything it cannot name rather
 * than complaining twice about it.
 */
export interface Located {
  /** Our cell → the BGA token sitting on it. */
  boardToken: Map<number, BgaToken>;
  /** The BGA ids of the tokens we hold, by colour, lowest id first. */
  myTokens: Record<TokenColor, number[]>;
  theirTokens: Record<TokenColor, number[]>;
  /** Our card id → BGA's, for the cards we can act on: the table and our own reservations. */
  cardBgaId: Map<string, number>;
  ourCardId: Map<number, string>;
  /** The royals still on the table. */
  royalBgaId: Map<string, number>;
  /** BGA's id for the top card of each deck — what "reserve from the deck" has to name. */
  deckTop: Record<1 | 2 | 3, number | null>;
}

function byColor(player: BgaPlayer | undefined): Record<TokenColor, number[]> {
  const out: Record<TokenColor, number[]> = { white: [], blue: [], green: [], red: [], black: [], pearl: [], gold: [] };
  for (const token of player?.tokens ?? []) {
    const color = tokenColorFromBga(token);
    if (color) out[color].push(token.id);
  }
  for (const ids of Object.values(out)) ids.sort((a, b) => a - b);
  return out;
}

export function locate(snapshot: BgaSnapshot): Located {
  const { gamedatas } = snapshot;
  const players = Object.values(gamedatas.players);
  const mine = players.find((p) => p.id === snapshot.me);
  const theirs = players.find((p) => p.id !== snapshot.me);

  const boardToken = new Map<number, BgaToken>();
  for (const token of gamedatas.board) {
    const cell = cellFromBga(token.locationArg);
    if (cell !== null) boardToken.set(cell, token);
  }

  const cardBgaId = new Map<string, number>();
  const ourCardId = new Map<number, string>();
  const note = (held: { id: number; level: number; index?: number | null }) => {
    const id = held.index == null ? null : cardIdFromBga(held.level, held.index);
    if (!id) return;
    cardBgaId.set(id, held.id);
    ourCardId.set(held.id, id);
  };
  for (const level of [1, 2, 3] as const) gamedatas.tableCards[level].forEach(note);
  mine?.reserved.forEach(note);

  const royalBgaId = new Map<string, number>();
  for (const held of gamedatas.royalCards) {
    const id = royalIdFromBga(held.index);
    if (id) royalBgaId.set(id, held.id);
  }

  return {
    boardToken,
    myTokens: byColor(mine),
    theirTokens: byColor(theirs),
    cardBgaId,
    ourCardId,
    royalBgaId,
    deckTop: {
      1: gamedatas.cardDeckTop[1]?.id ?? null,
      2: gamedatas.cardDeckTop[2]?.id ?? null,
      3: gamedatas.cardDeckTop[3]?.id ?? null,
    },
  };
}
```

- [ ] **Step 4: Implement `crosscheck.ts`**

`packages/bga-splendor-duel/src/crosscheck.ts`:

```ts
import { LEVELS, legalActionsFromView, type SplendorView } from '@games/splendor-duel';
import { locate } from './locate.js';
import { buyableIds, zPlayActionArgs, type BgaSnapshot } from './snapshot.js';

/**
 * Ask both rule sets what is allowed here, and report every difference.
 *
 * BGA sends the active player a summary of their options with each state. Our engine derives the
 * same things from the translated view. They are independent computations over what should be the
 * same position, so a difference means the position was mistranslated — or the two implementations
 * disagree about a rule — and in neither case should the bot move.
 *
 * Returns one sentence per disagreement. Empty means agreement, which is the only case the loop
 * continues in.
 *
 * Two of BGA's rules are deliberately not modelled and land here as stops rather than as moves:
 * its forced refill when a player has nothing else (we have `pass` for the residue of that), and
 * its option to end the game against an opponent hoarding every gold and pearl.
 */
export function crossCheck(view: SplendorView, seat: 0 | 1, snapshot: BgaSnapshot): string[] {
  const problems: string[] = [];
  const { actions } = legalActionsFromView(view, seat);

  if (actions.length === 0) problems.push('Our rules find no legal move in this position.');
  if (actions.length === 1 && actions[0]?.t === 'pass') {
    problems.push('Our rules say this seat is stuck and can only pass, which BGA has no move for.');
  }

  const name = snapshot.gamestate.name;

  if (name === 'takeRoyalCard' && actions.length !== snapshot.gamedatas.royalCards.length) {
    problems.push(`BGA shows ${snapshot.gamedatas.royalCards.length} royal card(s) to choose from; we count ${actions.length}.`);
  }

  if (name !== 'playAction') return problems;

  const parsed = zPlayActionArgs.safeParse(snapshot.gamestate.args);
  if (!parsed.success) return [...problems, 'BGA sent arguments for this state that this adapter does not recognise.'];
  const args = parsed.data;

  const weReplenish = actions.some((a) => a.t === 'replenish');
  if (weReplenish !== args.canRefill) {
    problems.push(`Replenish: BGA says ${args.canRefill ? 'allowed' : 'not allowed'}, we say ${weReplenish ? 'allowed' : 'not allowed'}.`);
  }

  // BGA offers privileges whenever the board is not empty; they can only ever take a non-gold token.
  const nonGold = view.board.some((token) => token !== null && token !== 'gold');
  const wePrivilege = actions.some((a) => a.t === 'usePrivilege');
  if (wePrivilege !== (args.privileges > 0 && nonGold)) {
    problems.push(`Privileges: BGA offers ${args.privileges}, we ${wePrivilege ? 'can' : 'cannot'} spend one.`);
  }

  const gold = view.board.includes('gold');
  const somethingToReserve = LEVELS.some((level) => view.decks[level] > 0 || view.pyramid[level].some((id) => id !== null));
  const weReserve = actions.some((a) => a.t === 'reserve');
  if (weReserve !== (args.canReserve && gold && somethingToReserve)) {
    problems.push(`Reserve: BGA says ${args.canReserve ? 'allowed' : 'not allowed'}, we say ${weReserve ? 'allowed' : 'not allowed'}.`);
  }

  // The sharpest check there is: the exact set of affordable cards depends on every token we hold,
  // every bonus we own, every cost, and every card id being mapped correctly.
  const ours = new Set<string>();
  for (const action of actions) {
    if (action.t !== 'purchase') continue;
    const id = action.from.t === 'pyramid' ? view.pyramid[action.from.level][action.from.slot] : action.from.cardId;
    if (id) ours.add(id);
  }
  const at = locate(snapshot);
  const theirs = new Set<string>();
  for (const bga of buyableIds(args)) theirs.add(at.ourCardId.get(bga) ?? `BGA card ${bga}`);
  const onlyOurs = [...ours].filter((id) => !theirs.has(id)).sort();
  const onlyTheirs = [...theirs].filter((id) => !ours.has(id)).sort();
  if (onlyOurs.length > 0) problems.push(`We think we can afford ${onlyOurs.join(', ')}; BGA does not.`);
  if (onlyTheirs.length > 0) problems.push(`BGA thinks we can afford ${onlyTheirs.join(', ')}; we do not.`);

  return problems;
}
```

Append to `packages/bga-splendor-duel/src/index.ts`:

```ts
export * from './locate.js';
export * from './crosscheck.js';
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/bga-splendor-duel/test/crosscheck.test.ts`
Expected: PASS, 5 tests.

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/bga-splendor-duel
git commit -m "Stop when BGA's rules and ours allow different moves"
```

---

### Task 6: `instruct` — a move, in words a person can click

**Files:**
- Create: `packages/bga-splendor-duel/src/instruct.ts`, `packages/bga-splendor-duel/test/instruct.test.ts`
- Modify: `packages/bga-splendor-duel/src/index.ts`

**Interfaces:**
- Consumes: `Located`, `locate` (Task 5); `cardLabel`, `describeAction`, `TOKEN_COLORS`, `SplendorAction`, `SplendorView` from `@games/splendor-duel`.
- Produces (from `src/instruct.ts`):
  - `interface Instruction { text: string; steps: string[]; highlight: string[] }` — `text` is the move in one line; `steps` is what to click, in order; `highlight` is DOM element ids on the BGA page (`token-<id>`, `card-<id>`, `royal-card-<id>`, `card-deck-<level>`; these id formats are the `getId` functions in thoun/splendorduel's `src/ts/tokens.ts`, `cards.ts`, `royal-cards.ts` and `table-center.ts`).
  - `instruct(action: SplendorAction, view: SplendorView, at: Located): Instruction` — throws for `pass`, which the loop never asks for (`crossCheck` stops first).

- [ ] **Step 1: Write the failing test**

`packages/bga-splendor-duel/test/instruct.test.ts`:

```ts
import { apply, legalActions, legalActionsFromView, setup, type SplendorAction, type SplendorState } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { instruct } from '../src/instruct.js';
import { locate } from '../src/locate.js';
import { emptyMemory, remember, type Memory } from '../src/memory.js';
import { toView } from '../src/toView.js';
import { bgaCardId, boardTokenId, snap } from './support/synth.js';
import { walk } from './support/play.js';

/**
 * In `advise` mode this text is the whole interface between the bot and the table. A move the
 * operator cannot find, or finds the wrong one of, is a move the bot did not make.
 */

function advise(state: SplendorState, viewer: 0 | 1, action: SplendorAction) {
  const snapshot = snap(state, viewer);
  const result = toView(snapshot, remember(emptyMemory(), snapshot));
  if (!result.ok) throw new Error(result.refusal.detail);
  return instruct(action, result.view, locate(snapshot));
}

describe('instruct', () => {
  const opening = setup({ seed: 'instruct', seats: [0, 1], options: {} });
  const mover = opening.turn as 0 | 1;
  const legal = legalActions(opening, mover).actions;
  const first = <T extends SplendorAction['t']>(t: T, also: (a: Extract<SplendorAction, { t: T }>) => boolean = () => true) => {
    const found = legal.find((a): a is Extract<SplendorAction, { t: T }> => a.t === t && also(a as Extract<SplendorAction, { t: T }>));
    if (!found) throw new Error(`the opening offers no ${t}`);
    return found;
  };

  it('names each token to take by colour and by where it is on the BGA board, and highlights them', () => {
    const take = first('takeTokens', (a) => a.cells.length === 3);
    const said = advise(opening, mover, take);
    expect(said.highlight).toEqual(take.cells.map((cell) => `token-${boardTokenId(cell)}`));
    for (const cell of take.cells) expect(said.steps.join(' ')).toContain(opening.board[cell] as string);
    expect(said.steps.join(' ')).toMatch(/row \d, column \d/);
    expect(said.steps.at(-1)).toMatch(/confirm/i);
  });

  it('gives a table reservation as two steps: the gold, then the card', () => {
    const reserve = first('reserve', (a) => a.from.t === 'pyramid');
    if (reserve.from.t !== 'pyramid') throw new Error('unreachable');
    const cardId = opening.pyramid[reserve.from.level][reserve.from.slot] as string;
    const said = advise(opening, mover, reserve);
    expect(said.steps).toHaveLength(2);
    expect(said.steps[0]).toMatch(/gold/);
    expect(said.steps[1]).toContain(`level ${reserve.from.level}`);
    expect(said.steps[1]).toContain(`card ${reserve.from.slot + 1}`);
    expect(said.highlight).toEqual([`token-${boardTokenId(reserve.goldCell)}`, `card-${bgaCardId(cardId)}`]);
  });

  it('points at the deck itself for a blind reservation', () => {
    const reserve = first('reserve', (a) => a.from.t === 'deck' && a.from.level === 2);
    const said = advise(opening, mover, reserve);
    expect(said.highlight[1]).toBe('card-deck-2');
    expect(said.steps[1]).toMatch(/level 2 deck/);
  });

  it('has something to say for every legal move of a whole game, and never points at nothing', () => {
    let said = 0;
    const memory: [Memory, Memory] = [emptyMemory(), emptyMemory()];
    const kinds = new Set<string>();
    walk('instruct-walk', 400, (state) => {
      if (state.stage === 'over') return;
      for (const viewer of [0, 1] as const) {
        const snapshot = snap(state, viewer);
        memory[viewer] = remember(memory[viewer], snapshot);
        if (state.turn !== viewer) continue;
        const result = toView(snapshot, memory[viewer]);
        if (!result.ok) throw new Error(result.refusal.detail);
        const at = locate(snapshot);
        for (const action of legalActionsFromView(result.view, viewer).actions) {
          if (action.t === 'pass') continue;
          const instruction = instruct(action, result.view, at);
          expect(instruction.text.length).toBeGreaterThan(0);
          expect(instruction.steps.length).toBeGreaterThan(0);
          for (const id of instruction.highlight) expect(id).toMatch(/^(token|card|royal-card|card-deck)-\d+$/);
          // And the move it describes is one the engine accepts, so the words are about a real move.
          expect(apply(state, viewer, action).ok).toBe(true);
          kinds.add(action.t);
          said += 1;
        }
      }
    });
    expect(said).toBeGreaterThan(1000);
    for (const kind of ['takeTokens', 'usePrivilege', 'replenish', 'reserve', 'purchase', 'chooseRoyal', 'discard']) {
      expect(kinds.has(kind), `no ${kind} was ever legal in this game; change the seed`).toBe(true);
    }
  });

  it('refuses to describe a pass, because BGA has no such move', () => {
    const snapshot = snap(opening, mover);
    const result = toView(snapshot, remember(emptyMemory(), snapshot));
    if (!result.ok) throw new Error(result.refusal.detail);
    expect(() => instruct({ t: 'pass' }, result.view, locate(snapshot))).toThrow(/pass/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/bga-splendor-duel/test/instruct.test.ts`
Expected: FAIL — cannot resolve `../src/instruct.js`.

- [ ] **Step 3: Implement `instruct.ts`**

`packages/bga-splendor-duel/src/instruct.ts`:

```ts
import {
  TOKEN_COLORS,
  cardLabel,
  describeAction,
  type SplendorAction,
  type SplendorView,
  type TokenColor,
} from '@games/splendor-duel';
import type { Located } from './locate.js';
import type { BgaToken } from './snapshot.js';

/**
 * One move, as something a person can carry out on the BGA page.
 *
 * `text` is the move in the game's own words, from the same `describeAction` the coach panel uses.
 * `steps` is what to click, in order, in BGA's terms: BGA makes two clicks out of several things
 * that are one action to us, and an instruction that stopped after the first would leave the table
 * in a state the adapter has to wait out. `highlight` is the DOM ids of the pieces involved, so the
 * page can outline them — "row 2, column 4" is findable, an outlined token is unmissable.
 *
 * Board positions are given as BGA draws them. BGA's board is ours turned half a turn (see
 * `ids.ts`), so our cell numbers would point at the wrong corner; the token's own `row` and
 * `column`, as BGA sent them, cannot.
 */
export interface Instruction {
  text: string;
  steps: string[];
  highlight: string[];
}

function tokenAt(at: Located, cell: number): BgaToken {
  const token = at.boardToken.get(cell);
  if (!token) throw new Error(`instruct: no token on cell ${cell}`);
  return token;
}

const where = (token: BgaToken): string => `row ${String(token.row)}, column ${String(token.column)}`;

function tally(counts: Partial<Record<TokenColor, number>>): string {
  const parts = TOKEN_COLORS.filter((color) => (counts[color] ?? 0) > 0).map((color) => `${counts[color]} ${color}`);
  return parts.join(', ');
}

/** The lowest-id tokens of each colour, which is as good a choice as any: tokens of a colour are alike. */
function pickHeld(pool: Record<TokenColor, number[]>, counts: Partial<Record<TokenColor, number>>): number[] {
  return TOKEN_COLORS.flatMap((color) => pool[color].slice(0, counts[color] ?? 0));
}

export function instruct(action: SplendorAction, view: SplendorView, at: Located): Instruction {
  const text = describeAction(action, view);

  switch (action.t) {
    case 'takeTokens': {
      const tokens = action.cells.map((cell) => tokenAt(at, cell));
      const steps = tokens.map((token, i) => `Select the ${String(view.board[action.cells[i] as number])} token at ${where(token)}.`);
      steps.push('Confirm the selection.');
      return { text, steps, highlight: tokens.map((token) => `token-${token.id}`) };
    }

    case 'usePrivilege': {
      const token = tokenAt(at, action.cell);
      return {
        text,
        steps: [
          'Click "Use up to … privilege(s) to take gem(s)".',
          `Select only the ${String(view.board[action.cell])} token at ${where(token)}, and confirm. One token: the next move is advised after it.`,
        ],
        highlight: [`token-${token.id}`],
      };
    }

    case 'replenish':
      return {
        text,
        steps: ['Click "Replenish the board", and accept the warning that your opponent gains a privilege.'],
        highlight: [],
      };

    case 'reserve': {
      const gold = tokenAt(at, action.goldCell);
      const takeGold = `Select the gold token at ${where(gold)}, and confirm.`;
      if (action.from.t === 'deck') {
        return {
          text,
          steps: [takeGold, `Click the level ${action.from.level} deck to reserve its top card.`],
          highlight: [`token-${gold.id}`, `card-deck-${action.from.level}`],
        };
      }
      const cardId = view.pyramid[action.from.level][action.from.slot] ?? null;
      const bga = cardId ? at.cardBgaId.get(cardId) : undefined;
      return {
        text,
        steps: [
          takeGold,
          `Reserve ${cardLabel(cardId)}: level ${action.from.level}, card ${action.from.slot + 1} counting from the left.`,
        ],
        highlight: [`token-${gold.id}`, ...(bga === undefined ? [] : [`card-${bga}`])],
      };
    }

    case 'purchase': {
      const cardId =
        action.from.t === 'pyramid' ? (view.pyramid[action.from.level][action.from.slot] ?? null) : action.from.cardId;
      const place =
        action.from.t === 'pyramid'
          ? `level ${action.from.level}, card ${action.from.slot + 1} counting from the left`
          : 'among your reserved cards';
      const bga = cardId ? at.cardBgaId.get(cardId) : undefined;
      const paying = tally(action.payment);
      const steps = [
        `Click ${cardLabel(cardId)} (${place}).`,
        paying ? `Pay with exactly: ${paying}.` : 'It is free: pay nothing.',
      ];
      if (action.wildColor) steps.push(`Place it on your ${action.wildColor} column.`);
      return { text, steps, highlight: bga === undefined ? [] : [`card-${bga}`] };
    }

    case 'chooseMatchingToken': {
      const token = tokenAt(at, action.cell);
      return {
        text,
        steps: [`Take the ${String(view.board[action.cell])} token at ${where(token)}.`],
        highlight: [`token-${token.id}`],
      };
    }

    case 'chooseSteal': {
      const [id] = at.theirTokens[action.color];
      return {
        text,
        steps: [`Take a ${action.color} token from your opponent.`],
        highlight: id === undefined ? [] : [`token-${id}`],
      };
    }

    case 'chooseRoyal': {
      const bga = at.royalBgaId.get(action.royalId);
      return {
        text,
        steps: [`Take the royal card: ${cardLabel(action.royalId)}.`],
        highlight: bga === undefined ? [] : [`royal-card-${bga}`],
      };
    }

    case 'discard':
      return {
        text,
        steps: [`Select these of your own tokens: ${tally(action.tokens)}.`, 'Click "Discard selected token(s)".'],
        highlight: pickHeld(at.myTokens, action.tokens).map((id) => `token-${id}`),
      };

    case 'pass':
      throw new Error('instruct: pass has no move on BGA; the loop stops before asking for one');
  }
}
```

Append to `packages/bga-splendor-duel/src/index.ts`:

```ts
export * from './instruct.js';
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/bga-splendor-duel/test/instruct.test.ts`
Expected: PASS, 5 tests.

If the last-but-one test reports a kind that was never legal, change its seed string; keep the list of kinds.

Run: `npm run typecheck && npm run lint && npx vitest run packages/bga-splendor-duel`
Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/bga-splendor-duel
git commit -m "Say a move the way someone at a BGA table would have to click it"
```

---

### Task 7: One operating point for the search, wherever it runs

The search's settings currently live in `apps/web/src/bot/engine.ts`, which a node tool cannot import. Copying them into `tools/bga` would create exactly the drift `packages/bot-splendor-duel/src/index.ts` warns about in its opening comment: an agent playing on BGA under slightly different settings than the one that was measured. Move them to the package both sides already share.

**Files:**
- Modify: `packages/bot-splendor-duel/src/index.ts` (add `operatingPoint`)
- Modify: `apps/web/src/bot/engine.ts` (use it; delete `config`)
- Create: `packages/bot-splendor-duel/test/operating-point.test.ts`

**Interfaces:**
- Produces: `operatingPoint(iterations: number, seed: string): SearchConfig`, exported from `@games/bot-splendor-duel`.

- [ ] **Step 1: Write the failing test**

`packages/bot-splendor-duel/test/operating-point.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { operatingPoint } from '../src/index.js';

describe('the operating point', () => {
  it('is the one every measurement of the network was taken at', () => {
    /*
     * Pinned on purpose. These are copied from `tools/selfplay/loop.yaml`, and the numbers attached
     * to the published network — the gate, the win rate against the heuristic search — were all
     * measured with exactly these. Changing one here changes which agent the browser and the BGA
     * adapter are playing, without changing its name.
     */
    expect(operatingPoint(1000, 'seed')).toMatchObject({
      iterations: 1000,
      seed: 'seed',
      leaf: 'evaluate',
      selection: 'puct',
      puctExploration: 4,
      puctDepth: 99,
      normaliseValues: true,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/bot-splendor-duel/test/operating-point.test.ts`
Expected: FAIL — `operatingPoint` is not exported.

- [ ] **Step 3: Move the settings**

In `packages/bot-splendor-duel/src/index.ts`, change the `@games/bot-ismcts` import to:

```ts
import { withConfig, type SearchConfig, type SearchDeps } from '@games/bot-ismcts';
```

and add, directly after the `OPTIONS` constant:

```ts
/**
 * The search's operating point, which is deliberately not a choice made by its callers.
 *
 * Every one of these is copied from `tools/selfplay/loop.yaml`, and the reason to copy rather than
 * to tune is that the numbers attached to the network -- 93% against the heuristic search, the
 * +182 elo for full-depth priors -- were all measured with exactly these settings. A caller that
 * quietly ran `puctDepth: 0` because it seemed cheaper would be playing a different and weaker
 * agent under the same name.
 *
 * It lives here for the reason `netDeps` does: it has more than one caller -- the browser, and the
 * BGA adapter in `tools/bga` -- and they must not drift.
 *
 * `iterations` is the one thing a caller varies, and it is the one thing the difficulty dial is.
 */
export function operatingPoint(iterations: number, seed: string): SearchConfig {
  return withConfig({
    iterations,
    seed,
    leaf: 'evaluate',
    selection: 'puct',
    puctExploration: 4,
    puctDepth: 99,
    normaliseValues: true,
  });
}
```

In `apps/web/src/bot/engine.ts`: change the first two imports to

```ts
import { search, type SearchResult } from '@games/bot-ismcts';
import { netDeps, operatingPoint, type SplendorSearchDeps } from '@games/bot-splendor-duel';
```

delete the whole `config` function together with its doc comment, and change the body of `think` to:

```ts
  return search(engine.deps, view, seat, operatingPoint(iterations, seed));
```

Run: `grep -rn "config(" apps/web/src/bot` — expected: no remaining call to the deleted `config`.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx vitest run packages/bot-splendor-duel apps/web/test`
Expected: PASS. The web bot's tests play real games through `think`, so they are what shows the move changed nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/bot-splendor-duel apps/web/src/bot/engine.ts
git commit -m "Keep the search's operating point where every caller can reach it"
```

---

### Task 8: The tool's quiet half — the engine, the results log, the rating

Nothing in this task opens a browser. It is the part of `tools/bga` that can be finished and tested on any machine.

**Files:**
- Create: `tools/bga/package.json`, `tools/bga/paths.mjs`, `tools/bga/engine.mjs`, `tools/bga/rating.mjs`, `tools/bga/results.mjs`
- Create: `tools/bga/test/engine.test.mjs`, `tools/bga/test/rating.test.mjs`, `tools/bga/test/results.test.mjs`
- Modify: `package.json` (add the `bga` script)

**Interfaces:**
- Consumes: `operatingPoint`, `netDeps` (`@games/bot-splendor-duel`, Task 7); `search` (`@games/bot-ismcts`); `loadNet` (`tools/selfplay/net.mjs`).
- Produces:
  - `paths.mjs`: `PUBLISHED`, `DATA`, `RESULTS`, `PROFILE` (absolute paths)
  - `engine.mjs`: `loadPublished(base) → { id, generation, deps }`; `makeBrain(engine, iterations, seed) → (view, seat, move) => { action, value }`
  - `rating.mjs`: `expected(rating, opponent) → number`; `fitRating(games: { opponent: number, score: 0 | 1 }[]) → { games, score, rating, low, high, bound }` where `bound` is `null`, `'at-least'` or `'at-most'`
  - `results.mjs`: `appendResult(file, row)`, `readResults(file) → row[]`, `resultOf(snapshot) → { result: 'win' | 'loss' | 'unknown', reason: 'prestige' | 'crowns' | 'colour' | 'other' }`, `report(rows) → string`
  - A result row: `{ table, at, mode, generation, iterations, seat, opponent, opponentRating, result, reason, moves, handedOver }`

- [ ] **Step 1: Create the workspace**

`tools/bga/package.json`:

```json
{
  "name": "@games/tool-bga",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node cli.mjs"
  },
  "dependencies": {
    "@games/bga-splendor-duel": "*",
    "@games/bot-ismcts": "*",
    "@games/bot-splendor-duel": "*",
    "@games/engine": "*",
    "@games/net": "*",
    "@games/splendor-duel": "*",
    "playwright": "^1.62.1"
  }
}
```

In the root `package.json` `scripts`, add after `"selfplay:generate"`:

```json
    "bga": "npm run -w @games/tool-bga start --"
```

(and a comma on the line above it). Run `npm install`; expected exit 0.

`tools/bga/paths.mjs`:

```js
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

/** The checkpoints the web app ships. The agent on BGA is the one a visitor to the site plays. */
export const PUBLISHED = resolve(ROOT, 'apps/web/public/bots/splendor-duel/current');

/** Results, captures, stop snapshots, per-table memory. Under `/data/`, which git ignores. */
export const DATA = resolve(ROOT, 'data/bga');
export const RESULTS = resolve(DATA, 'results.jsonl');

/** The browser profile holding the operator's BGA session. Under `.cache/`, which git ignores. */
export const PROFILE = resolve(HERE, '.cache/profile');
```

- [ ] **Step 2: Write the failing tests**

`tools/bga/test/engine.test.mjs`:

```js
import { legalActionsFromView, redactFor, setup } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { loadPublished, makeBrain } from '../engine.mjs';
import { PUBLISHED } from '../paths.mjs';

describe('the engine the adapter plays with', () => {
  it('is the published checkpoint, and picks a legal move from a real view', () => {
    const engine = loadPublished(PUBLISHED);
    expect(engine.generation).toBeGreaterThan(0);
    expect(engine.deps.priors).toBeDefined();

    const state = setup({ seed: 'bga-engine', seats: [0, 1], options: {} });
    const seat = state.turn;
    const view = JSON.parse(JSON.stringify(redactFor(seat, state)));
    const { action, value } = makeBrain(engine, 60, 'test')(view, seat, 0);

    const legal = legalActionsFromView(view, seat).actions.map((a) => JSON.stringify(a));
    expect(legal).toContain(JSON.stringify(action));
    expect(value).toBeGreaterThanOrEqual(-1);
    expect(value).toBeLessThanOrEqual(1);
  });
});
```

`tools/bga/test/rating.test.mjs`:

```js
import { describe, expect, it } from 'vitest';
import { expected, fitRating } from '../rating.mjs';

/** A small seeded generator, so the simulated games are the same games every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the rating estimate', () => {
  it('recovers a known rating from simulated games', () => {
    const random = mulberry32(20260930);
    const truth = 1650;
    const games = Array.from({ length: 3000 }, () => {
      const opponent = 1300 + Math.floor(random() * 600);
      return { opponent, score: random() < expected(truth, opponent) ? 1 : 0 };
    });
    const fit = fitRating(games);
    expect(fit.bound).toBeNull();
    // The standard error at 3000 games is about 7 points; 60 is far outside chance.
    expect(Math.abs(fit.rating - truth)).toBeLessThan(60);
    expect(fit.high - fit.low).toBeGreaterThan(15);
    expect(fit.high - fit.low).toBeLessThan(60);
  });

  it('puts an even record against one opponent at that opponent', () => {
    const fit = fitRating([{ opponent: 1500, score: 1 }, { opponent: 1500, score: 0 }]);
    expect(fit.rating).toBeCloseTo(1500, 3);
    // Two games say almost nothing, and the interval has to admit it.
    expect(fit.high - fit.low).toBeGreaterThan(400);
  });

  it('gives a bound, not a number, when every game went the same way', () => {
    const sweep = fitRating(Array.from({ length: 5 }, () => ({ opponent: 1500, score: 1 })));
    expect(sweep.rating).toBeNull();
    expect(sweep.bound).toBe('at-least');
    // The rating at which five straight wins is a 1-in-20 event: 0.05^(1/5) = 0.5493 expected score.
    expect(sweep.low).toBeCloseTo(1534.35, 0);
    const blank = fitRating(Array.from({ length: 5 }, () => ({ opponent: 1500, score: 0 })));
    expect(blank.bound).toBe('at-most');
    expect(blank.high).toBeCloseTo(1465.65, 0);
  });

  it('says nothing about no games', () => {
    expect(fitRating([])).toEqual({ games: 0, score: 0, rating: null, low: null, high: null, bound: null });
  });
});
```

`tools/bga/test/results.test.mjs`:

```js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendResult, readResults, report, resultOf } from '../results.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'games-bga-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const row = (over = {}) => ({
  table: '1',
  at: '2026-10-01T12:00:00.000Z',
  mode: 'advise',
  generation: 11,
  iterations: 1000,
  seat: 0,
  opponent: 42,
  opponentRating: 1500,
  result: 'win',
  reason: 'prestige',
  moves: 30,
  handedOver: false,
  ...over,
});

describe('the results log', () => {
  it('appends a line per game and reads them back, creating the directory on first use', () => {
    const file = join(dir, 'nested', 'results.jsonl');
    expect(readResults(file)).toEqual([]);
    appendResult(file, row());
    appendResult(file, row({ table: '2', result: 'loss' }));
    expect(readResults(file).map((r) => [r.table, r.result])).toEqual([['1', 'win'], ['2', 'loss']]);
  });

  it('reads who won from the final snapshot', () => {
    const player = (id, score, endReasons) => ({ id, score, endReasons });
    const final = (mine, theirs) => ({ me: 1, gamedatas: { players: { 1: mine, 2: theirs } } });
    expect(resultOf(final(player(1, 1, [2]), player(2, 0, [])))).toEqual({ result: 'win', reason: 'crowns' });
    expect(resultOf(final(player(1, 0, []), player(2, 1, [1, 3])))).toEqual({ result: 'loss', reason: 'prestige' });
    // An abandoned game, or one BGA ended some other way: no winner on the scoreboard.
    expect(resultOf(final(player(1, 0, []), player(2, 0, [])))).toEqual({ result: 'unknown', reason: 'other' });
  });
});

describe('the report', () => {
  it('counts clean games against rated opponents, and says what it left out', () => {
    const rows = [
      row({ opponentRating: 1500, result: 'win' }),
      row({ opponentRating: 1500, result: 'loss', mode: 'play' }),
      row({ opponentRating: 1700, result: 'win', handedOver: true }),
      row({ opponentRating: null, result: 'win' }),
      row({ result: 'unknown' }),
    ];
    const text = report(rows);
    expect(text).toMatch(/2 games counted/);
    expect(text).toMatch(/rating\s+1500/);
    expect(text).toMatch(/1 win, 1 loss/);
    expect(text).toMatch(/1 finished by hand/);
    expect(text).toMatch(/1 with no opponent rating/);
    expect(text).toMatch(/1 with no recorded result/);
    expect(text).toMatch(/advise: 1, play: 1/);
    // The two caveats are part of the output, every time.
    expect(text).toMatch(/friendly/i);
    expect(text).toMatch(/interval/i);
  });

  it('reports a bound when the record is one-sided, and nothing when there are no games', () => {
    expect(report([row(), row(), row()])).toMatch(/at least \d+/);
    expect(report([])).toMatch(/No games counted/);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run tools/bga`
Expected: FAIL — cannot resolve `../engine.mjs`, `../rating.mjs`, `../results.mjs`.

- [ ] **Step 4: Implement `engine.mjs`**

```js
/**
 * The published network and the search around it, for a caller that has a view and wants a move.
 *
 * Deliberately thin. The checkpoint is the one `apps/web/public` ships, read with the loader
 * self-play already has; the search settings are `operatingPoint`, shared with the browser. So the
 * agent sitting at a BGA table is the agent that was measured, and nothing here can make it a
 * different one by accident.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { search } from '@games/bot-ismcts';
import { netDeps, operatingPoint } from '@games/bot-splendor-duel';
import { loadNet } from '../selfplay/net.mjs';

export function loadPublished(base) {
  const manifest = JSON.parse(readFileSync(join(base, 'bot.json'), 'utf8'));
  const value = loadNet(join(base, manifest.value.dir));
  const policy = loadNet(join(base, manifest.policy.dir));
  return { id: manifest.id, generation: manifest.generation, deps: netDeps(value, policy) };
}

/**
 * One search per decision, and the search's favourite every time.
 *
 * The web client samples its first few moves from the visit counts so that a person does not watch
 * it open identically every game. This does not: the point here is to measure the agent, the deal
 * already makes every game different, and a sampled opening is a small handicap that would end up
 * in the number.
 *
 * The view is cloned because the search hands it to `determinize` once per iteration, and sharing
 * one object across a tree walk is the kind of aliasing that produces a bug nobody can reproduce.
 */
export function makeBrain(engine, iterations, seed) {
  return (view, seat, move) => {
    const result = search(engine.deps, structuredClone(view), seat, operatingPoint(iterations, `${seed}:${move}`));
    return { action: result.action, value: result.rootValue };
  };
}
```

- [ ] **Step 5: Implement `rating.mjs`**

```js
/**
 * One rating, fitted to results against opponents whose ratings are known.
 *
 * The model is the Elo curve and nothing else: the chance of beating an opponent rated R_i from a
 * rating R is 1 / (1 + 10^((R_i - R) / 400)). The estimate is the R that makes the expected score
 * equal the actual one, which is the maximum-likelihood R. It is in whatever units the opponents'
 * ratings are in -- BGA displays ratings shifted by a constant, and a constant shift of every
 * input shifts the answer by the same amount.
 *
 * The interval comes from the curvature of the likelihood at the estimate (Fisher information).
 * It is honest about the number of games and silent about everything else: it knows nothing about
 * whether the opponents were trying.
 */

const K = Math.LN10 / 400;

export function expected(rating, opponent) {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/** The root of an increasing function, by bisection. A hundred halvings is far past float precision. */
function root(f, lo, hi) {
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function fitRating(games) {
  const n = games.length;
  if (n === 0) return { games: 0, score: 0, rating: null, low: null, high: null, bound: null };

  const score = games.reduce((total, game) => total + game.score, 0);
  const lo = Math.min(...games.map((g) => g.opponent)) - 2000;
  const hi = Math.max(...games.map((g) => g.opponent)) + 2000;

  if (score === n || score === 0) {
    /*
     * Every game went the same way, so the likelihood has no peak -- it only keeps rising (or
     * falling) with R. What the data does support is a one-sided statement: the rating below which
     * a clean sweep like this would have been a 1-in-20 event.
     */
    const won = score === n;
    const logLikelihood = (r) =>
      games.reduce((total, g) => total + Math.log(won ? expected(r, g.opponent) : 1 - expected(r, g.opponent)), 0);
    const edge = root((r) => (won ? logLikelihood(r) - Math.log(0.05) : Math.log(0.05) - logLikelihood(r)), lo, hi);
    return {
      games: n,
      score,
      rating: null,
      low: won ? edge : null,
      high: won ? null : edge,
      bound: won ? 'at-least' : 'at-most',
    };
  }

  const rating = root((r) => games.reduce((total, g) => total + expected(r, g.opponent), 0) - score, lo, hi);
  const information =
    K * K *
    games.reduce((total, g) => {
      const e = expected(rating, g.opponent);
      return total + e * (1 - e);
    }, 0);
  const half = 1.96 / Math.sqrt(information);
  return { games: n, score, rating, low: rating - half, high: rating + half, bound: null };
}
```

- [ ] **Step 6: Implement `results.mjs`**

```js
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
```

- [ ] **Step 7: Run the tests**

Run: `npm run typecheck && npx vitest run tools/bga`
Expected: PASS — 1 + 4 + 4 tests. (`typecheck` first: `tools/` imports the packages through the vitest aliases here, but `engine.mjs` is also what `node` runs, and that needs the built `dist/`.)

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add tools/bga package.json package-lock.json
git commit -m "Keep a record of each game, and say what rating it supports"
```

---

### Task 9: The browser — sign in, look, and refuse

The first code that touches boardgamearena.com. It reads, and it refuses; it does not advise or play.

**Files:**
- Create: `tools/bga/mode.mjs`, `tools/bga/browser.mjs`, `tools/bga/reader.mjs`, `tools/bga/cli.mjs`
- Create: `tools/bga/test/mode.test.mjs`

**Interfaces:**
- Consumes: `parseSnapshot` (`@games/bga-splendor-duel`); `paths.mjs`, `results.mjs` (Task 8).
- Produces:
  - `mode.mjs`: `MODE_CHECK_VERIFIED` (`false`); `tableMode(info) → 'friendly' | 'rated' | 'unknown'`; `guard({ info, tableId, snapshot, verified? }) → { ok: true } | { ok: false, why: string }`
  - `browser.mjs`: `openBrowser(profileDir) → Promise<BrowserContext>`
  - `reader.mjs`: `tableIdOf(url) → string`; `makeTable(page, tableId) → { snapshot(), pulse(), show(ids), facts(playerIds), primitives() }` — `snapshot()` reloads the page and resolves to the raw object `parseSnapshot` takes; `pulse()` resolves to `{ name: string, active: number, args: string }`; `facts()` resolves to `{ info, ratings }`
  - `cli.mjs` commands: `login`, `capture --table <url>`, `report`

**Two things in this task are written from memory of how BGA's site works, not from its published source, and may be wrong:** how to ask for a table's settings (`tableinfos`, and that option `201` is the game mode with `1` meaning friendly), and where a player's rating is shown (`#player_elo_<id>`). That is why `MODE_CHECK_VERIFIED` starts `false` and why `capture` saves everything it sees. Task 11 settles both against live tables.

- [ ] **Step 1: Write the failing test**

`tools/bga/test/mode.test.mjs`:

```js
import { describe, expect, it } from 'vitest';
import { guard, tableMode } from '../mode.mjs';

/**
 * The gate both modes pass through. It is the one piece of this tool whose failure mode is not
 * "the bot plays badly" but "the bot plays somewhere it must not", so every way it can be unsure
 * has to come out as a refusal.
 */

const info = (mode, id = '123') => ({ id, options: { 100: { value: '0' }, 201: { value: mode } } });
const snapshot = (over = {}) => ({
  me: 1,
  gamedatas: { expansion: false, players: { 1: { id: 1 }, 2: { id: 2 } }, ...over },
});

describe('tableMode', () => {
  it('reads the game-mode option', () => {
    expect(tableMode(info('1'))).toBe('friendly');
    expect(tableMode(info(1))).toBe('friendly');
    expect(tableMode(info('0'))).toBe('rated');
    expect(tableMode(info('2'))).toBe('rated');
  });

  it('accepts the same answer wrapped in a `data` envelope', () => {
    expect(tableMode({ status: 1, data: info('1') })).toBe('friendly');
  });

  it('is unknown for anything it does not recognise', () => {
    expect(tableMode(null)).toBe('unknown');
    expect(tableMode({})).toBe('unknown');
    expect(tableMode({ options: {} })).toBe('unknown');
    expect(tableMode(info('7'))).toBe('unknown');
    expect(tableMode(info(undefined))).toBe('unknown');
  });
});

describe('guard', () => {
  const pass = { info: info('1'), tableId: '123', snapshot: snapshot(), verified: true };

  it('lets a friendly, base-game table we are seated at through', () => {
    expect(guard(pass)).toEqual({ ok: true });
  });

  it('refuses everything until the mode check has been verified against live tables', () => {
    const verdict = guard({ ...pass, verified: undefined });
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/not been confirmed/);
  });

  it('refuses a rated table', () => {
    for (const mode of ['0', '2']) {
      const verdict = guard({ ...pass, info: info(mode) });
      expect(verdict.ok).toBe(false);
      expect(verdict.why).toMatch(/friendly/);
    }
  });

  it('refuses when it cannot tell', () => {
    expect(guard({ ...pass, info: null }).ok).toBe(false);
    expect(guard({ ...pass, info: {} }).ok).toBe(false);
    // Settings for some other table are not settings for this one.
    expect(guard({ ...pass, info: info('1', '999') }).ok).toBe(false);
  });

  it('refuses the expansion, and a table we are only watching', () => {
    expect(guard({ ...pass, snapshot: snapshot({ expansion: true }) }).why).toMatch(/expansion/i);
    expect(guard({ ...pass, snapshot: { ...snapshot(), me: 9 } }).why).toMatch(/not seated/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tools/bga/test/mode.test.mjs`
Expected: FAIL — cannot resolve `../mode.mjs`.

- [ ] **Step 3: Implement `mode.mjs`**

```js
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
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tools/bga/test/mode.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Implement `browser.mjs` and `reader.mjs`**

`tools/bga/browser.mjs`:

```js
import { chromium } from 'playwright';

/**
 * A real, visible browser with a profile that persists.
 *
 * Visible, because in `advise` mode the operator plays in this window, and in `play` mode it is
 * what they take over when the adapter stops. Persistent, so the operator signs in to BGA once, by
 * hand, and this program never sees a password: the session lives in the profile directory like
 * any browser's would.
 */
export async function openBrowser(profileDir) {
  return chromium.launchPersistentContext(profileDir, { headless: false, viewport: null });
}
```

`tools/bga/reader.mjs`:

```js
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

async function ready(page) {
  try {
    await page.waitForFunction(
      () => typeof gameui !== 'undefined' && gameui !== null && Boolean(gameui.gamedatas?.gamestate) && Boolean(document.getElementById('board')),
      null,
      { timeout: 60_000 },
    );
  } catch {
    throw new Error('This page did not become a Splendor Duel game within a minute. Is the URL a game in progress, and is the browser signed in (`npm run bga -- login`)?');
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

export function makeTable(page, tableId) {
  return {
    /** A full, current snapshot. Reloads the page. */
    async snapshot() {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready(page);
      return readRaw(page, tableId);
    },

    /** The state's name, whose turn it is, and its arguments. Cheap; does not reload. */
    async pulse() {
      try {
        return await readPulse(page);
      } catch {
        // The page was mid-navigation. Wait for it to be a game again and ask once more.
        await ready(page);
        return readPulse(page);
      }
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
     * What decides whether we may sit here, and what the opponent is rated.
     *
     * UNVERIFIED until Task 11: that `tableinfos` is how a table's settings are fetched, and that
     * `#player_elo_<id>` is where a rating is shown. Both come back `null` when the page does not
     * answer as expected, and `null` is a refusal (mode) or a game left out of the report (rating).
     */
    async facts(playerIds) {
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
```

- [ ] **Step 6: Implement `cli.mjs` with `login`, `capture`, `report`**

```js
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
```

- [ ] **Step 7: Check what can be checked without a display**

Run: `npm run lint && npx vitest run tools/bga`
Expected: exit 0; all `tools/bga` tests pass.

Run: `npm run bga -- report`
Expected: prints `No games counted yet.` and the three "Not counted" lines, exit 0.

Run: `npm run bga -- capture`
Expected: prints `Missing --table.`, exit 1.

Run: `npm run bga -- capture --table https://boardgamearena.com/gamepanel`
Expected: prints `No table id in "…"`, exit 1 — before any browser opens.

`login` and a real `capture` need a display and are exercised in Task 11. On this headless host, do not try them: `launchPersistentContext({ headless: false })` fails with a missing-display error, and that is expected.

- [ ] **Step 8: Commit**

```bash
git add tools/bga
git commit -m "Look at a BGA table, and refuse it unless it is provably friendly"
```

---

### Task 10: The loop, and `advise`

**Files:**
- Create: `tools/bga/loop.mjs`, `tools/bga/advise.mjs`, `tools/bga/test/loop.test.mjs`
- Create: `packages/bga-splendor-duel/test/support/fakeTable.ts`
- Modify: `tools/bga/cli.mjs` (add `advise`)

**Interfaces:**
- Consumes: `parseSnapshot`, `remember`, `toView`, `crossCheck`, `locate`, `instruct`, `stateKind`, `emptyMemory` (`@games/bga-splendor-duel`); `makeBrain` (Task 8); `makeTable` (Task 9); `guard` (Task 9).
- Produces:
  - `loop.mjs`:
    - `fingerprint(pulse) → string`
    - `runTable({ table, brain, act, say, sleep, memory, onMemory?, pollMs?, patienceMs? })` → `{ outcome: 'finished', moves, snapshot, raw }` or `{ outcome: 'stopped', refusal, moves, raw }`
    - `table` needs `snapshot()` and `pulse()`; `brain` is `(view, seat, move) => { action, value }`; `act` is `async ({ action, value, view, seat, at, before, waitWhile }) => { ok: true } | { ok: false, refusal }` where `before` is the pulse at the moment of decision and `waitWhile(holds, timeoutMs?)` polls until `holds(pulse)` is false, resolving `false` on timeout.
  - `advise.mjs`: `makeAdvise({ present })` → an `act`; `present` is `async ({ instruction, action, value }) => void`
  - `test/support/fakeTable.ts`: `class FakeTable { constructor(seed: string, viewer: 0 | 1); state: SplendorState; pulse(); snapshot(); play(action); force(seat, action) }`

- [ ] **Step 1: Write the test double — a BGA table made of our engine**

`packages/bga-splendor-duel/test/support/fakeTable.ts`:

```ts
import { RandomCursor } from '@games/engine';
import { apply, legalActions, setup, type SplendorAction, type SplendorState } from '@games/splendor-duel';
import { pick } from './play.js';
import { PLAYER_ID, stateOf, synthSnapshot } from './synth.js';

/**
 * A BGA table, as far as the adapter's loop can tell: something that can be pulsed and snapshotted,
 * with an opponent who moves in their own time.
 *
 * Underneath it is our own engine, dressed by `synthSnapshot`. That makes it a test of the loop --
 * turn detection, waiting, stopping, the order things are asked in -- and not a test of whether BGA
 * behaves this way. Only a live table tests that.
 *
 * The opponent moves on every third pulse rather than instantly, so the loop actually sees the
 * table sitting on the other player's turn, which is most of what a real table does.
 */
export class FakeTable {
  state: SplendorState;
  pulses = 0;
  private ticks = 0;
  private readonly rng: RandomCursor;

  constructor(
    seed: string,
    readonly viewer: 0 | 1,
  ) {
    this.state = setup({ seed, seats: [0, 1], options: {} });
    this.rng = new RandomCursor(`${seed}:opponent`, 0);
  }

  protected current(): { name: string; args: unknown } {
    return stateOf(this.state);
  }

  async pulse(): Promise<{ name: string; active: number; args: string }> {
    this.pulses += 1;
    if (this.pulses > 20_000) throw new Error('FakeTable: 20,000 pulses and the game has not ended');
    const theirs = this.state.stage !== 'over' && this.state.turn !== this.viewer;
    if (theirs && ++this.ticks % 3 === 0) {
      const seat = this.state.turn as 0 | 1;
      this.force(seat, pick(legalActions(this.state, seat).actions, this.rng));
    }
    const { name, args } = this.current();
    return { name, active: PLAYER_ID[this.state.turn as 0 | 1], args: JSON.stringify(args ?? null) };
  }

  async snapshot(): Promise<unknown> {
    return JSON.parse(JSON.stringify(synthSnapshot(this.state, this.viewer)));
  }

  /** The operator, doing as advised. */
  play(action: SplendorAction): void {
    this.force(this.viewer, action);
  }

  force(seat: 0 | 1, action: SplendorAction): void {
    const result = apply(this.state, seat, action);
    if (!result.ok) throw new Error(result.error.message);
    this.state = result.state;
  }
}
```

- [ ] **Step 2: Write the failing test**

`tools/bga/test/loop.test.mjs`:

```js
import { emptyMemory } from '@games/bga-splendor-duel';
import { RandomCursor } from '@games/engine';
import { legalActionsFromView, redactFor } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { FakeTable } from '../../../packages/bga-splendor-duel/test/support/fakeTable.ts';
import { pick } from '../../../packages/bga-splendor-duel/test/support/play.ts';
import { makeAdvise } from '../advise.mjs';
import { runTable } from '../loop.mjs';
import { resultOf } from '../results.mjs';

/**
 * The loop, against a table made of our own engine.
 *
 * What is under test is everything either side of the search: noticing that it is our turn,
 * surviving a turn made of several decisions, waiting out the opponent, taking a fresh snapshot
 * each time, stopping cleanly, and knowing when the game is over. The brain here is random, on
 * purpose -- it is fast, and it reaches odd positions a good player would not.
 */

const randomBrain = (seed) => {
  const rng = new RandomCursor(`${seed}:brain`, 0);
  return (view, seat) => ({ action: pick(legalActionsFromView(view, seat).actions, rng), value: 0 });
};

const quiet = { say: () => {}, sleep: async () => {} };

/** A game either finishes, or reaches the one position our rules and BGA's handle differently. */
function endedProperly(result) {
  if (result.outcome === 'finished') return true;
  return result.refusal.reason === 'disagreement' && /stuck/.test(result.refusal.detail);
}

describe('runTable, advising', () => {
  it('advises every one of our decisions through a whole game, from either seat', async () => {
    for (const [seed, viewer] of [['loop-a', 0], ['loop-b', 1]]) {
      const table = new FakeTable(seed, viewer);
      const advised = [];
      const act = makeAdvise({
        present: async ({ instruction, action }) => {
          advised.push(instruction.text);
          table.play(action);
        },
      });
      const result = await runTable({ table, brain: randomBrain(seed), act, memory: emptyMemory(), ...quiet });

      expect(endedProperly(result), JSON.stringify(result.refusal)).toBe(true);
      expect(result.moves).toBeGreaterThan(10);
      expect(advised).toHaveLength(result.moves);
      if (result.outcome === 'finished') {
        expect(table.state.stage).toBe('over');
        expect(resultOf(result.snapshot).result).toBe(table.state.winner === viewer ? 'win' : 'loss');
      }
    }
  });

  it('does not mind the operator playing something other than the advice', async () => {
    const table = new FakeTable('loop-contrary', 0);
    const contrary = new RandomCursor('contrary', 0);
    const act = makeAdvise({
      present: async () => {
        // Ignore the advice entirely and play any legal move.
        const view = JSON.parse(JSON.stringify(redactFor(table.viewer, table.state)));
        table.play(pick(legalActionsFromView(view, table.viewer).actions, contrary));
      },
    });
    const result = await runTable({ table, brain: randomBrain('loop-contrary'), act, memory: emptyMemory(), ...quiet });
    expect(endedProperly(result), JSON.stringify(result.refusal)).toBe(true);
  });

  it('hands memory out after every snapshot, so a restart can pick the seen cards back up', async () => {
    const table = new FakeTable('loop-memory', 0);
    const saved = [];
    const act = makeAdvise({ present: async ({ action }) => table.play(action) });
    await runTable({ table, brain: randomBrain('loop-memory'), act, memory: emptyMemory(), onMemory: (m) => saved.push(m), ...quiet });
    expect(saved.length).toBeGreaterThan(10);
    expect(Object.keys(saved.at(-1).seen).length).toBeGreaterThan(12);
  });
});

describe('runTable, stopping', () => {
  it('stops on a snapshot it cannot read, and keeps that snapshot', async () => {
    const table = new FakeTable('loop-garbled', 0);
    table.snapshot = async () => ({ not: 'a game' });
    const result = await runTable({ table, brain: randomBrain('x'), act: async () => ({ ok: true }), memory: emptyMemory(), ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('bad-snapshot');
    expect(result.raw).toEqual({ not: 'a game' });
    expect(result.moves).toBe(0);
  });

  it('stops when the table sits in a state it has no translation for', async () => {
    const table = new FakeTable('loop-unknown', 0);
    // Our turn (viewer 0 is player 1000 in the fake), in a state from the expansion.
    table.pulse = async () => ({ name: 'beforeEndTurn', active: 1000, args: 'null' });
    const result = await runTable({ table, brain: randomBrain('x'), act: async () => ({ ok: true }), memory: emptyMemory(), patienceMs: 2000, pollMs: 500, ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('unknown-state');
    expect(result.refusal.detail).toContain('beforeEndTurn');
  });

  it('stops when the strategy says it could not act, with the strategy’s reason', async () => {
    const table = new FakeTable('loop-refused', 0);
    const refusal = { reason: 'refused', detail: 'BGA said no.' };
    // Our seat may not be first to move; the opponent plays until it is, then the strategy refuses.
    const result = await runTable({ table, brain: randomBrain('loop-refused'), act: async () => ({ ok: false, refusal }), memory: emptyMemory(), ...quiet });
    expect(result).toMatchObject({ outcome: 'stopped', refusal, moves: 1 });
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tools/bga/test/loop.test.mjs`
Expected: FAIL — cannot resolve `../advise.mjs` / `../loop.mjs`.

- [ ] **Step 4: Implement `loop.mjs`**

```js
/**
 * One table, from the first snapshot to the end of the game or to a stop.
 *
 *   settle   wait until the page rests on our decision, on the opponent's turn, or at the end
 *   look     take a fresh, full snapshot and fold it into memory
 *   decide   translate it, check our rules against BGA's, search
 *   act      hand the move to a strategy -- tell the operator, or perform it
 *
 * The strategy is the only difference between `advise` and `play`, and it is passed in. Everything
 * that touches a page is passed in as `table`, which is why this can be run against a table made of
 * our own engine in a test.
 *
 * Two rules shape it. Every decision starts from a fresh snapshot, never from what we expect the
 * last move to have done -- so it does not matter whether the last move was ours, the operator's,
 * or not the one advised. And every way of being unsure is a stop, returned to the caller with the
 * snapshot that caused it: the loop never retries a guess.
 */

import { crossCheck, locate, parseSnapshot, remember, stateKind, toView } from '@games/bga-splendor-duel';

/** Everything the page says about where the game is, without a reload. Changes when anything is done. */
export const fingerprint = (pulse) => `${pulse.name}|${pulse.active}|${pulse.args}`;

export async function runTable({ table, brain, act, say, sleep, memory, onMemory = () => {}, pollMs = 500, patienceMs = 30_000 }) {
  let moves = 0;
  let raw = null;
  const stopped = (refusal) => ({ outcome: 'stopped', refusal, moves, raw });
  const look = async () => {
    raw = await table.snapshot();
    return parseSnapshot(raw);
  };

  let parsed = await look();
  if (!parsed.ok) return stopped(parsed.refusal);
  const me = parsed.snapshot.me;
  if (!Object.values(parsed.snapshot.gamedatas.players).some((p) => p.id === me)) {
    return stopped({ reason: 'spectator', detail: 'The logged-in account is not seated at this table.' });
  }

  /** What a pulse means for us: `ours` to decide, `theirs`, `wait` (mid-action), `over`, or `unknown`. */
  const where = (pulse) => {
    const kind = stateKind(pulse.name);
    if (kind === 'over') return 'over';
    if (pulse.active !== me) return 'theirs';
    if (kind === 'decision') return 'ours';
    return kind === 'mid-action' ? 'wait' : 'unknown';
  };

  /** Poll until `holds(pulse)` stops being true. Resolves false if `timeoutMs` passes first. */
  const waitWhile = async (holds, timeoutMs = Infinity) => {
    for (let waited = 0; ; waited += pollMs) {
      if (!holds(await table.pulse())) return true;
      if (waited >= timeoutMs) return false;
      await sleep(pollMs);
    }
  };

  /**
   * Wait for the page to rest somewhere we can act on, and to have rested there for two polls
   * running -- BGA passes through transient states between turns, and a reload in the middle of one
   * is a snapshot of nothing. A state we have no name for is given `patienceMs` to pass.
   */
  const settle = async () => {
    let last = null;
    let lost = 0;
    for (;;) {
      const pulse = await table.pulse();
      const at = where(pulse);
      lost = at === 'unknown' ? lost + pollMs : 0;
      if (lost >= patienceMs) return { at, pulse };
      const print = fingerprint(pulse);
      if ((at === 'ours' || at === 'theirs' || at === 'over') && print === last) return { at, pulse };
      last = print;
      await sleep(pollMs);
    }
  };

  for (;;) {
    const { at, pulse } = await settle();
    if (at === 'unknown') {
      return stopped({
        reason: 'unknown-state',
        detail: `The table has sat in BGA state "${pulse.name}" for ${Math.round(patienceMs / 1000)}s, and there is no translation for it.`,
      });
    }

    parsed = await look();
    if (!parsed.ok) return stopped(parsed.refusal);
    const snapshot = parsed.snapshot;
    if (stateKind(snapshot.gamestate.name) === 'over') return { outcome: 'finished', moves, snapshot, raw };

    // Every snapshot is remembered, including the one taken on the opponent's turn: that one is
    // what tells memory how our next turn began.
    memory = remember(memory, snapshot);
    onMemory(memory);

    // The pulse the decision is made at. Taken before the search, so that anything done to the
    // table while we think shows up as a change afterwards.
    const before = await table.pulse();
    const ours =
      snapshot.gamestate.active_player === me &&
      stateKind(snapshot.gamestate.name) === 'decision' &&
      before.name === snapshot.gamestate.name &&
      before.active === me;
    if (!ours) {
      await waitWhile((p) => where(p) === 'theirs');
      continue;
    }

    const translated = toView(snapshot, memory);
    if (!translated.ok) return stopped(translated.refusal);
    const problems = crossCheck(translated.view, translated.seat, snapshot);
    if (problems.length > 0) return stopped({ reason: 'disagreement', detail: problems.join(' ') });
    for (const warning of translated.warnings) say(`  note: ${warning}`);

    const { action, value } = brain(translated.view, translated.seat, moves);
    moves += 1;
    const outcome = await act({ action, value, view: translated.view, seat: translated.seat, at: locate(snapshot), before, waitWhile });
    if (!outcome.ok) return stopped(outcome.refusal);
  }
}
```

- [ ] **Step 5: Implement `advise.mjs`**

```js
/**
 * `advise`: the bot decides, a person moves.
 *
 * Nothing is ever submitted from here. The move is put in front of the operator, and then this
 * waits for the table to change -- by any means. If the operator plays something else, the next
 * snapshot is of the position that produced, and the next advice is about that.
 */

import { instruct } from '@games/bga-splendor-duel';
import { fingerprint } from './loop.mjs';

export function makeAdvise({ present }) {
  return async ({ action, value, view, at, before, waitWhile }) => {
    await present({ instruction: instruct(action, view, at), action, value });
    const was = fingerprint(before);
    await waitWhile((pulse) => fingerprint(pulse) === was);
    return { ok: true };
  };
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tools/bga/test/loop.test.mjs`
Expected: PASS, 6 tests.

If a whole-game test fails with `FakeTable: 20,000 pulses and the game has not ended`, that seed's random game stalls; change the seed. If one fails with a `disagreement` that is *not* "stuck", that is a real finding — a position where the translated view and the synthetic BGA arguments disagree — and the fix belongs in whichever of `toView`, `crossCheck` or `synth.ts` is wrong, not in this test.

- [ ] **Step 7: Add `advise` to the CLI**

In `tools/bga/cli.mjs`, replace the header comment's command list with:

```js
 *   npm run bga -- login                                    sign in to BGA, once, by hand
 *   npm run bga -- capture --table <url>                    save what the adapter sees; changes nothing
 *   npm run bga -- advise  --table <url> [--iterations N]   tell the operator what to play
 *   npm run bga -- report                                   the rating the results so far support
```

Replace the import block with:

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { emptyMemory, parseSnapshot, stateKind } from '@games/bga-splendor-duel';
import { makeAdvise } from './advise.mjs';
import { openBrowser } from './browser.mjs';
import { loadPublished, makeBrain } from './engine.mjs';
import { runTable } from './loop.mjs';
import { guard, tableMode } from './mode.mjs';
import { DATA, PROFILE, PUBLISHED, RESULTS } from './paths.mjs';
import { makeTable, tableIdOf } from './reader.mjs';
import { appendResult, readResults, report, resultOf } from './results.mjs';
```

Add these above `main`:

```js
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
async function sit(mode, flags, strategy) {
  const url = need(flags, 'table');
  const iterations = iterationsOf(flags);
  const engine = loadPublished(PUBLISHED);
  const { context, tableId, table } = await open(url);

  const first = parseSnapshot(await table.snapshot());
  if (!first.ok) {
    await context.close();
    throw new Error(first.refusal.detail);
  }
  const players = Object.values(first.snapshot.gamedatas.players);
  const facts = await table.facts(players.map((p) => p.id));
  const verdict = guard({ info: facts.info, tableId, snapshot: first.snapshot });
  if (!verdict.ok) {
    await context.close();
    console.error(`Refusing this table. ${verdict.why}`);
    process.exitCode = 2;
    return;
  }
  const mine = players.find((p) => p.id === first.snapshot.me);
  const theirs = players.find((p) => p.id !== first.snapshot.me);

  console.log(`\nTable ${tableId}: friendly mode. Playing generation ${engine.generation} at ${iterations} iterations, mode "${mode}".`);
  console.log('\nBefore the first move, post this in the table chat:\n');
  console.log(`  ${NOTICE}\n`);
  await confirmPosted();

  // Only the cards seen survive a restart. The rest of memory is about the turn in progress, and a
  // turn the adapter did not watch begin is one it should not pretend to remember.
  const memoryFile = join(DATA, `${tableId}.memory.json`);
  const seen = existsSync(memoryFile) ? JSON.parse(readFileSync(memoryFile, 'utf8')).seen : {};
  mkdirSync(DATA, { recursive: true });

  const result = await runTable({
    table,
    brain: makeBrain(engine, iterations, tableId),
    act: strategy(table),
    say: (line) => console.log(line),
    sleep,
    memory: { ...emptyMemory(), seen },
    onMemory: (memory) => writeFileSync(memoryFile, JSON.stringify({ seen: memory.seen })),
  });

  let final = result.outcome === 'finished' ? result.snapshot : null;
  if (result.outcome === 'stopped') {
    process.stdout.write('\x07');
    const file = save('stops', `${tableId}-${stamp()}.json`, { refusal: result.refusal, raw: result.raw });
    console.log(`\nSTOPPED (${result.refusal.reason}). ${result.refusal.detail}`);
    console.log(`The snapshot is in ${file}.`);
    console.log('Finish the game by hand in the browser. This program does nothing more at this table,');
    console.log('and records the result once the game is over.');
    for (;;) {
      const pulse = await table.pulse().catch(() => null);
      if (pulse && stateKind(pulse.name) === 'over') break;
      await sleep(2000);
    }
    const last = parseSnapshot(await table.snapshot());
    final = last.ok ? last.snapshot : null;
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
  await context.close();
}

const advise = (flags) =>
  sit('advise', flags, (table) =>
    makeAdvise({
      present: async ({ instruction, value }) => {
        console.log(`\n▶ ${instruction.text}    (search value ${signed(value)})`);
        instruction.steps.forEach((step, i) => console.log(`   ${i + 1}. ${step}`));
        await table.show(instruction.highlight);
      },
    }),
  );
```

In `main`'s `switch`, add before `case 'report'`:

```js
    case 'advise':
      return advise(flags);
```

and change the usage line to:

```js
      console.log('Usage: npm run bga -- <login | capture --table <url> | advise --table <url> [--iterations N] | report>');
```

- [ ] **Step 8: Check the gates**

Run: `npm run typecheck && npm run lint && npx vitest run tools/bga packages/bga-splendor-duel`
Expected: exit 0, all pass.

Run: `npm run bga -- advise`
Expected: `Missing --table.`, exit 1.

- [ ] **Step 9: Commit**

```bash
git add tools/bga packages/bga-splendor-duel/test/support/fakeTable.ts
git commit -m "Tell the operator what the network would play, one decision at a time"
```

---

### Task 11: Calibration against live tables (operator, with a display)

This task has no code to write in advance. It is where the three things the spec lists as unverifiable are verified, and the two guesses in Task 9 are confirmed or corrected. It needs the operator, their BGA login, and a machine with a display. **Do not skip it and do not flip `MODE_CHECK_VERIFIED` without doing it.**

**Files (only as the findings require):**
- Modify: `tools/bga/mode.mjs`, `tools/bga/reader.mjs` (`facts`), `tools/bga/test/mode.test.mjs`
- Modify: `packages/bga-splendor-duel/src/snapshot.ts` and its test, if a live snapshot is refused
- Create: `packages/bga-splendor-duel/test/fixtures/live/*.json`, `packages/bga-splendor-duel/test/live.test.ts`

- [ ] **Step 1: Sign in**

```bash
npx playwright install chromium
npm run typecheck
npm run bga -- login
```

Sign in to BGA in the window, then close it.

- [ ] **Step 2: Capture a friendly table and a rated one**

Create a Splendor Duel table by hand: **friendly mode**, Counterfeiters expansion **off**, and in the table description say that your seat is played by a bot. Once the game has started:

```bash
npm run bga -- capture --table '<the game URL>'
```

Then open any **rated** Splendor Duel game in progress as a spectator (from the game's page on BGA, "games in progress") and capture that too. `capture` only reads.

- [ ] **Step 3: Check the snapshot shape**

For the friendly capture, the output must say `snapshot: matches the schema`.

If it says `REFUSED`, the message names the path that differs. Open the saved file, compare `raw` at that path with `zBgaSnapshot` in `packages/bga-splendor-duel/src/snapshot.ts` and with `getAllDatas` in thoun/splendorduel, and correct the schema — and `playerJson`/`synthSnapshot` in `test/support/synth.ts` to match, so the synthetic snapshots keep looking like real ones. Re-run `npx vitest run packages/bga-splendor-duel`.

- [ ] **Step 4: Check the game mode**

The two captures must print `game mode as read: friendly` and `game mode as read: rated` respectively.

If either prints `unknown` or the wrong answer, open both saved files and find what differs between them:
1. Compare `info` in the two files. If `info` is `null` in both, `tableinfos` is not how settings are fetched (or `gameui.ajaxcall` is gone); look instead in `primitives` and in `raw` for a field that differs between the friendly and the rated table.
2. Change `tableMode` (and, if the source changed, `facts` in `reader.mjs`) to read that field. Keep the rule's shape: one value means friendly, the known others mean rated, anything else is `unknown`.
3. Update `tools/bga/test/mode.test.mjs` so its `info(...)` helper builds the shape the live tables actually returned, and add both live `info` objects to it as literal fixtures with the expected mode.

If no field distinguishes the two tables, stop here and tell the user: without a reliable mode check the adapter must keep refusing every table.

- [ ] **Step 5: Check the ratings**

`ratings as read` must show a number for each player that matches what the page displays next to their name.

If it shows `null`, inspect the player panel in the browser's dev tools, find the element that holds the rating, and correct the selector in `facts` in `reader.mjs`. If friendly tables do not display a rating at all, leave it `null` — the report already counts those games separately — and tell the user, because it means ratings must be looked up by hand.

- [ ] **Step 6: Keep the live snapshot as a fixture**

Copy the friendly capture's `raw` object to `packages/bga-splendor-duel/test/fixtures/live/friendly-opening.json`, with player names and ids replaced by `1000`/`2000` and `"Bot"`/`"Opponent"` — a fixture should not carry anyone's account. Then:

`packages/bga-splendor-duel/test/live.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { legalActionsFromView } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { crossCheck } from '../src/crosscheck.js';
import { emptyMemory, remember } from '../src/memory.js';
import { parseSnapshot } from '../src/snapshot.js';
import { stateKind } from '../src/states.js';
import { toView } from '../src/toView.js';

/**
 * Snapshots captured from real BGA tables.
 *
 * The synthetic snapshots in the other tests share this repo's assumptions about BGA's shapes with
 * the code they test. These do not: they are what BGA actually sent. Every stop the adapter makes
 * saves its snapshot under data/bga/stops, and each one worth keeping belongs in this directory.
 */
const DIR = fileURLToPath(new URL('./fixtures/live/', import.meta.url));

describe('live snapshots', () => {
  for (const name of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    it(`${name} is read without complaint`, () => {
      const parsed = parseSnapshot(JSON.parse(readFileSync(`${DIR}${name}`, 'utf8')));
      expect(parsed.ok, parsed.ok ? '' : parsed.refusal.detail).toBe(true);
      if (!parsed.ok) return;
      const ours = parsed.snapshot.gamestate.active_player === parsed.snapshot.me;
      if (!ours || stateKind(parsed.snapshot.gamestate.name) !== 'decision') return;
      const result = toView(parsed.snapshot, remember(emptyMemory(), parsed.snapshot));
      expect(result.ok, result.ok ? '' : result.refusal.detail).toBe(true);
      if (!result.ok) return;
      expect(legalActionsFromView(result.view, result.seat).actions.length).toBeGreaterThan(0);
      expect(crossCheck(result.view, result.seat, parsed.snapshot)).toEqual([]);
    });
  }
});
```

Run: `npx vitest run packages/bga-splendor-duel/test/live.test.ts`
Expected: PASS. A `crossCheck` failure here is the most valuable result this whole plan can produce: it is BGA and our engine disagreeing about a real position. Read the message, find which side is wrong, and fix that.

- [ ] **Step 7: Turn the gate on**

Only once Steps 3 and 4 both hold, in `tools/bga/mode.mjs` change:

```js
export const MODE_CHECK_VERIFIED = true;
```

and replace the paragraph above it with one that records the evidence: the date, and the two capture file names that showed `friendly` and `rated`.

Run: `npx vitest run tools/bga && npm run lint`
Expected: PASS. (`guard`'s "refuses everything until verified" test passes `verified: undefined`, which now takes the default `true` — change that test to pass `verified: false` explicitly, and keep it.)

- [ ] **Step 8: Play one advised game**

On a new friendly table, set up as in Step 2:

```bash
npm run bga -- advise --table '<the game URL>' --iterations 300
```

Check, during the game:
- it refuses to start until `posted` is typed;
- each instruction's row and column match the outlined token on the page (this is the check that BGA's row 1 is the top row; if the outline and the words disagree, trust the outline and fix the wording in `instruct.ts`);
- "card N counting from the left" matches the outlined card;
- after each of your clicks, the next instruction appears without prompting;
- when the game ends, a row is appended to `data/bga/results.jsonl`, and `npm run bga -- report` counts it.

And three checks of what the page reports, each with `capture` (it cannot share the browser profile with a running `advise`, so do these on a friendly table you play by hand):
- **mid-turn, right after a purchase from the table** that leaves a decision in the same turn (a matching token, a steal, a royal or a discard): the capture's `raw` must show that card's table slot **empty**, that level's `cardDeckCount` one **larger** than before the purchase, and `cardDeckTop` face-down. This is BGA refilling at the end of the turn, which `toView` and `determinizeBga` rely on (spec, "When it stops"). If the slot is already refilled, `test/support/synth.ts` (`unrefilled`) and the spec are wrong about BGA and must be corrected before `play` is trusted;
- **after the game has ended**, a capture (a reload) must still yield the game state, with the winner's `score` at 1 and `endReasons` filled in — the result row is read from that snapshot;
- **the table id**: the URL the page is on after loading must carry `?table=<id>` with the id you passed. The adapter refuses to go on if the page's own `table` parameter ever differs from the table it vetted (`sameTable` in `reader.mjs`), so if BGA rewrites the URL some other way, that check must be corrected first.

Every stop saves its snapshot under `data/bga/stops/`. For each one, decide whether it was right to stop; if it was a translation bug, sanitise the snapshot into `test/fixtures/live/`, watch `live.test.ts` fail, and fix it.

- [ ] **Step 9: Commit**

```bash
git add tools/bga packages/bga-splendor-duel
git commit -m "Confirm the friendly-mode check against live tables, and keep what BGA really sends"
```

---

### Task 12: `toBgaCalls`, and `play`

Only after Task 11: `play` is built on a read path that a live table has already confirmed.

**Files:**
- Create: `packages/bga-splendor-duel/src/toBgaCalls.ts`, `packages/bga-splendor-duel/test/toBgaCalls.test.ts`
- Replace: `packages/bga-splendor-duel/test/support/fakeTable.ts` (adds `perform`)
- Create: `tools/bga/play.mjs`
- Modify: `packages/bga-splendor-duel/src/index.ts`, `tools/bga/reader.mjs` (add `perform`), `tools/bga/cli.mjs` (add `play`), `tools/bga/test/loop.test.mjs`

**Interfaces:**
- Consumes: `Located` (Task 5); `colorToBga` (Task 1); `Refusal` (Task 2); `runTable`, `fingerprint` (Task 10).
- Produces:
  - `toBgaCalls.ts`: `interface BgaCall { name: string; args: Record<string, string | number>; then?: string }` — `then` is the BGA state the page must reach before the next call is sent; `type CallPlan = { ok: true; calls: BgaCall[] } | { ok: false; refusal: Refusal }`; `toBgaCalls(action: SplendorAction, view: SplendorView, at: Located): CallPlan`
  - `fakeTable.ts`: `FakeTable.perform(call: { name: string; args: Record<string, string | number> }): Promise<void>`, throwing as BGA would on a move it does not allow
  - `play.mjs`: `makePlay({ perform, say, actTimeoutMs? })` → an `act`
  - `reader.mjs`: `table.perform(call)`

Action names and argument names are BGA's own, from `ActionTrait.php` and the `performAction` calls in `src/ts/Game.ts` of thoun/splendorduel. Lists of ids are sent as comma-joined strings, sorted ascending, exactly as the page's own code sends them.

- [ ] **Step 1: Replace the fake table with one that takes BGA's calls**

`packages/bga-splendor-duel/test/support/fakeTable.ts` (whole file):

```ts
import { RandomCursor } from '@games/engine';
import {
  LEVELS,
  apply,
  card,
  legalActions,
  setup,
  type CardRef,
  type GemColor,
  type PayColor,
  type SplendorAction,
  type SplendorState,
  type TokenColor,
} from '@games/splendor-duel';
import { gemFromBga } from '../../src/ids.js';
import { pick } from './play.js';
import { PLAYER_ID, cardIdOfBga, heldTokenColor, royalIdOfBga, stateOf, synthSnapshot } from './synth.js';

/**
 * A BGA table, as far as the adapter can tell: something that can be pulsed, snapshotted, and sent
 * BGA's action calls, with an opponent who moves in their own time.
 *
 * Underneath it is our own engine, dressed by `synthSnapshot`. That makes it a test of the loop and
 * of the call sequences -- turn detection, waiting, the three BGA states that are the middle of one
 * of our actions -- and not a test of whether BGA behaves this way. Only a live table tests that.
 *
 * `perform` follows `ActionTrait.php`: the same action names, the same arguments, the same
 * two-step flows. Where BGA would refuse a call, this throws.
 */

type Partway =
  | { k: 'privilege' }
  | { k: 'gold'; cell: number }
  | { k: 'joker'; from: CardRef; payment: Partial<Record<TokenColor, number>> };

export interface FakeCall {
  name: string;
  args: Record<string, string | number>;
}

export class FakeTable {
  state: SplendorState;
  pulses = 0;
  private ticks = 0;
  private partway: Partway | null = null;
  private readonly rng: RandomCursor;

  constructor(
    seed: string,
    readonly viewer: 0 | 1,
  ) {
    this.state = setup({ seed, seats: [0, 1], options: {} });
    this.rng = new RandomCursor(`${seed}:opponent`, 0);
  }

  private current(): { name: string; args: unknown } {
    if (this.partway?.k === 'privilege') return { name: 'usePrivilege', args: { number: 1, privileges: 1 } };
    if (this.partway?.k === 'gold') return { name: 'reserveCard', args: { canReserve: 1, deckCards: [] } };
    if (this.partway?.k === 'joker') return { name: 'placeJoker', args: { colors: [] } };
    return stateOf(this.state);
  }

  async pulse(): Promise<{ name: string; active: number; args: string }> {
    this.pulses += 1;
    if (this.pulses > 20_000) throw new Error('FakeTable: 20,000 pulses and the game has not ended');
    const theirs = this.state.stage !== 'over' && this.state.turn !== this.viewer;
    if (theirs && ++this.ticks % 3 === 0) {
      const seat = this.state.turn as 0 | 1;
      this.force(seat, pick(legalActions(this.state, seat).actions, this.rng));
    }
    const { name, args } = this.current();
    return { name, active: PLAYER_ID[this.state.turn as 0 | 1], args: JSON.stringify(args ?? null) };
  }

  async snapshot(): Promise<unknown> {
    const override = this.partway ? this.current() : undefined;
    return JSON.parse(JSON.stringify(synthSnapshot(this.state, this.viewer, override)));
  }

  /** The operator, doing as advised. */
  play(action: SplendorAction): void {
    this.force(this.viewer, action);
  }

  force(seat: 0 | 1, action: SplendorAction): void {
    const result = apply(this.state, seat, action);
    if (!result.ok) throw new Error(result.error.message);
    this.state = result.state;
  }

  /** One of BGA's action calls, from the viewer's seat. */
  async perform(call: FakeCall): Promise<void> {
    const seat = this.viewer;
    if (this.state.turn !== seat || this.state.stage === 'over') throw new Error('It is not your turn');
    const ids = (value: string | number | undefined): number[] =>
      String(value ?? '').split(',').filter((part) => part !== '').map(Number);

    switch (call.name) {
      case 'actUsePrivilege':
        if (this.partway || this.state.stage !== 'optional') throw new Error('This move is not authorized now');
        this.partway = { k: 'privilege' };
        return;

      case 'actRefillBoard':
        return this.force(seat, { t: 'replenish' });

      case 'actTakeTokens': {
        const cells = ids(call.args.ids).map((id) => id - 100);
        const [only] = cells;
        if (this.partway?.k === 'privilege') {
          this.partway = null;
          if (cells.length !== 1 || only === undefined) throw new Error('This fake takes one token per privilege');
          return this.force(seat, { t: 'usePrivilege', cell: only });
        }
        if (this.state.pending?.k === 'matchingToken') {
          if (only === undefined) throw new Error('You must take tokens from the board');
          return this.force(seat, { t: 'chooseMatchingToken', cell: only });
        }
        if (cells.length === 1 && only !== undefined && this.state.board[only] === 'gold') {
          if (this.state.players[seat].reserved.length >= 3) throw new Error("You can't reserve more than 3 cards");
          this.partway = { k: 'gold', cell: only };
          return;
        }
        return this.force(seat, { t: 'takeTokens', cells: [...cells].sort((a, b) => a - b) });
      }

      case 'actReserveCard': {
        if (this.partway?.k !== 'gold') throw new Error('This move is not authorized now');
        const goldCell = this.partway.cell;
        this.partway = null;
        return this.force(seat, { t: 'reserve', goldCell, from: this.sourceOf(Number(call.args.id)) });
      }

      case 'actBuyCard': {
        const cardId = cardIdOfBga(Number(call.args.id));
        const from = this.refOf(cardId);
        const payment = this.tally(ids(call.args.tokensIds));
        if (card(cardId).wild) {
          this.partway = { k: 'joker', from, payment };
          return;
        }
        return this.force(seat, { t: 'purchase', from, payment });
      }

      case 'actPlaceJoker': {
        if (this.partway?.k !== 'joker') throw new Error('This move is not authorized now');
        const { from, payment } = this.partway;
        this.partway = null;
        const wildColor = gemFromBga(Number(call.args.color)) as GemColor;
        return this.force(seat, { t: 'purchase', from, payment, wildColor });
      }

      case 'actTakeOpponentToken':
        return this.force(seat, { t: 'chooseSteal', color: heldTokenColor(Number(call.args.id)) as PayColor });

      case 'actTakeRoyalCard':
        return this.force(seat, { t: 'chooseRoyal', royalId: royalIdOfBga(Number(call.args.id)) });

      case 'actDiscardTokens':
        return this.force(seat, { t: 'discard', tokens: this.tally(ids(call.args.ids)) });

      default:
        throw new Error(`This move is not authorized now: ${call.name}`);
    }
  }

  private refOf(cardId: string): CardRef {
    for (const level of LEVELS) {
      const slot = this.state.pyramid[level].indexOf(cardId);
      if (slot >= 0) return { t: 'pyramid', level, slot };
    }
    return { t: 'reserved', cardId };
  }

  private sourceOf(bga: number): Extract<SplendorAction, { t: 'reserve' }>['from'] {
    const cardId = cardIdOfBga(bga);
    for (const level of LEVELS) {
      const slot = this.state.pyramid[level].indexOf(cardId);
      if (slot >= 0) return { t: 'pyramid', level, slot };
      if (this.state.decks[level][0] === cardId) return { t: 'deck', level };
    }
    throw new Error('You must reserve a card from the table or from the decks');
  }

  private tally(tokenIds: number[]): Partial<Record<TokenColor, number>> {
    const out: Partial<Record<TokenColor, number>> = {};
    for (const id of tokenIds) {
      const color = heldTokenColor(id);
      out[color] = (out[color] ?? 0) + 1;
    }
    return out;
  }
}
```

Run: `npx vitest run tools/bga/test/loop.test.mjs`
Expected: still PASS — the advise tests use only `pulse`, `snapshot`, `play`.

- [ ] **Step 2: Write the failing test**

`packages/bga-splendor-duel/test/toBgaCalls.test.ts`:

```ts
import { RandomCursor } from '@games/engine';
import { apply, legalActions, setup, type SplendorAction } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { locate } from '../src/locate.js';
import { emptyMemory, remember } from '../src/memory.js';
import { parseSnapshot } from '../src/snapshot.js';
import { toBgaCalls } from '../src/toBgaCalls.js';
import { toView } from '../src/toView.js';
import { FakeTable } from './support/fakeTable.js';
import { pick } from './support/play.js';
import { bgaCardId, boardTokenId, snap } from './support/synth.js';

/**
 * In `play` mode these calls are the bot's hands. The property that matters is not that each call
 * looks right but that sending them does to the table exactly what the action does to our engine --
 * same tokens, same card, same payment, and nothing else.
 */

describe('toBgaCalls', () => {
  const opening = setup({ seed: 'calls', seats: [0, 1], options: {} });
  const mover = opening.turn as 0 | 1;
  const plan = (action: SplendorAction) => {
    const snapshot = snap(opening, mover);
    const result = toView(snapshot, remember(emptyMemory(), snapshot));
    if (!result.ok) throw new Error(result.refusal.detail);
    return toBgaCalls(action, result.view, locate(snapshot));
  };
  const legal = legalActions(opening, mover).actions;

  it('takes tokens by their ids, sorted, comma-joined, as the page itself sends them', () => {
    const take = legal.find((a) => a.t === 'takeTokens' && a.cells.length === 3) as Extract<SplendorAction, { t: 'takeTokens' }>;
    const ids = take.cells.map(boardTokenId).sort((a, b) => a - b).join(',');
    expect(plan(take)).toEqual({ ok: true, calls: [{ name: 'actTakeTokens', args: { ids } }] });
  });

  it('reserves in two calls, and waits for the table to ask for the card in between', () => {
    const reserve = legal.find((a) => a.t === 'reserve' && a.from.t === 'pyramid') as Extract<SplendorAction, { t: 'reserve' }>;
    if (reserve.from.t !== 'pyramid') throw new Error('unreachable');
    const cardId = opening.pyramid[reserve.from.level][reserve.from.slot] as string;
    expect(plan(reserve)).toEqual({
      ok: true,
      calls: [
        { name: 'actTakeTokens', args: { ids: String(boardTokenId(reserve.goldCell)) }, then: 'reserveCard' },
        { name: 'actReserveCard', args: { id: bgaCardId(cardId) } },
      ],
    });
  });

  it('has no calls for a pass', () => {
    const result = plan({ t: 'pass' });
    expect(result.ok).toBe(false);
  });

  it('does to a table exactly what the action does to the engine, for every kind of move in a game', async () => {
    const kinds = new Set<string>();
    let performed = 0;
    for (const seed of ['calls-a', 'calls-b']) {
      const table = new FakeTable(seed, 0);
      const rng = new RandomCursor(`${seed}:moves`, 0);
      let memory = emptyMemory();
      for (let i = 0; i < 500 && table.state.stage !== 'over'; i++) {
        const seat = table.state.turn as 0 | 1;
        const action = pick(legalActions(table.state, seat).actions, rng);
        if (seat !== 0 || action.t === 'pass') {
          table.force(seat, action);
          continue;
        }

        const parsed = parseSnapshot(await table.snapshot());
        if (!parsed.ok) throw new Error(parsed.refusal.detail);
        memory = remember(memory, parsed.snapshot);
        const translated = toView(parsed.snapshot, memory);
        if (!translated.ok) throw new Error(translated.refusal.detail);

        const expected = apply(table.state, 0, action);
        if (!expected.ok) throw new Error(expected.error.message);

        const calls = toBgaCalls(action, translated.view, locate(parsed.snapshot));
        expect(calls.ok, calls.ok ? '' : calls.refusal.detail).toBe(true);
        if (!calls.ok) return;
        for (const call of calls.calls) {
          await table.perform(call);
          // `then` names the state the page must be in before the next call. The fake must agree.
          if (call.then) expect((await table.pulse()).name).toBe(call.then);
        }
        expect(table.state).toEqual(expected.state);
        kinds.add(action.t === 'purchase' && action.wildColor ? 'purchase-wild' : action.t);
        performed += 1;
      }
    }
    expect(performed).toBeGreaterThan(100);
    for (const kind of ['takeTokens', 'usePrivilege', 'replenish', 'reserve', 'purchase', 'chooseRoyal', 'discard']) {
      expect(kinds.has(kind), `no ${kind} was performed; add a seed`).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run packages/bga-splendor-duel/test/toBgaCalls.test.ts`
Expected: FAIL — cannot resolve `../src/toBgaCalls.js`.

- [ ] **Step 4: Implement `toBgaCalls.ts`**

```ts
import { TOKEN_COLORS, type SplendorAction, type SplendorView, type TokenColor } from '@games/splendor-duel';
import { colorToBga } from './ids.js';
import type { Located } from './locate.js';
import type { Refusal } from './refusal.js';

/**
 * One of our actions, as the calls BGA's page would make for it.
 *
 * Names and arguments are BGA's own, from `ActionTrait.php` and the page's `performAction` calls in
 * thoun/splendorduel. Three of our actions are two calls on BGA, with a state in between that the
 * page has to reach before the second is accepted: `then` names it, and the caller waits for it.
 *
 * There is no call for `pass`. BGA has no such move, and the loop stops before it would ask.
 */
export interface BgaCall {
  name: string;
  args: Record<string, string | number>;
  /** The BGA state to wait for before sending the next call. */
  then?: string;
}

export type CallPlan = { ok: true; calls: BgaCall[] } | { ok: false; refusal: Refusal };

/** The page sends id lists comma-joined and ascending. So do we. */
const list = (ids: number[]): string => [...ids].sort((a, b) => a - b).join(',');

const plan = (...calls: BgaCall[]): CallPlan => ({ ok: true, calls });
const cannot = (detail: string): CallPlan => ({ ok: false, refusal: { reason: 'unmapped', detail } });

/** Which of the tokens in `pool` to hand over: the lowest ids of each colour. Tokens of a colour are alike. */
function held(pool: Record<TokenColor, number[]>, counts: Partial<Record<TokenColor, number>>): number[] | null {
  const out: number[] = [];
  for (const color of TOKEN_COLORS) {
    const wanted = counts[color] ?? 0;
    if (wanted === 0) continue;
    if (pool[color].length < wanted) return null;
    out.push(...pool[color].slice(0, wanted));
  }
  return out;
}

export function toBgaCalls(action: SplendorAction, view: SplendorView, at: Located): CallPlan {
  const tokenOn = (cell: number): number | undefined => at.boardToken.get(cell)?.id;

  switch (action.t) {
    case 'takeTokens': {
      const ids = action.cells.map(tokenOn);
      if (ids.some((id) => id === undefined)) return cannot(`No BGA token on one of cells ${action.cells.join(', ')}.`);
      return plan({ name: 'actTakeTokens', args: { ids: list(ids as number[]) } });
    }

    case 'usePrivilege': {
      const id = tokenOn(action.cell);
      if (id === undefined) return cannot(`No BGA token on cell ${action.cell}.`);
      return plan(
        { name: 'actUsePrivilege', args: {}, then: 'usePrivilege' },
        { name: 'actTakeTokens', args: { ids: String(id) } },
      );
    }

    case 'replenish':
      return plan({ name: 'actRefillBoard', args: {} });

    case 'reserve': {
      const gold = tokenOn(action.goldCell);
      const cardId = action.from.t === 'pyramid' ? view.pyramid[action.from.level][action.from.slot] : null;
      const target = action.from.t === 'deck' ? at.deckTop[action.from.level] : cardId ? at.cardBgaId.get(cardId) : undefined;
      if (gold === undefined || target === undefined || target === null) return cannot('Cannot find the gold token or the card to reserve.');
      return plan(
        { name: 'actTakeTokens', args: { ids: String(gold) }, then: 'reserveCard' },
        { name: 'actReserveCard', args: { id: target } },
      );
    }

    case 'purchase': {
      const cardId = action.from.t === 'pyramid' ? view.pyramid[action.from.level][action.from.slot] : action.from.cardId;
      const target = cardId ? at.cardBgaId.get(cardId) : undefined;
      const payment = held(at.myTokens, action.payment);
      if (target === undefined || payment === null) return cannot('Cannot find the card to buy, or the tokens to pay for it.');
      const buy: BgaCall = { name: 'actBuyCard', args: { id: target, tokensIds: list(payment) } };
      if (!action.wildColor) return plan(buy);
      return plan({ ...buy, then: 'placeJoker' }, { name: 'actPlaceJoker', args: { color: colorToBga(action.wildColor) } });
    }

    case 'chooseMatchingToken': {
      const id = tokenOn(action.cell);
      if (id === undefined) return cannot(`No BGA token on cell ${action.cell}.`);
      return plan({ name: 'actTakeTokens', args: { ids: String(id) } });
    }

    case 'chooseSteal': {
      const [id] = at.theirTokens[action.color];
      if (id === undefined) return cannot(`The opponent holds no ${action.color} token.`);
      return plan({ name: 'actTakeOpponentToken', args: { id } });
    }

    case 'chooseRoyal': {
      const id = at.royalBgaId.get(action.royalId);
      if (id === undefined) return cannot(`Royal ${action.royalId} is not on the table.`);
      return plan({ name: 'actTakeRoyalCard', args: { id } });
    }

    case 'discard': {
      const ids = held(at.myTokens, action.tokens);
      if (ids === null) return cannot('We do not hold the tokens this discard names.');
      return plan({ name: 'actDiscardTokens', args: { ids: list(ids) } });
    }

    case 'pass':
      return { ok: false, refusal: { reason: 'disagreement', detail: 'Our rules say pass; BGA has no such move.' } };
  }
}
```

Append to `packages/bga-splendor-duel/src/index.ts`:

```ts
export * from './toBgaCalls.js';
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run packages/bga-splendor-duel/test/toBgaCalls.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the failing loop test for `play`**

Add to `tools/bga/test/loop.test.mjs` — the import `import { makePlay } from '../play.mjs';` at the top, and this block at the end:

```js
describe('runTable, playing', () => {
  it('plays a whole game through BGA’s own calls, from either seat', async () => {
    for (const [seed, viewer] of [['play-a', 0], ['play-b', 1]]) {
      const table = new FakeTable(seed, viewer);
      const said = [];
      const act = makePlay({ perform: (call) => table.perform(call), say: (line) => said.push(line) });
      const result = await runTable({ table, brain: randomBrain(seed), act, memory: emptyMemory(), ...quiet });

      expect(endedProperly(result), JSON.stringify(result.refusal)).toBe(true);
      expect(result.moves).toBeGreaterThan(10);
      expect(said).toHaveLength(result.moves);
      if (result.outcome === 'finished') expect(table.state.stage).toBe('over');
    }
  });

  it('stops, and says what BGA said, when a call is refused', async () => {
    const table = new FakeTable('play-refused', 0);
    const act = makePlay({
      perform: async () => {
        throw new Error('This move is not authorized now');
      },
      say: () => {},
    });
    const result = await runTable({ table, brain: randomBrain('play-refused'), act, memory: emptyMemory(), ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('refused');
    expect(result.refusal.detail).toContain('This move is not authorized now');
    expect(result.moves).toBe(1);
  });

  it('stops when the table never reaches the state the second call needs', async () => {
    const table = new FakeTable('play-stuck', 0);
    // Accept every call and change nothing: the table never moves into `reserveCard` or the like.
    const act = makePlay({ perform: async () => {}, say: () => {}, actTimeoutMs: 1000 });
    const twoStep = (view, seat) => {
      const { actions } = legalActionsFromView(view, seat);
      return { action: actions.find((a) => a.t === 'reserve') ?? actions[0], value: 0 };
    };
    const result = await runTable({ table, brain: twoStep, act, memory: emptyMemory(), pollMs: 500, ...quiet });
    expect(result.outcome).toBe('stopped');
    expect(result.refusal.reason).toBe('refused');
    expect(result.refusal.detail).toMatch(/reserveCard/);
  });
});
```

Run: `npx vitest run tools/bga/test/loop.test.mjs`
Expected: FAIL — cannot resolve `../play.mjs`.

Note for the third test: viewer 0 may not be first to move; the opponent plays until it is, and the opening position always offers a reservation unless the opponent has taken all three gold, which three pulses' worth of random moves will not do.

- [ ] **Step 7: Implement `play.mjs`**

```js
/**
 * `play`: the bot decides, and the bot moves.
 *
 * The move is turned into BGA's own action calls and sent through the page, in order, waiting for
 * the page to reach the state each next call needs. Any refusal from BGA ends the adapter's part in
 * the game: a move BGA turned down is a disagreement about the position, and the answer to that is
 * a person, not a second attempt.
 */

import { toBgaCalls } from '@games/bga-splendor-duel';
import { describeAction } from '@games/splendor-duel';
import { fingerprint } from './loop.mjs';

const refused = (detail) => ({ ok: false, refusal: { reason: 'refused', detail } });
const signed = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

export function makePlay({ perform, say, actTimeoutMs = 15_000 }) {
  return async ({ action, value, view, at, before, waitWhile }) => {
    const plan = toBgaCalls(action, view, at);
    if (!plan.ok) return plan;
    say(`▶ ${describeAction(action, view)}    (search value ${signed(value)})`);

    for (const call of plan.calls) {
      try {
        await perform(call);
      } catch (error) {
        return refused(`BGA refused ${call.name}: ${error.message}`);
      }
      if (call.then && !(await waitWhile((pulse) => pulse.name !== call.then, actTimeoutMs))) {
        return refused(`After ${call.name}, the table did not reach "${call.then}" within ${Math.round(actTimeoutMs / 1000)}s.`);
      }
    }

    // The page learns the new state a moment after the call returns. Give it that moment; if it
    // never shows a change, the loop's next snapshot is a reload and settles the question anyway.
    const was = fingerprint(before);
    await waitWhile((pulse) => fingerprint(pulse) === was, actTimeoutMs);
    return { ok: true };
  };
}
```

Run: `npx vitest run tools/bga/test/loop.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 8: Give the reader hands, and the CLI a `play` command**

In `tools/bga/reader.mjs`, add this method to the object `makeTable` returns, after `show`:

```js
    /**
     * Send one of the game's own actions through the page, exactly as a click would.
     *
     * UNVERIFIED until the live step of Task 12: which of the two action APIs the page exposes on
     * `gameui`. Both are tried, the current one first. A refusal from BGA rejects here with BGA's
     * own message.
     */
    async perform(call) {
      await page.evaluate(async ({ name, args }) => {
        const current = gameui.bga?.actions;
        const send =
          current && typeof current.performAction === 'function'
            ? (n, a) => current.performAction(n, a)
            : typeof gameui.bgaPerformAction === 'function'
              ? (n, a) => gameui.bgaPerformAction(n, a)
              : null;
        if (!send) throw new Error('This page exposes no action API the adapter knows.');
        try {
          await send(name, args);
        } catch (error) {
          // BGA rejects with a string or a `{ message }` object, neither of which survives the trip to node.
          throw new Error(typeof error === 'string' ? error : (error?.message ?? JSON.stringify(error)));
        }
      }, { name: call.name, args: call.args });
    },
```

In `tools/bga/cli.mjs`: add `import { makePlay } from './play.mjs';` beside the `makeAdvise` import; add to the header comment's list

```js
 *   npm run bga -- play    --table <url> [--iterations N]   play the moves itself
```

add below `advise`:

```js
const play = (flags) =>
  sit('play', flags, (table) => makePlay({ perform: (call) => table.perform(call), say: (line) => console.log(`\n${line}`) }));
```

add to `main`'s `switch`:

```js
    case 'play':
      return play(flags);
```

and extend the usage line with `| play --table <url> [--iterations N]`.

- [ ] **Step 9: Check the gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: exit 0; every test in the repo passes.

- [ ] **Step 10: Commit**

```bash
git add packages/bga-splendor-duel tools/bga
git commit -m "Let the network make its own moves at a friendly table"
```

- [ ] **Step 11: One played game, watched (operator, with a display)**

On a new friendly table, set up and disclosed as in Task 11:

```bash
npm run bga -- play --table '<the game URL>' --iterations 300
```

Watch the whole game. Check:
- the first move is not sent until `posted` is typed;
- each printed move is the move that appears on the table;
- a reservation, a privilege, and (if one comes up) a wild-card purchase each complete without a stop — these are the two-call actions;
- on any stop, the bell rings, the browser stays open, and you can finish the game by hand.

If the very first call fails with `This page exposes no action API the adapter knows`, open the browser's console on the game page, look at what `gameui` offers for performing an action, and correct `perform` in `reader.mjs`. If a call is refused, the stop file under `data/bga/stops/` has the snapshot; compare the call `toBgaCalls` produced with what the page's own code sends for the same click (`src/ts/Game.ts` in thoun/splendorduel), fix `toBgaCalls.ts`, and teach `FakeTable.perform` the same thing so the test would have caught it.

Commit any fix with a message saying what BGA actually expects.

`play` refuses to start until `PLAY_VERIFIED` in `tools/bga/mode.mjs` is `true`, so for this game set it to `true` locally first. Keep it — and commit it, with the paragraph above it replaced by the date and the table id — only once the whole game has been watched through and every check above held, including that `perform` reached the page through its action API. If any of them failed, set it back to `false` and fix first.

Run: `npx vitest run tools/bga && npm run lint`
Expected: PASS, after changing the "ships closed" test in `tools/bga/test/mode.test.mjs` to expect `PLAY_VERIFIED` to be `true` (keep the test that `playAllowed({ verified: false })` refuses).

---

### Task 13: Say how it is used, and under what conditions

**Files:**
- Create: `tools/bga/README.md`
- Modify: `README.md` (layout table and one section)

- [ ] **Step 1: Write `tools/bga/README.md`**

````markdown
# Playing on BoardGameArena

The published network, at a Splendor Duel table on boardgamearena.com, so that its strength can be
measured against people. Two modes:

| | |
| --- | --- |
| `advise` | Reads the position, searches, and tells you what to click. You make every move. |
| `play` | The same, and makes the moves itself. |

```bash
npx playwright install chromium        # once
npm run typecheck                      # once after pulling: the tool imports the packages' built output
npm run bga -- login                   # once: sign in to BGA by hand in the window that opens
npm run bga -- advise --table 'https://boardgamearena.com/1/splendorduel?table=123456789'
npm run bga -- play   --table '…' --iterations 1000
npm run bga -- report
```

It needs a machine with a display: the browser is real and visible, because in `advise` you play in
it and in `play` it is what you take over when the adapter stops.

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

## When it stops

| Reason | What it means |
| --- | --- |
| `bad-snapshot` | BGA's page no longer has the shape this reads. BGA changed something. |
| `expansion` | The Counterfeiters expansion is on. Not supported. |
| `unknown-state` | The table sat in a state there is no translation for. |
| `inconsistent` | The snapshot cannot be a position of this game. |
| `disagreement` | Our rules and BGA's allow different moves here. Includes being *stuck*: BGA forces a refill where our rules pass. |
| `refused` | (`play`) BGA turned down a move. |

Every stop saves its snapshot to `data/bga/stops/`. If the stop was a bug in the translation, strip
the names and ids from that snapshot, put it in
`packages/bga-splendor-duel/test/fixtures/live/`, and `live.test.ts` will fail until it is fixed.

## The rating

`report` fits one rating, by maximum likelihood under the Elo curve, to the clean games against
opponents whose rating was recorded, and prints a 95% interval. It is in BGA's displayed units.

It prints two caveats every time, because they are easy to forget once there is a number: these
were friendly games, which people may not play at full effort; and the interval reflects only how
many games there were.

## Calibration

`MODE_CHECK_VERIFIED` in `mode.mjs` records that the friendly-mode check was confirmed against a
live friendly table and a live rated one. If BGA changes how a table reports its mode, set it back
to `false`, run `capture` on one table of each kind, and fix `tableMode` until `capture` reads both
correctly. `capture` only reads; it is safe on any table.

## How it is put together

`packages/bga-splendor-duel` is the translation, and is pure: a BGA snapshot in, a `SplendorView`
out; a `SplendorAction` in, words or BGA calls out. This directory is everything that touches a page
or a file. `reader.mjs` is the only code that evaluates anything in BGA's page.

BGA's implementation of the game is public (github.com/thoun/splendorduel). State names, action
names and the shape of the game state come from there.
````

- [ ] **Step 2: Point the root README at it**

In `README.md`, in the layout block, add after the `packages/bot-splendor-duel/` line:

```
packages/bga-splendor-duel/   a BoardGameArena table, translated to and from this game's own types
```

and after the `tools/scrape-cards/` line:

```
tools/bga/                    sit the published network at a friendly BGA table: advise, or play
```

Add a section after "Play against a bot over the wire":

````markdown
### Measure it against people, on BoardGameArena

```bash
npm run bga -- advise --table '<a friendly-mode game URL>'    # it tells you what to click
npm run bga -- report                                         # the rating the games so far support
```

The published network at a real table, in disclosed, unrated friendly games only — the adapter
refuses anything else. `tools/bga/README.md` has the conditions and the rest.
````

- [ ] **Step 3: Final verification**

Run: `npm run typecheck && npm run lint && npm test`
Expected: exit 0; every test passes.

Run: `git status --short`
Expected: only `README.md` and `tools/bga/README.md` changed. Nothing under `data/` or `tools/bga/.cache/` appears (both are ignored).

- [ ] **Step 4: Commit**

```bash
git add README.md tools/bga/README.md
git commit -m "Say how the BGA adapter is used, and what it will not do"
```

---

## Left out on purpose

- **A local server speaking our WebSocket protocol in front of a BGA table**, so that any bot written against `docs/protocol.md` could play there unchanged. The user expects to want this later. The seam for it is `runTable`'s `brain` and `act`: a server would be a third `brain` that waits for an `action` frame instead of searching, with `sync` built from `toView`'s output.
- **Creating and configuring tables.** The operator does it by hand, which is also what keeps a person responsible for the disclosure.
- **Playing through a stuck position** (BGA's forced refill) and **BGA's anti-hoarding game end**. Both are rare, both are stops, and modelling either means teaching the engine a BGA house rule the network never trained under.
