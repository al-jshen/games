# Adding a game

Adding a game means creating one package and adding **two lines** — one to the server registry, one to
the web app's board map. No platform code changes.

Being honest about that claim: it is not literally zero lines, and it deliberately is not. A dynamic
plugin loader would buy you nothing here and cost real complexity, and a static list means the type
checker and the bundler both see every game. `packages/games/tic-tac-toe` exists precisely to keep
this claim true — an interface with one implementor is a guess, not an abstraction.

## 1. The package

```
packages/games/<your-game>/
  package.json          # exports "." (headless) and "./ui" (bundler-only)
  tsconfig.json         # excludes src/ui
  tsconfig.ui.json      # noEmit typecheck for the UI
  src/index.ts          # the GameModule
  src/ui/index.tsx      # default-exports the board component
  test/…
```

Copy `packages/games/tic-tac-toe` — it is about 200 lines and covers every part of the contract.

## 2. Implement `GameModule`

The full interface is in `packages/engine/src/module.ts`. The shape:

```ts
export const myGame: GameModule<State, Action, View, Options> = {
  id: 'my-game',
  stateVersion: 1,
  meta: { title, blurb, minPlayers, maxPlayers, estMinutes },
  actionValidator, optionsValidator,

  setup({ seed, seats, options }) { … },
  currentActors(state) { … },          // who may act now; [] once over
  legalActions(state, seat) { … },     // convenience; may be `truncated`
  isLegal(state, seat, action) { … },  // the arbiter
  apply(state, seat, action) { … },    // pure reducer
  outcome(state) { … },
  redactFor(viewer, state) { … },      // the only path to a wire view
  redactEffect(viewer, effect, state) { … },

  applyToView?(view, seat, action) { … },      // optional: enables client prediction
  legalActionsFromView?(view, seat) { … },     // optional: enables local bot search
};
```

### Rules that are enforced, not merely suggested

- **`apply` is pure and deterministic.** No mutation of its input, no I/O, no clock. All randomness
  comes from `state.seed` plus a counter carried in state, via `RandomCursor`. An ESLint rule bans
  `Math.random` and `Date.now` under `packages/games/*/src`, because either one silently invalidates
  every stored replay with no test failure anywhere.
- **No `node:*` imports, and no importing `@games/protocol` or `apps/*`.** Game modules run in the
  browser too — that is what makes client-side prediction and in-process bot search possible. Also
  enforced by ESLint.
- **State must be plain JSON.** No `Map`, `Set`, `Date`, class instances, or `undefined` inside
  arrays. Assert it with `isJsonRoundTrippable`.
- **Illegal actions return a value, never throw.** A probing or buggy bot will send hundreds.
- **`redactFor` builds its view from scratch**, field by field — never by copying the truth state and
  deleting keys. That way a secret you add later cannot leak by being forgotten.

### Hidden information

`Redacted<V>` is a branded type and `seal()` is the only way to mint one; the transport accepts
nothing else, so `send(socket, { view: state })` does not compile.

Two mistakes worth avoiding, both of which Splendor Duel demonstrates:

- **Model knowledge per fact, not per bucket.** A card reserved from the face-up display was
  legitimately seen by the opponent; one drawn off a deck was not. Same field, different visibility —
  so the datum carries `{ cardId, publiclyKnown }` rather than living in a blanket `secret` bag.
- **Do not over-hide.** The bag's *composition* is public and its *order* is secret, so it redacts to
  a per-colour count. Collapsing it to a single total would stop players computing draw odds they are
  entitled to.

Preserve array **lengths** when masking identities — emit a placeholder, never a shorter array.

## 3. Register it

```ts
// apps/server/src/registry.ts
const MODULES: AnyGameModule[] = [splendorDuel, ticTacToe, myGame];
```

```ts
// apps/web/src/games.ts
const BOARDS = {
  'my-game': () => import('@games/my-game/ui'),
};
```

