# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.3.11

# ---- Build stage ----
FROM oven/bun:${BUN_VERSION}-slim AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/
RUN bun run build:client

# Reinstall without dev dependencies
RUN rm -rf node_modules && bun install --frozen-lockfile --production

# ---- Production stage ----
FROM oven/bun:${BUN_VERSION}-slim

# Node.js is required at runtime for Claude Code CLI (npm package).
# git for worktree management; gosu for privilege dropping in the entrypoint.
# curl for downloading gh + claude on first start (see docker-entrypoint.sh).
# gh and claude are NOT shipped in the image — the entrypoint installs them on
# first boot so the end-user accepts the respective licenses themselves.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git gosu ca-certificates curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* /tmp/*

LABEL org.opencontainers.image.title="Litus" \
      org.opencontainers.image.description="A web-based orchestrator for Claude Code agents" \
      org.opencontainers.image.url="https://github.com/s-gehring/litus" \
      org.opencontainers.image.source="https://github.com/s-gehring/litus" \
      org.opencontainers.image.license="AGPL-3.0-only"

WORKDIR /app

RUN groupadd -g 1001 litus \
    && useradd -u 1001 -g litus -m -d /home/litus litus \
    && mkdir -p /home/litus/.litus \
    && chown -R litus:litus /home/litus/.litus

COPY --from=build --chown=litus:litus /app/node_modules node_modules/
COPY --from=build --chown=litus:litus /app/public public/
COPY --from=build --chown=litus:litus /app/src src/
COPY --from=build --chown=litus:litus /app/package.json .
COPY --from=build --chown=litus:litus /app/tsconfig.json .
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/
COPY --chown=litus:litus LICENSE.md .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["bun", "--eval", "fetch('http://localhost:'+(process.env.PORT||'3000')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "run", "start"]
