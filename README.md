# games

A small self-hosted platform for playing turn-based board games with someone over the web. Pick a
game, create a match, get a short code, send it to a friend — they paste it and land in the room with
you.

First game: **Splendor Duel**. A trivial tic-tac-toe is included too, because an interface with one
implementor is a guess rather than an abstraction.

Bots are first-class: they speak the same WebSocket protocol the browser does, and the server will
enumerate legal moves on request so a bot never has to reimplement the rules.

## Quick start

```bash
npm install
npm run cards        # fetch + validate the Splendor Duel card data (once)
npm run dev          # http://localhost:5173
```

Open two browser windows, create a match in one, paste the code in the other.

```bash
npm test             # rules invariants, redaction, replay, wire schema, live sockets, SSR renders
npm run test:e2e     # real headless browser, two players, a full game
npm run typecheck
npm run lint
npm run bench        # latency and throughput, measured against a real server
npm run verify:spiral   # re-derive the board's fill order from the printed art
```

`npm run test:e2e` builds the web app, serves it from the real Node server, and drives two
independent browser contexts through Chromium — pairing by code, taking tokens, buying cards,
resolving pending decisions, refreshing mid-match, and playing tic-tac-toe to a win. Requires
`npx playwright install chromium` once.

### Play against a bot

```bash
pip install 'websockets>=13'                                   # recommended
python3 sdk/python/bots/random_bot.py --create splendor-duel   # prints a code to join
python3 sdk/python/bots/random_bot.py --code ABC234            # or join your match
python3 sdk/python/bots/duel.py --games 5                      # bot vs bot, full games
```

The SDK uses `websockets` when it is installed and falls back to a bundled standard-library client
otherwise, so the examples run either way. Both paths are exercised against a live server.

A move costs **~0.15 ms** round trip on the same host, and the server does ~0.05 ms of work per move.
One socket is capped at 1000 actions/sec (`ACTION_RATE_LIMIT`) as a flood guard. Over the internet,
RTT dominates everything: at 20 ms RTT expect ~50 moves/sec. For training, drive the engine in-process
instead — the same code without a socket runs at ~90,000 moves/sec. `npm run bench` and
`docs/protocol.md` have the full numbers.

## Deploying

One process, one port, no native dependencies.

```bash
SESSION_SECRET="$(openssl rand -base64 32)" docker compose up -d --build
```

Then reverse-proxy `127.0.0.1:8787` however you like. **Set `SESSION_SECRET` to something stable** —
reconnect tokens are HMACs over it, so a random per-boot secret means every restart drops players out
of their matches.

Behind a Caddy container on a shared Docker network:

```
games.example.net {
    encode gzip
    reverse_proxy games_server:8787
}
```

WebSockets need no extra Caddy configuration, and unlike nginx there is no 60-second read timeout to
trip over. `docs/deploying.md` covers the rest, including Cloudflare-proxied DNS.

`/healthz` and `/metrics` are there for monitoring; a slow room leak is invisible until OOM.

## Layout

```
packages/protocol/            wire frames + zod schemas + PROTOCOL_VERSION
packages/engine/              GameModule interface, Redacted<>, seeded PRNG, match core
packages/games/splendor-duel/ rules engine (headless) + ./ui (SVG board)
packages/games/tic-tac-toe/   the canary that keeps the interface honest
packages/client-sdk/          WS client: reconnect, prediction, typed submit. Used by web AND bots.
apps/server/                  HTTP + WebSocket, rooms, sessions, replay log
apps/web/                     Vite + React shell: lobby, room codes, move log
sdk/python/                   zero-dependency bot client + example bots
tools/scrape-cards/           builds and validates the card data
tools/verify-spiral/          re-derives the board spiral from the printed art
e2e/                          Playwright: two browsers, real matches
docs/                         protocol.md · splendor-duel-rules.md · adding-a-game.md · deploying.md
```

Layering is enforced by lint rather than by convention, because convention decays: game modules may
import `@games/engine` and browser-safe libraries only — never `node:*`, never the transport, never
`apps/*`. That is what lets the same reducer run in the browser.

Adding a game is one package plus two lines. See `docs/adding-a-game.md`.

## How it works

**Low latency comes from one decision.** Game modules are pure, isomorphic TypeScript, so the browser
runs the *same* reducer the server does. Your own move renders at 0 ms and then reconciles with the
server's snapshot. A network round trip is the floor for anything your opponent sees, and no framework
beats that — but your own moves need not wait for it.

