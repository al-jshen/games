# Playing Splendor Duel on BoardGameArena: design

2026-09-30

## Goal

Find out how strong the trained network is against people, by letting it play Splendor Duel on
boardgamearena.com (BGA) and recording the results against opponents whose rating is known.

Two ways of getting its moves onto the table, sharing everything except the last step:

- **`advise`** — the adapter reads the position, runs the search, and tells the operator what to
  play. The operator clicks. Nothing is ever submitted by the program.
- **`play`** — the same, except the adapter submits the move itself.

`advise` is the robust one and is built first. It has no write path to break, and every decision
starts from a fresh snapshot, so it does not care whether the last move was the one it suggested.
`play` adds only the translation from our action to BGA's calls, on top of a read path that `advise`
has by then already proved against a live table.

## Conditions of use

These are part of the design, not a note beside it, and both modes enforce them in code.

- **Friendly mode only.** The adapter reads the table's mode before doing anything and refuses, in
  both modes, to advise or play on a table that is not unrated friendly mode. If it cannot tell, it
  refuses. An advisor that worked on an arena table would be a cheating aid whatever was intended.
- **Disclosed.** The operator creates the table by hand, says in its description that the seat is a
  bot, and the opponent is told again in chat when the game starts. Both modes print the text and
  wait for the operator to confirm it has been posted before the first move. The program does not
  post it itself: a notice that silently failed to send would be worse than one a person typed.
- **Only what the seat is shown.** Position comes from the page's full game state and nothing else.
  The notification stream is never read: BGA's `reserveCard` notification carries the whole card to
  both players and leaves it to the page to hide it, so reading it would hand the bot a card its
  seat was never entitled to see.
- **No disguise.** No randomised or human-shaped timing. The only delay is the one the page's own
  animations need between two calls.
- **Never abandons a game.** When anything goes wrong the adapter stops and hands the game to the
  operator, who finishes it by hand in the browser that is already open.

BGA has not approved this automation and its terms prohibit analysing its code and protocols, which
this does. That risk sits with the account holder and is recorded here so nobody rediscovers it.

## Not in scope

- Arena or any rated play.
- Creating, joining or configuring tables. The operator does that and passes the table URL.
- The Counterfeiters expansion. A table with it enabled is refused.
- A local server speaking our WebSocket protocol in front of a BGA table. The boundary below is
  shaped so one could be added; nothing needs it yet.
- Tracking state from BGA's notification stream. Full snapshots only, for the reason
  `docs/protocol.md` gives for our own wire format.

## Shape

```
  browser (operator's logged-in profile)
        │  full game state + current state name and args
        ▼
  reader            tools/bga            the only code that touches the page
        │  BgaSnapshot (plain JSON)
        ▼
  translate         packages/bga-splendor-duel     pure, no IO
        │  SplendorView + seat
        ▼
  search            @games/bot-splendor-duel       unchanged
        │  SplendorAction
        ├──────────────► instruct   → words (+ highlight)     advise
        └──────────────► toBgaCalls → page action calls       play
```

Where things are known from: BGA's implementation of this game is published by its developer
(`thoun/splendorduel`, the same source `tools/scrape-cards` was checked against). State names,
action names and the shape of the full game state are read from that source rather than from
traffic.

### `packages/bga-splendor-duel` (TypeScript, pure)

Subject to the same lint layering as a game module: no `node:*`, no transport, no browser.

- `snapshot.ts` — the `BgaSnapshot` type, and a zod schema that rejects anything unexpected. A
  snapshot the schema does not recognise is a stop, not a best effort.
- `ids.ts` — the three vocabularies:
  - colours: BGA `-1 gold, 0 pearl, 1 blue, 2 white, 3 green, 4 black, 5 red`;
  - cells: BGA numbers board positions 1–25 in refill order and refills in that order, so
    `cell = SPIRAL[locationArg - 1]`. That makes the two refill orders identical, which is the only
    thing the orientation decides;
  - cards: BGA `(level, index)` is our `l<level>-<index>` and BGA royal `index` is our
    `royal-<index>` — the two numberings coincide. A test holds BGA's 71 definitions as a fixture
    and asserts every one agrees with ours on points, crowns, bonus, cost and ability, so the
    coincidence cannot quietly stop being true.
