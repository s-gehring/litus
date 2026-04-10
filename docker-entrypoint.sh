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

su-exec litus mkdir -p "$DATA_DIR/workflows" "$DATA_DIR/audit"

exec su-exec litus "$@"
