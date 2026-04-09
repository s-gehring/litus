#!/bin/sh
set -e

# Ensure the data volume is owned by the litus user, then
# create required subdirectories. This handles bind mounts
# where the host directory may be owned by root.
chown litus:litus /home/litus/.litus
gosu litus mkdir -p /home/litus/.litus/workflows /home/litus/.litus/audit

exec gosu litus "$@"