- `toView.ts` — `BgaSnapshot → { view: SplendorView, seat }`, or a typed refusal.
- `memory.ts` — the one piece of state, in three parts:
  - **cards seen face-up**, by BGA card id. BGA hides an opponent's reservation even when it was
    taken from the table; BGA card ids are stable, so a reserved id we once saw on the table is a
    card we know. Never seen means `hidden`, which costs a little information and is never wrong;
  - **what our seat owned before this turn's purchase**, which is what says whether a discard is
    followed by an extra turn;
  - **a summary of the previous snapshot**, which is what recognises our own replenish.
  Only the first survives a restart. The loop also takes one snapshot at the start of each
  opponent turn, so the second is always fresh.
- `instruct.ts` — `SplendorAction → Instruction`: the move in words, in BGA's own on-screen
  coordinates, plus the ids of the tokens and cards involved. Used by `advise`.
- `toBgaCalls.ts` — `SplendorAction → BgaCall[]`. Used by `play`.

BGA state → our view:

| BGA state | `stage` | `pending` |
| --- | --- | --- |
| `playAction` | `optional` | none |
| `takeBoardToken` | `abilities` | `matchingToken` |
| `takeOpponentToken` | `abilities`, or `crowns` when a royal granted it | `steal` |
| `takeRoyalCard` | `crowns` | `royal` |
| `discardTokens` | `cleanup` | `discard` |
| `usePrivilege`, `reserveCard`, `placeJoker` | no equivalent: the middle of one of our actions |
| anything else | refusal |

`usePrivilege`, `reserveCard` and `placeJoker` are never a decision point. `play` issues both
halves itself; `advise` gives both halves in one instruction and waits for the state to move on.

View fields BGA does not publish:

| Field | Source |
| --- | --- |
| `royalsTaken` | the number of royals held; a royal is only ever taken by crossing a threshold |
| `abilityQueue` | always empty at a decision point: no card has an ability queued behind a choice |
| `replenishedThisTurn` | memory, or failing that the state args (privileges offered drop to zero) |
| `boughtThisTurn` | implied by the state, except at a discard, where memory says |
| `extraTurns` | zero except at a discard, where memory says what was bought or claimed this turn |
| `turnsWithoutPurchase`, `options` | zero and empty: BGA has no stall rule, and the network never sees either |

Where memory is needed and missing — the adapter was started mid-turn — the field takes its
neutral value and the translation carries a warning the operator sees.

Our action → BGA calls (`play` only):

| Ours | BGA |
| --- | --- |
| `takeTokens` | `actTakeTokens(ids)` |
| `usePrivilege` | `actUsePrivilege`, then `actTakeTokens([id])` |
| `replenish` | `actRefillBoard` |
| `reserve` | `actTakeTokens([goldId])`, then `actReserveCard(id)` |
| `purchase` | `actBuyCard(id, tokenIds)`, then `actPlaceJoker(colour)` if wild |
| `chooseMatchingToken` | `actTakeTokens([id])` |
| `chooseSteal` | `actTakeOpponentToken(id)` |
| `chooseRoyal` | `actTakeRoyalCard(id)` |
| `discard` | `actDiscardTokens(ids)` |
| `pass` | none — stop. BGA forces a refill here instead; see below. |

### `tools/bga` (node)

- `login` — open the persistent browser profile for the operator to sign in by hand. No credential
  is ever read, stored or typed by the program.
- `advise --table <url>` and `play --table <url>` — the loop below. `--iterations` as in the web
  client, default 1000, the operating point the network was measured at.
- `capture --table <url>` — write the current snapshot to a fixture file. How real data gets into
  the tests.
- `report` — the rating estimate.

The checkpoint is the published one in `apps/web/public/bots/splendor-duel/current`, read with the
loader `tools/selfplay` already has, and searched with the same `netDeps` / `search` configuration
and `pickAction` as the web client, so the agent on BGA is the agent that was measured.

