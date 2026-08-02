# Wire protocol

One JSON object per WebSocket frame, tagged with `t`. This document **is** the bot API — there is no
separate one, because a bot is not a special kind of client, it is a client that happens to be a
script. The web app speaks exactly this.

Endpoint: `ws://HOST/ws` (`wss://` behind TLS). Same origin and port as the web app, so there is no
CORS preflight and nothing extra for a reverse proxy to route.

Current `PROTOCOL_VERSION`: **1**. Defined in `packages/protocol/src/index.ts`, which is the
authoritative schema; this file is prose over it.

## Why it looks like this

- **JSON, not msgpack or a binary schema.** Frames are 2–6 KB and one turn happens every several
  seconds, so compression and binary framing would save nothing you can perceive while costing the
  "a bot in any language is a short file" property. `permessage-deflate` is disabled on both ends.
- **Full snapshots, not deltas.** A delta would have to be diffed over *redacted* views or it leaks
  secrets through the patch, and it adds a second apply path that can desync from the first. Desync
  bugs are the worst class of bug here.
- **Rejections carry state.** A refused action comes back with the authoritative snapshot attached,
  so a client heals in the same round trip instead of having to ask.

## Minimum viable bot

```
1. connect to ws://HOST/ws
2. -> {"t":"hello","protocolVersion":1}
   <- {"t":"hello_ok", ...}
3. -> {"t":"join","code":"ABC234"}          (or "create" with a gameId)
   <- {"t":"joined","seat":1,"sessionToken":"..."}
   <- {"t":"sync","snapshot":{...}}
4. loop: when snapshot.actors contains your seat,
   -> {"t":"legalActions"}
   <- {"t":"legal","actions":[...]}
   -> {"t":"action","expectVersion":N,"clientActionId":"unique","action":<one of them>}
   <- {"t":"applied", ...}   or   {"t":"rejected", ...}
5. stop when snapshot.outcome.status == "over"
```

`sdk/python/` is that loop, written out, with no third-party dependencies.

## Client → server

### `hello`
```json
{ "t": "hello", "protocolVersion": 1, "sessionToken": "optional" }
```
Must be the first frame. A `sessionToken` from a previous `joined` reclaims that seat — this is how a
browser refresh, a dropped connection, or a return days later resumes. The match does not have to be
resident in memory: if it has been evicted, or the server has restarted, the record is loaded and the
actions replayed to rebuild it before the token is checked. Tokens do not expire, so the only thing
that invalidates one is a change of `SESSION_SECRET`. A version mismatch is answered with
`error{code:"PROTOCOL_MISMATCH"}` and the client should reload; without this check a deploy silently
breaks every open tab.

Send the token in this frame, never in the URL query string, where it would land in proxy logs.

### `create`
```json
{ "t": "create", "gameId": "splendor-duel", "name": "optional", "options": {} }
```
Creates a match and seats you in it. Replies `joined`. See `GET /api/games` for valid ids.

Splendor Duel options: `{ "maxTurnsWithoutPurchase": 0 }` — a non-official stall guard, off by
default. See `docs/splendor-duel-rules.md`.

### `join`
```json
{ "t": "join", "code": "ABC234", "name": "optional" }
```
Codes are 6 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ` and are normalised on arrival, so
lowercase and dashes are fine. Replies `joined`, or `error` with `NO_SUCH_MATCH` / `MATCH_FULL`.

### `action`
```json
{ "t": "action", "expectVersion": 7, "clientActionId": "bot-1-42", "action": { "t": "..." } }
```
- `expectVersion` — the version you believe is current. A mismatch is rejected with `STALE` rather
  than applied to a position you have not seen.
- `clientActionId` — your idempotency key, unique per action. Resending the same id returns the
  stored result instead of applying twice, which is what makes a retry after a network hiccup safe.

The acting seat is taken from your authenticated session and checked against `actors`. It is never
read off the wire, so there is no way to submit as your opponent.

### `legalActions`
```json
{ "t": "legalActions" }
```
Replies `legal` with every action your seat may take right now. **This is the affordance that makes
non-TypeScript bots practical** — you never have to reimplement the rules to know what is legal.

`truncated: true` means the list was capped and is not exhaustive. It only happens where the action
space is combinatorial (Splendor Duel caps how many gold-substitution variants of a purchase it
enumerates). Anything valid is still accepted, so construct your own if you want one that is not
listed.

### `resync`
```json
{ "t": "resync" }
```
Replies `sync` with a fresh snapshot and the whole move log.

### `ping`
```json
{ "t": "ping" }
```
Replies `pong`. Optional — the server also sends WebSocket-level pings every 25 s and terminates
sockets that stop answering, which is what stops a half-open connection holding a seat forever.

## Server → client

### `hello_ok`
```json
{ "t": "hello_ok", "protocolVersion": 1, "serverTime": 1730000000000,
  "games": [{ "id": "splendor-duel", "title": "Splendor Duel", "blurb": "...",
              "minPlayers": 2, "maxPlayers": 2, "estMinutes": [20, 35] }],
  "resumed": true }
