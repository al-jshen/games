# Multi-stage build for a small Alpine runtime image.
#
# The server has no native dependencies on purpose -- replays are append-only JSONL rather than
# SQLite -- so the runtime stage needs no build toolchain, and the whole thing is one process
# listening on one port. Terminate TLS and reverse-proxy it however you like.

# ---------------------------------------------------------------- build
FROM node:24-alpine AS build
WORKDIR /app

ENV npm_config_audit=false npm_config_fund=false

# Copy manifests first so `npm ci` is cached independently of source changes.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/client-sdk/package.json packages/client-sdk/
COPY packages/games/splendor-duel/package.json packages/games/splendor-duel/
COPY packages/games/tic-tac-toe/package.json packages/games/tic-tac-toe/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/scrape-cards/package.json tools/scrape-cards/
COPY tools/verify-spiral/package.json tools/verify-spiral/
RUN npm ci --ignore-scripts

COPY . .

# Typecheck and build the server, then bundle the web app.
RUN npm run typecheck && npm run --workspace @games/web build

# Drop dev dependencies so only what the server actually needs is carried forward.
RUN npm prune --omit=dev --ignore-scripts

# ---------------------------------------------------------------- runtime
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    WEB_ROOT=/app/web

RUN apk add --no-cache tini \
    && mkdir -p /data \
    && chown -R node:node /data

# Only the built server, its runtime dependencies, and the static web bundle.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/web/dist ./web

USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards signals, so SIGTERM reaches the graceful shutdown handler.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/dist/main.js"]