### The loop

1. Check the table is friendly mode and the expansion is off. Otherwise exit. Wait for the operator
   to confirm the bot notice is in the chat.
2. Wait until the page says it is our turn to decide. (At the start of each opponent turn, take one
   snapshot for memory and do nothing else.)
3. Take a fresh full snapshot — a page reload, which is the one way the page offers to get the
   whole state. Translate it.
4. Cross-check: our legal moves against what BGA's state args say is possible (can refill, can
   reserve, which cards are affordable). A disagreement is a stop.
5. Search. Pick.
6. `advise`: print the instruction and highlight the pieces on the page; wait for the state to
   change. `play`: issue the calls; wait for the state to change.
7. On game end, append the result and exit.

### When it stops

Unknown state, unmapped card, snapshot that fails the schema, legal-move disagreement, only `pass`
legal, a refused call, expansion content. In every case: say exactly what was seen, save the
snapshot beside the results for a later fixture, ring the terminal bell, leave the browser open, and
do nothing further on that table.

Known rule differences that land here rather than being modelled: BGA's forced refill when no
mandatory action exists (we have `pass`), and BGA's option to end the game against an opponent
hoarding all gold and pearls (we have `maxTurnsWithoutPurchase`). Both are rare, and guessing in
either would mean playing a move the search never considered.

One known difference is handled rather than stopped on, because it is one of timing and not of
position: BGA refills the table at the end of the turn (`refillCards` runs in `NextPlayer`), and
our engine refills a slot as soon as its card is bought or reserved. So at every decision later in
a turn that took a card from the table — a matching token, a steal, a royal, a discard — BGA shows
that slot empty and that level's deck one card larger, with the card that will fill it face-down on
top. `toView` reports exactly that, and the search samples its worlds with `determinizeBga`, which
deals each such slot the next card of its sampled deck: an empty slot over a non-empty deck never
occurs in our engine, so it can only mean "not refilled yet". A slot whose deck has run out stays
empty, as it does on both sides.

## Measuring strength

One JSON line per finished game in `data/bga/results.jsonl` (already ignored by git): table id,
date, mode (`advise` or `play`), generation, iterations, our seat, opponent's rating at the time,
result, how it ended, and whether the operator had to take over.

`report` fits a single rating by maximum likelihood under the Elo curve against the opponents'
ratings and prints it with a 95% interval and the game count. Games the operator finished by hand
are listed separately and excluded by default.

Two caveats the report prints every time: friendly games may not be played at full effort, so this
is a lower bar than an arena rating; and with few games the interval is wide enough that the point
estimate means little.

## Testing

- Card table: all 71 cards agree with BGA's definitions field by field.
- Cells: the 25 positions map onto `SPIRAL`, and every legal line stays a legal line.
- Round trip, as a property test over random playthroughs: our state → a synthetic `BgaSnapshot` →
  `toView` must equal `redactFor` of the original, at every decision point — as BGA shows it at
  that moment, with a slot taken from this turn still empty — and `determinizeBga` of that view must
  give back the original position, up to which unseen card refills the slot.
- Every `SplendorAction` the engine can produce has an instruction and a call sequence.
- The refusals: each stop condition above has a fixture that triggers it.
- `report`: recovers a known rating from simulated results.
- Captured fixtures from live tables are added as they are collected and run through the same
  assertions.

## What only a live table can settle

There is no BGA session available while building this, so three things are written against the
public source and confirmed on the operator's first run, with `capture`:

1. how the page exposes whether a table is friendly mode;
2. where the opponent's rating is read from;
3. that the live snapshot matches the shape in the published source.

Until the first is confirmed the adapter refuses every table, which is the right way round.

## Order of work

1. The pure package: ids, snapshot schema, `toView`, memory, with the round-trip test.
2. Reader, `login`, `capture`. First live check.
3. `instruct` and `advise`. Play disclosed friendly games by hand on its advice.
4. Results and `report`.
5. `toBgaCalls` and `play`.