```
`resumed` is present only when a `sessionToken` was accepted; a `sync` follows immediately.

### `joined`
```json
{ "t": "joined", "matchId": "...", "code": "ABC234", "gameId": "splendor-duel",
  "seat": 0, "sessionToken": "..." }
```
Store `sessionToken`. Presenting it in a later `hello` reclaims this seat.

### `sync`
```json
{ "t": "sync", "snapshot": { ... }, "log": [ { "version": 1, "seat": 0, "effects": [...] } ] }
```
Authoritative reset. Drop any local prediction rather than trying to rebase it. `log` is the full
redacted history, so a reconnecting client can render moves it never saw.

### `applied`
```json
{ "t": "applied", "snapshot": { ... }, "seat": 0, "clientActionId": "bot-1-42",
  "effects": [ { "k": "tookTokens", "seat": 0, "cells": [6,7], "colors": ["blue","red"] } ] }
```
Sent to everyone in the room, each with their own redacted snapshot and effects. `clientActionId` is
echoed **only to the submitter** — the other players have no pending move to retire.

`effects` say what *happened*, as opposed to the snapshot's what *is*. Diffing two boards to work out
which token moved is miserable and ambiguous, so animations, sound, and the move log all read these.
They are redacted too: a card only you may see arrives as `cardId: null` for your opponent.

### `rejected`
```json
{ "t": "rejected", "clientActionId": "bot-1-42", "code": "STALE",
  "message": "...", "snapshot": { ... } }
```
Codes: `STALE`, `NOT_YOUR_TURN`, `ILLEGAL_ACTION`, `BAD_ACTION`, `MATCH_OVER`, `RATE_LIMITED`.

The snapshot is current, so you are already repaired — re-read `actors` and `version` and try again.
A *run* of rejections means something is genuinely wrong (a schema mismatch, say) rather than a race;
the Python SDK gives up after 12 consecutive ones instead of spinning forever.

### `legal`
```json
{ "t": "legal", "version": 7, "actions": [ ... ], "truncated": false }
```

### `presence`
```json
{ "t": "presence", "players": [ { "seat": 0, "name": "Ann", "connected": true, "you": true } ] }
```
A disconnect **pauses** the match; it is never a forfeit. In a turn-based game a drop is almost
always a closed laptop lid or a tunnel.

### `over`
```json
{ "t": "over", "snapshot": { ... } }
```
`snapshot.outcome` is `{ "status": "over", "winners": [0], "reason": "prestige", "scores": [21, 12] }`.
`winners: []` means a draw.

### `error`
```json
{ "t": "error", "code": "NOT_IN_MATCH", "message": "..." }
```
Connection-level problems, as opposed to a refused action.

## Snapshot

```json
{
  "matchId": "...", "code": "ABC234", "gameId": "splendor-duel",
  "version": 7,
  "view": { },
  "actors": [0],
  "outcome": { "status": "active" },
  "players": [ { "seat": 0, "name": "Ann", "connected": true, "you": true } ]
}
```

`view` is **redacted for you specifically**, and its shape is defined by the game. For Splendor Duel
see `SplendorView` in `packages/games/splendor-duel/src/types.ts`. Two details in that redaction are
worth knowing because they are deliberate rather than accidental:

- The **bag** reports a `total` and nothing else. Its composition is recoverable from the rest of the
  view — board plus both players plus bag is always the same 25 tokens — but working that out is part
  of playing, and `replenish` draws from the bag blind, so publishing it would hand a real edge to
  whoever is not keeping track.
- **Decks** collapse to a count, and an opponent's reserved cards appear as `{"hidden": true}` unless
  they were taken from the face-up pyramid — in which case the opponent genuinely saw them. Slot
  count is always preserved, because holding three reservations blocks further ones and that is
  public.

The shuffle **seed** never appears in any view. Anyone holding it could compute every future shuffle,
so it is as sensitive as the deck order itself.

## HTTP endpoints

Enough for `curl`, a health check, and fetching replays. Everything else is on the socket.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | `{ok, rooms, uptime}` |
| `GET` | `/metrics` | live room counts, connections, RSS |
| `GET` | `/api/games` | game catalog |
| `POST` | `/api/matches` | `{gameId, options?}` → `{code, matchId, gameId}` |
| `GET` | `/api/matches` | recent matches, newest first (`?limit=50`). Summaries only — never a seed. |
| `GET` | `/api/matches/:code` | public room info, for prefetching before connecting |
| `GET` | `/api/matches/:code/replay` | full record of a **finished** match |

Creating over HTTP means the code exists before any socket opens, so you can make a match with
`curl`, hand out the code, and connect later.

```bash
curl -sX POST localhost:8787/api/matches \
  -H 'content-type: application/json' \
  -d '{"gameId":"splendor-duel"}'