Prediction only ever applies what is genuinely knowable. Taking tokens is exact. Replenishing the
board and drawing from a deck depend on hidden information, so they are not predicted at all rather
than guessed and corrected — a card that appears and then changes into a different card reads as a
bug, and worse, teaches players that the client sometimes knows things it should not. A test asserts
that every predicted state matches the server exactly.

**Hidden information is a type, not a habit.** The truth state and the wire view are different types;
`redactFor` is the only function that can produce a view, and it returns a branded `Redacted<T>` which
the transport is the only consumer of. `send(socket, { view: state })` does not compile. Tests assert
both that no secret appears in a view and that views are *byte-stable* under permutation of hidden
state — without that second property, payload size alone leaks information.

**Matches are stored as `{seed, actions[]}`**, a few KB, not as snapshots. That single artifact gives
exact bug reproduction, the in-UI move log, and a CI regression corpus. It only works because the
reducer is deterministic, which is why `Math.random` and `Date.now` are lint errors inside game
packages.

They go into SQLite (`$DATA_DIR/games.db`) via Node's built-in `node:sqlite`, so there is still no
native module and no build toolchain in the image. A record is upserted after **every move**, not just
when a match ends — otherwise a crash or a redeploy would silently discard every game in progress,
which with `restart: unless-stopped` is a routine occurrence. Live matches are also flushed on
`SIGTERM`. `GET /api/matches` lists recent games; `GET /api/matches/:code/replay` returns a finished
one in full.

**Reconnecting is expected.** Session tokens are stateless HMACs kept in `localStorage`, so a refresh
or a dropped tunnel reclaims the same seat, and a server restart with the same secret still honours
them. Multiple sockets per seat are allowed rather than kicking the old one, which makes refresh races
a non-issue. A disconnect pauses the match; it is never a forfeit.

Concurrency is two fields on every action: `expectVersion`, so you cannot act on a position you have
not seen, and `clientActionId`, so a double-click or a reconnect-and-resend cannot buy the same card
twice.

## Splendor Duel specifics

The board includes a turn guide that lists what you can do right now — derived from the same
legal-move list that drives the clickable affordances, so it cannot describe a move the server would
refuse — plus a rules cheatsheet, which opens automatically the first time you play.

**The whole match view fits one screen.** Card and board sizes are measured from the space actually
available rather than clamped to viewport height, so they use spare width too — cards run 86–151px and
the token board 260–530px depending on the window. Since there is no artwork to leave room for, the
card faces are laid out to fill: large prestige numbers, crowns, bonus gems and costs, and royals get
their own layout because they carry only two attributes.

The turn guide lives in the sidebar rather than above the board. That is not cosmetic: it is ~150px
taller on your turn than while waiting, and in the board column that swing resized every card on every
move. Browser tests assert zero page overflow at four laptop viewports, in the states that
add the most content — your turn with the guide open, a card panel open, a pending decision — and
also that nothing is clipped by an ancestor, which is a different failure that bounding-box checks
miss entirely. Below roughly 900px wide or 620px tall the page gets its scroll back, because no
amount of scaling fits a board on a phone.

The card data is generated, not hand-typed: `npm run cards` scrapes the 71 cards and refuses to write
the file unless a battery of whole-deck totals checks out (92 prestige, 28 crowns, 5 double-bonus
cards, and a known-bad card that three published fan datasets get wrong). It was cross-checked
field-by-field against the official BoardGameArena implementation.

Cards are drawn as SVG from that data rather than shipped as images, so the whole app is about 97 KB
gzipped with no image requests, stays crisp at any zoom, and does not redistribute anyone's artwork.

`docs/splendor-duel-rules.md` is the spec the reducer was written against. Two things there are worth
knowing:

- The board's spiral fill order is not in any text source, so it was measured from the printed board
  art by a reproducible script (`npm run verify:spiral`). A test also proves the orientation is only
  a *cosmetic* choice: all eight valid outward spirals are symmetries of each other, and token-line
  legality is invariant under those symmetries, so implementations that disagree about it are playing
  relabellings of the same game.
- **A player can legally end up with no legal move.** The usual proof that this is impossible assumes
  ≤10 tokens per player, but spending privilege scrolls legally takes you above that mid-turn. The
  official rules do not cover it, so there is a narrowly-scoped `pass` that provably unsticks the
  position within one turn each.

## Licence and attribution

Splendor Duel is designed by Marc André and Bruno Cathala and published by Space Cowboys. This is an
unaffiliated hobby implementation for private play. Card *statistics* are unprotectable game facts and
are generated from public sources; card *artwork* belongs to Space Cowboys/Asmodee and is deliberately
not used or redistributed here — every card you see is drawn from data.
