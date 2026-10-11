#!/usr/bin/env bash
# Nightly DB + encryption-key backup.
#
#   ./scripts/backup.sh
#
# Run it from cron/systemd on the host, e.g.:
#   0 3 * * *  /srv/ansnew-cloud/scripts/backup.sh >> /var/log/ansnew-backup.log 2>&1
#
# The snapshot contains the SQLite database, data/keys/* (the master keys) and
# .env — i.e. secrets. Keep the destination encrypted and OFF-BOX; a backup that
# only lives on the same disk does not survive a dead disk.
set -euo pipefail

cd "$(dirname "$0")/.."

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DEST="${BACKUP_HOST_PATH:-./backups}"

# The container writes into its own /backups, which maps to $DEST on the host.
docker compose exec -T php php bin/console.php ansnew:backup --out=/backups

# .env lives on the host (it is not mounted into the container), so add it here.
LATEST="$(ls -d "$DEST"/ansnew-backup-* 2>/dev/null | tail -1 || true)"
if [ -n "$LATEST" ] && [ -f .env ]; then
  cp .env "$LATEST/env.txt" && chmod 600 "$LATEST/env.txt"
  echo "[ansnew] .env copied into $(basename "$LATEST")"
fi

# Prune old snapshots on the host side.
if [ -d "$DEST" ]; then
  find "$DEST" -maxdepth 1 -type d -name 'ansnew-backup-*' -mtime "+${RETENTION_DAYS}" -exec rm -rf {} + 2>/dev/null || true
fi

echo "[ansnew] backup complete (retention: ${RETENTION_DAYS} days, dest: ${DEST})"
