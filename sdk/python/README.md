# Python bot SDK

Standard library only — there is nothing to install. `gameclient/ws.py` is a small RFC 6455 client
written for this purpose, because the whole argument for a tagged-JSON protocol is that a bot is a
short file, and a `pip install` in front of that undercuts it.

Works on Python 3.8+.

## A bot in fifteen lines

```python
import random, sys
sys.path.insert(0, "sdk/python")
from gameclient import GameConnection, play

with GameConnection("ws://localhost:8787/ws") as conn:
    conn.hello()
    conn.join("ABC234", name="MyBot")
    outcome = play(conn, lambda view, actions: random.choice(actions))
    print(outcome)
```

`play` blocks until the match ends, asking the server for legal moves each turn and handing them to
your function. That server-side enumeration is the point: you never reimplement the rules.

## Doing it by hand

```python
from gameclient import GameConnection, Rejected

conn = GameConnection("ws://localhost:8787/ws")
conn.hello()
conn.create("splendor-duel", name="MyBot")
print("share this code:", conn.code)

while not conn.finished:
    conn.wait_for_turn()
    if conn.finished:
        break
    actions = conn.legal_actions()          # server-enumerated, always valid
    try:
        conn.submit(pick_one(actions, conn.view))
    except Rejected as err:
        # The rejection carried authoritative state, so we are already repaired.
        print("refused:", err.code)
```

`conn.submit` handles `expectVersion` and `clientActionId` for you, so a retry after a hiccup cannot
apply the same move twice.

## What you get

| | |
| --- | --- |
| `conn.view` | your redacted view of the game state |
| `conn.version` | current match version |
| `conn.my_turn` | whether your seat may act |
| `conn.finished` / `conn.outcome` | terminal state |
| `conn.log` | move history as redacted effect lists |
| `conn.session_token` | present it in a later `hello()` to reclaim this seat |
| `conn.legal_actions()` | every legal action, from the server |
| `conn.resync()` | fresh snapshot if you suspect a desync |

Reading `conn.view` is optional for a random bot and essential for a good one. Its shape is defined by
the game — see `SplendorView` in `packages/games/splendor-duel/src/types.ts`, and `docs/protocol.md`
for what is and is not visible to you.

## Reconnecting

```python
token = conn.session_token          # save it somewhere
...
conn = GameConnection(url)
if conn.hello(token).get("resumed"):
    conn.wait_for("sync")           # same seat, full history
```

## Included

- `bots/random_bot.py` — plays uniformly at random. Join a human's match with `--code`, or host one
  with `--create splendor-duel`.
- `bots/duel.py` — runs full bot-vs-bot matches against a live server. The fastest way to smoke-test a
  rules change, and it reports the distribution of win conditions, which is how you notice that one of
  them stopped firing.

```bash
python3 sdk/python/bots/duel.py --games 5 --p1 greedy --p2 random
```

## Notes

- Rejections are normal traffic, not errors — a `STALE` version heals itself in one round trip. But a
  *run* of them means something is genuinely wrong (a schema mismatch, say), so `play` gives up after
  12 consecutive rejections rather than spinning silently.
- There is a coarse flood guard of 400 actions per second per socket. A rate-limited action comes back
  as a `rejected` frame, not a connection error, so it flows through the same retry path.
- `create_match_http(base_url, game_id)` makes a match over plain HTTP if you want a code to exist
  before any socket opens.