# {"code":"K7M2QP","matchId":"...","gameId":"splendor-duel"}
```

A replay is `{seed, gameId, stateVersion, options, seats, actions[]}` — a few KB that reproduce the
match exactly. Records are upserted into SQLite after every move, so an interrupted match is still
retrievable and still replays. It is the bug-report format, the training corpus, and the CI regression
input all at once. The seed is included only once a match is finished, since there is nothing left to
protect by then.

## Resuming a match

A match is durable from the moment both seats are filled — before anyone has moved — and is rewritten
after every move. What is stored is the seed plus the action log, not a snapshot, so resuming means
replaying: the rebuilt state is byte-identical, hidden information included, and the move log comes
back with it because the effects fall out of the replay.

Two ways back in:

- **`hello` with a `sessionToken`.** The normal path, and the only one that gets you a seat in a match
  that already has two players.
- **`join` with a code.** Rebuilds the match too, but a resumed match is rebuilt *full*, so this
  answers `error{code:"MATCH_FULL"}` unless a seat is genuinely open. Losing your token means losing
  your seat; that is deliberate, since the code is the only other thing identifying you and it is
  meant to be shareable.

Two things a resume does not carry over:

- **Idempotency keys.** The `clientActionId` cache is per-room and does not survive eviction, so an
  action resent across a resume could apply twice. `expectVersion` is what stops it: a resend carries
  the version from before the break and is rejected as `STALE`. Clients drop pending actions on `sync`
  anyway.
- **A match whose rules have changed.** If a game module's `stateVersion` no longer matches the
  record's, the server refuses to resume rather than replaying old actions through new rules, which
  would produce a plausible and wrong board. That reads as `NO_SUCH_MATCH`.

## Performance

Measured with `npm run bench`, on an M-series laptop over loopback. Treat these as a ceiling: on a
real network the round trip is RTT *plus* these numbers, and RTT wins by two orders of magnitude.

| | |
| --- | --- |
| `action` → `applied`, round trip | **0.15 ms** p50, 0.22 ms p95, 0.45 ms p99 |
| `legalActions` → `legal`, round trip | 0.06 ms p50 |
| Redacted view | ~2.1 KB of JSON; ~4.5 KB received per move across both clients |
| Server work per move | ~0.05 ms — reducer 0.010, redact both seats 0.006, serialise 0.006, SQLite upsert 0.035 |
| Rules engine alone, in-process | ~90,000 moves/sec |
| Aggregate throughput | ~6,800 moves/sec with SQLite, ~10,000 with `REPLAY_STORE=memory` |

Two things dominate in practice:

**The per-socket flood guard.** One socket is capped at `ACTION_RATE_LIMIT` actions per second
(default 1000). It exists to stop a runaway loop wedging a single-threaded process, not to pace a bot
— a move costs the server ~0.05 ms, so even the default leaves one socket using a few percent of
capacity. Exceeding it returns `rejected{code:"RATE_LIMITED"}`, which is retryable.

**Round-trip time, once you are not on localhost.** A bot's move is one round trip if it computes
legal moves itself, or two if it asks the server:

| Deployment | One round trip | Moves/sec, computing legal moves locally | Moves/sec, using `legalActions` |
| --- | --- | --- | --- |
| Same host | ~0.15 ms | capped at 1000 | capped at 1000 |
| Same LAN | ~0.5 ms | ~1500 → capped at 1000 | ~750 |
| Internet, 20 ms RTT | ~20 ms | ~50 | ~25 |
| Internet, 80 ms RTT | ~80 ms | ~12 | ~6 |

Latency grows linearly with concurrency while aggregate throughput stays flat — 48 simultaneous
matches sit at 6.6 ms p50 and still total ~6,700 moves/sec. That is queueing on a single-threaded
event loop, not the server getting slower.

**If you are training a bot, do not go over the socket at all.** Drive the game module in-process:
`createMatch` and `step` from `@games/engine` with `legalActions`/`apply` from the game package give
~90,000 moves/sec, against the exact same code the server runs. The socket is for playing; the engine
is for searching.
