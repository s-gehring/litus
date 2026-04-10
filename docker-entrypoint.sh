#!/bin/sh
set -e

DATA_DIR=/home/litus/.litus

# Fix volume ownership only when needed (e.g. fresh bind mount owned by root).
# Skipping the recursive chown when ownership is already correct avoids a slow
# walk on large data directories.
if [ "$(stat -c '%u:%g' "$DATA_DIR")" != "1001:1001" ]; then
    chown -R litus:litus "$DATA_DIR"
fi

gosu litus mkdir -p "$DATA_DIR/workflows" "$DATA_DIR/audit"

exec gosu litus "$@"
