#!/bin/sh
set -e

DATA_DIR=/home/litus/.litus

# Fix volume ownership only when needed (e.g. fresh bind mount owned by root).
# Skipping the recursive chown when ownership is already correct avoids a slow
# walk on large data directories.
# Uses ls -dn for POSIX-portable numeric owner:group lookup.
dir_owner=$(ls -dn "$DATA_DIR" | awk '{print $3":"$4}')
if [ "$dir_owner" != "1001:1001" ]; then
    chown -R litus:litus "$DATA_DIR"
fi

gosu litus mkdir -p "$DATA_DIR/workflows" "$DATA_DIR/audit"

# ── Install tools on first boot ────────────────────────────────────
# gh and claude are not shipped in the image for licensing reasons.
# They are downloaded on first container start so the end-user accepts
# the respective licenses themselves.

if ! command -v gh >/dev/null 2>&1; then
    echo "Installing GitHub CLI..."
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  GH_ARCH="amd64" ;;
        aarch64) GH_ARCH="arm64" ;;
        *)       echo "ERROR: Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    GH_VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest \
        | sed -n 's/.*"tag_name": "v\([^"]*\)".*/\1/p')
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" \
        | tar xz -C /tmp
    install /tmp/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh /usr/local/bin/gh
    rm -rf /tmp/gh_*
    echo "Installed gh ${GH_VERSION}"
fi

if ! command -v claude >/dev/null 2>&1; then
    echo "Installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code 2>&1 | tail -1
fi

# ── Auth validation ─────────────────────────────────────────────────
CLAUDE_DIR="/home/litus/.claude"
GH_CONFIG="/home/litus/.config/gh"

# Claude Code: need ANTHROPIC_API_KEY or a mounted ~/.claude session
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ ! -d "$CLAUDE_DIR" ]; then
    echo "WARNING: No Claude Code credentials found."
    echo "  Either set ANTHROPIC_API_KEY or bind-mount ~/.claude to $CLAUDE_DIR"
fi

# GitHub CLI: need GH_TOKEN or a mounted gh config
if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ] && [ ! -d "$GH_CONFIG" ]; then
    echo "ERROR: No GitHub CLI credentials found."
    echo "  Set GH_TOKEN, GITHUB_TOKEN, or bind-mount gh config to $GH_CONFIG"
    exit 1
fi

exec gosu litus "$@"
