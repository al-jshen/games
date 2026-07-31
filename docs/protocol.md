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
browser refresh or a dropped connection resumes. A version mismatch is answered with
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

- The **bag** reports composition (`counts` per colour) but not order. Both players can legitimately
  count what has been spent and compute draw odds; only the order is secret.
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

A replay is `{seed, gameId, stateVersion, options, seats, actions[]}` — a few hundred bytes that
reproduce the match exactly. It is the bug-report format, the training corpus, and the CI regression
input all at once. The seed is included only once a match is finished, since there is nothing left to
protect by then.
