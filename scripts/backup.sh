#!/usr/bin/env bash
# Daily backup of data/ (accounts, banks, property, cars, map, sounds, music, bans, reports) to another disk.
# Run by cron at 4am: 0 4 * * * /home/matthias/Github/underground-game/scripts/backup.sh
# Each day gets its own folder; files that haven't changed are hard links to the day before, so 30 days
# of backups take little more room than one. Restore: stop the service, copy a day's folder back to data/.
set -euo pipefail

GAME=/home/matthias/Github/underground-game
DEST=${BACKUP_DIR:-/mnt/data2/backups/underground}
KEEP_DAYS=30
NODE=/home/matthias/.nvm/versions/node/v25.7.0/bin/node

today=$(date +%F)
mkdir -p "$DEST"
prev=$(ls -1d "$DEST"/20??-??-?? 2>/dev/null | grep -v "/$today\$" | tail -1 || true)
tmp="$DEST/.$today.partial"
rm -rf "$tmp"

# Everything but the live database (copying it mid-write could catch it half-saved)...
rsync -a --exclude 'game.db' --exclude 'game.db-*' --exclude '*.tmp' ${prev:+--link-dest="$prev"} "$GAME/data/" "$tmp/"
# ...which gets a consistent snapshot instead, safe while the game is running.
"$NODE" -e '
  const { DatabaseSync } = require("node:sqlite");
  const [, from, to] = process.argv;
  const db = new DatabaseSync(from, { readOnly: true });
  db.exec("VACUUM INTO '\''" + to.replaceAll("'\''", "'\'''\''") + "'\''");
' "$GAME/data/game.db" "$tmp/game.db"

rm -rf "${DEST:?}/$today"
mv "$tmp" "$DEST/$today"
# Old days go.
find "$DEST" -maxdepth 1 -name '20??-??-??' -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "$(date '+%F %T') backed up to $DEST/$today ($(du -sh "$DEST/$today" | cut -f1))"
