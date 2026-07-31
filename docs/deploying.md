# Deploying

One process, one port, no native dependencies. The image is `node:24-alpine`, runs as a non-root user,
and stores replay logs in a volume.

```bash
SESSION_SECRET="$(openssl rand -base64 32)" docker compose up -d --build
curl -s localhost:8787/healthz
```

## Behind Caddy

**WebSockets need no configuration.** Caddy's `reverse_proxy` detects the `Upgrade` header and
proxies the connection as a stream, and it has no short read timeout to trip over. This is the main
practical reason to prefer it here — nginx defaults `proxy_read_timeout` to 60 s, which silently kills
the socket of a player who is thinking, and you only find out from a confused opponent.

```
games.jshen.net {
    encode gzip
    reverse_proxy games_server:8787
    tls {
      issuer acme {
        dns cloudflare {$CLOUDFLARE_API_TOKEN}
        disable_http_challenge
        disable_tlsalpn_challenge
      }
    }
}
```

Bring it up:

```bash
SESSION_SECRET="$(openssl rand -base64 32)" docker compose up -d --build
```

`docker-compose.yml` joins the external network `caddy_net` and publishes no host port, so the
container is reachable only from the proxy network. Create that network once if it does not exist
(`docker network create caddy_net`) and attach your Caddy container to it too.

Three things to get right:

1. **The port is 8787**, not whatever another service on your box uses. Either point Caddy at
   `games_server:8787`, or set `GAMES_PORT` and use that on both sides. The container's `PORT` and the
   proxy entry have to agree, and a mismatch shows up only as a 502.
2. **The hostname is the container name.** `docker-compose.yml` sets `container_name: games_server`,
   which is what makes `reverse_proxy games_server:8787` resolve. Rename one and rename both.
3. **Caddy and this container must share the network.** If Caddy lives in its own compose project,
   attach it to `caddy_net` as an external network there as well; otherwise Caddy cannot resolve the
   name at all.

Replay logs land in `./data` next to the compose file (bind-mounted to `/data`), which `.gitignore`
excludes. Back that directory up if you care about match history.

`encode gzip` is fine to leave on; it applies to ordinary HTTP responses and does not touch WebSocket
frames. The server disables `permessage-deflate` deliberately — frames are a few KB, so compressing
them costs more CPU than it saves bytes, and Node's zlib fragments memory under concurrency.

### If the DNS record is proxied through Cloudflare

Works as-is. Cloudflare supports WebSockets on all plans and idles them out at roughly 100 seconds;
the server sends a WebSocket ping every 25 s, so an idle game does not get reaped. You do not need to
change the heartbeat.

You are using the DNS-01 challenge already, so a proxied (orange-cloud) record is fine for
certificates too.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | random per boot | **Set this.** Reconnect tokens are HMACs over it, so a random one means every restart evicts players from live matches. |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |
| `DATA_DIR` | `/data` | Match records. Bind-mounted, so back this up if you want history. |
| `REPLAY_STORE` | `sqlite` | `sqlite` (`$DATA_DIR/games.db`), `jsonl` (append-only file), or `memory`. |
| `WEB_ROOT` | `/app/web` | Set to empty to serve API and WebSocket only. |

## Operating it

- `GET /healthz` — `{ok, rooms, uptime}`. The image has a `HEALTHCHECK` wired to it.
- `GET /metrics` — live room counts by status, open connections, RSS. Worth graphing: a slow room leak
  is invisible until the process runs out of memory.
- Match records live in `$DATA_DIR/games.db` (plus the WAL sidecar files) at a few KB each, upserted
  after every move. `GET /api/matches?limit=50` lists them; `GET /api/matches/:code/replay` returns one
  in full. Back up the directory to keep history — SQLite is fine to copy while stopped, and
  `sqlite3 games.db ".backup out.db"` is the safe way while running.
- `SIGTERM` flushes every match in progress, then closes sockets and the listener. `tini` in the image
  forwards the signal, so `docker compose down` and a redeploy are both graceful.

## Scaling

Don't, until you need to. A single Node process handles thousands of concurrent turn-based rooms
without noticing. Live matches are in memory behind a `RoomRegistry` interface, so if you ever
genuinely need more than one process, that is the seam to replace — and you would also need sticky
sessions, since a seat's sockets must reach the process holding its room.
