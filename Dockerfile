# syntax=docker/dockerfile:1.7
# Multi-stage build. Uses node:22-slim (debian) instead of alpine so
# better-sqlite3 prebuilt binaries work without compiling from source.

FROM node:22-slim AS builder
WORKDIR /app

# Build deps for native modules (better-sqlite3 prebuilds usually work,
# but keep build-essential as a fallback for arm64 / unusual hosts).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

# ─── Runtime image ────────────────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 sherlock \
    && useradd  --system --uid 10001 --gid sherlock --no-create-home --shell /usr/sbin/nologin sherlock \
    && mkdir -p /var/lib/sherlock-ops \
    && chown sherlock:sherlock /var/lib/sherlock-ops

COPY --from=builder --chown=sherlock:sherlock /app/node_modules ./node_modules
COPY --from=builder --chown=sherlock:sherlock /app/dist ./dist
COPY --from=builder --chown=sherlock:sherlock /app/package.json ./package.json

ENV NODE_ENV=production \
    SHERLOCK_AUDIT_DB=/var/lib/sherlock-ops/audit.sqlite

USER sherlock

# WSS agent endpoint
EXPOSE 8787

# tini handles SIGTERM cleanly so the control plane can shut down agents + audit DB.
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
