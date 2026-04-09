# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM oven/bun:1.3.11-slim AS build

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/
RUN bun run build:client

# Reinstall without dev dependencies
RUN rm -rf node_modules && bun install --frozen-lockfile --production

# ---- Production stage ----
FROM node:22-slim

# Bun runtime (copied from official image — single static binary)
COPY --from=oven/bun:1.3.11-slim /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Git is required for worktree management; Claude Code CLI is the agent runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="Litus" \
      org.opencontainers.image.description="A web-based orchestrator for Claude Code agents" \
      org.opencontainers.image.url="https://github.com/s-gehring/litus" \
      org.opencontainers.image.source="https://github.com/s-gehring/litus" \
      org.opencontainers.image.license="AGPL-3.0-only"

WORKDIR /app

RUN groupadd --system --gid 1001 litus \
    && useradd --system --uid 1001 --gid litus --create-home litus \
    && mkdir -p /home/litus/.litus \
    && chown -R litus:litus /home/litus/.litus

COPY --from=build --chown=litus:litus /app/node_modules node_modules/
COPY --from=build --chown=litus:litus /app/public public/
COPY --from=build --chown=litus:litus /app/src src/
COPY --from=build --chown=litus:litus /app/package.json .

USER litus

EXPOSE 3000

VOLUME ["/home/litus/.litus"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["bun", "--eval", "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "run", "start"]