Add the workspace to the root `package.json` `workspaces` array and to the `typecheck` script.

## 4. The board component

```tsx
export default function MyBoard({ view, seat, actors, submit, pending }: BoardProps) { … }

// Optional extras the shell will pick up if you export them:
export function Sidebar(props: BoardProps) { … }         // panel in the app sidebar
export function describeEffect(effect): string { … }      // move-log wording in your own vocabulary
```

`Sidebar` is worth knowing about. Anything with a *variable* height belongs there rather than in the
board column — Splendor Duel's turn guide is ~150px taller on your turn than while waiting, and while
it lived above the board that swing resized every card on every move.

Drive affordances from `legalActionsFromView` so the UI cannot offer a move the server would refuse,
and cannot drift when the rules change.

Resist writing a generic board renderer. It will fit exactly one game and fight every other.

## 5. Tests that are worth writing

In roughly the order the bugs actually appear:

1. **Golden `setup` snapshot** — catches an accidental change to the shuffle or PRNG that would
   quietly invalidate stored replays.
2. **Purity** — deep-freeze the input, assert no mutation, assert applying twice is identical, assert
   the JSON round trip.
3. **Invariants over random playthroughs** — drive a full game by picking uniformly from
   `legalActions` and assert your conservation laws after *every* step. For Splendor Duel: token
   multiset equals the box contents, privileges always sum to 3, every card in exactly one place,
   `legalActions` never empty while active.
4. **`legalActions` ⇔ `isLegal`** agreement, plus fuzzing garbage through the validator.
5. **Redaction** — no secret atom appears in a serialised view; and **view stability**: permute hidden
   information and assert an opponent's view is byte-identical. Without that second one, payload size
   alone can leak hidden state.
6. **Wire schema** — every action `legalActions` emits must survive a JSON round trip *and* the action
   validator. This one is easy to skip and it caught a real bug: a zod 4 record keyed by an enum is
   exhaustive, so sparse token purses were rejected over the wire while every unit test passed,
   because unit tests call the reducer directly.
7. **Replay** — `replay(module, record)` must reproduce the final state byte-for-byte.
8. **Prediction fidelity**, if you implement `applyToView` — the predicted view must exactly equal
   what the server sends, or the board visibly corrects itself and players stop trusting it.
9. **Render every state**, server-side, for both seats (`apps/web/test/render.test.tsx`). Cheap, and
   it catches the whole class of "the board threw and the room went blank". Assert nothing secret
   reaches the markup while you are there.
10. **A browser test with two contexts** (`e2e/`). The only way to catch the mistakes that live
    between the client and the server — and the place to assert UI invariants, such as never telling
    a player it is their turn while offering them nothing to do.

Two UI traps worth knowing, because neither is obvious:

- Derive "is it my turn" from the **view you are rendering**, not from the server's `actors`. While an
  optimistic move is unconfirmed those two disagree, and mixing them produces a board that announces
  your turn and offers no moves.
- If you make your board fit the viewport, **do not put `overflow: hidden` on the flex item you want
  to keep its size**. Per the flexbox spec the automatic minimum size only applies while overflow is
  visible, so adding it replaces `min-height: auto` with zero and the element you were protecting
  silently shrinks and clips its contents. Put the clip on an ancestor instead, and let a genuinely
  discretionary element (a help panel, a log) be the thing that shrinks.
- Sizing that depends on both available width and height is easier to *measure* than to express. See
  `metrics.ts`: the container's height comes from flex (`flex: 1 1 0`), so it does not depend on its
  contents, which makes measuring the box and sizing the contents to fit non-circular. Reaching for
  `height: 100%` plus `aspect-ratio` instead is circular inside flex — the parent's intrinsic width
  resolves before the row height is known, so it collapses. And keep gap values in *one* place: a
  constant in the arithmetic and a `clamp()` in the stylesheet disagreed by a pixel and clipped a row.
