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
FROM node:22-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383

# Bun runtime (copied from build stage — same image, single static binary)
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Git is required for worktree management; Claude Code CLI is the agent runtime;
# gosu is used by the entrypoint to drop privileges after fixing volume permissions
RUN apt-get update \
    && apt-get install -y --no-install-recommends git gosu ca-certificates \
    && npm install -g @anthropic-ai/claude-code@2.1.98 \
    && npm cache clean --force \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/* \
    && find / -xdev -perm -4000 -type f -exec chmod a-s {} +

LABEL org.opencontainers.image.title="Litus" \
      org.opencontainers.image.description="A web-based orchestrator for Claude Code agents" \
      org.opencontainers.image.url="https://github.com/s-gehring/litus" \
      org.opencontainers.image.source="https://github.com/s-gehring/litus" \
      org.opencontainers.image.license="AGPL-3.0-only"

WORKDIR /app

RUN groupadd --gid 1001 litus \
    && useradd --uid 1001 --gid litus --create-home litus \
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
