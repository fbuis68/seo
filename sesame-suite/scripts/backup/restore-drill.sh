#!/usr/bin/env bash
# Exercice de restauration automatisé — P0-06 BACKUP-005. Restaure la
# dernière sauvegarde (ou celle donnée en argument) dans l'instance
# Postgres ISOLÉE dédiée aux exercices (deploy/backup/docker-compose.drill.yml,
# jamais la base de prod, jamais le même réseau/volume), vérifie le schéma
# et produit un rapport JSON mesurant le RTO réel. À exécuter
# périodiquement (sesame-restore-drill.timer) et à la demande.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_env BACKUP_OFFSITE_DIR BACKUP_ENCRYPTION_KEY DRILL_PGHOST DRILL_PGPORT DRILL_PGUSER

backup_file="${1:-}"
if [ -z "$backup_file" ]; then
  backup_file="$(ls -1t "$BACKUP_OFFSITE_DIR"/sesame_*.dump.enc 2>/dev/null | head -1 || true)"
fi
if [ -z "$backup_file" ] || [ ! -f "$backup_file" ]; then
  alert_failure drill_no_backup_found "aucune sauvegarde trouvée dans $BACKUP_OFFSITE_DIR"
  exit 1
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
drill_db="sesame_drill_${ts}"
report_dir="${BACKUP_STAGING_DIR:-/tmp}"
mkdir -p "$report_dir"
report_file="${report_dir}/drill_report_${ts}.json"
tmp_dump="$(mktemp)"

cleanup() {
  rm -f "$tmp_dump"
  PGPASSWORD="${DRILL_PGPASSWORD:-}" dropdb -h "$DRILL_PGHOST" -p "$DRILL_PGPORT" -U "$DRILL_PGUSER" "$drill_db" 2>/dev/null || true
}
on_err() {
  alert_failure drill_failed "échec ligne ${1} (commande: ${2}), backup=${backup_file}"
  cleanup
  exit 1
}
trap 'on_err "$LINENO" "$BASH_COMMAND"' ERR
trap cleanup EXIT

log_json info drill_start ts="$ts" backup_file="$backup_file"

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -in "$backup_file" -out "$tmp_dump"

PGPASSWORD="${DRILL_PGPASSWORD:-}" createdb -h "$DRILL_PGHOST" -p "$DRILL_PGPORT" -U "$DRILL_PGUSER" "$drill_db"

start_ts=$(date +%s)
PGPASSWORD="${DRILL_PGPASSWORD:-}" pg_restore -h "$DRILL_PGHOST" -p "$DRILL_PGPORT" -U "$DRILL_PGUSER" \
  --no-owner --dbname "$drill_db" -j 4 "$tmp_dump"
end_ts=$(date +%s)
duration=$((end_ts - start_ts))

tables_found="$(PGPASSWORD="${DRILL_PGPASSWORD:-}" psql -h "$DRILL_PGHOST" -p "$DRILL_PGPORT" -U "$DRILL_PGUSER" -d "$drill_db" -tAc \
  "select count(*) from information_schema.tables where table_schema='public';")"

if [ "$tables_found" -lt 1 ]; then
  alert_failure drill_empty_restore "0 table restaurée depuis ${backup_file}"
  exit 1
fi

cat > "$report_file" <<EOF
{"ts":"$ts","backup_file":"$backup_file","restore_seconds":$duration,"tables_found":$tables_found,"status":"ok"}
EOF

trap - ERR
log_json info drill_ok ts="$ts" backup_file="$backup_file" restore_seconds="$duration" tables_found="$tables_found"
cat "$report_file"
