#!/usr/bin/env bash
# Sauvegarde chiffrée de la base Sesame Suite — P0-06 BACKUP-001/002/004.
# Variables requises : voir docs/backup-restore.md. Prévu pour tourner sur
# l'hôte (jamais dans le conteneur applicatif) via sesame-backup.timer.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_env PGUSER PGDATABASE BACKUP_STAGING_DIR BACKUP_OFFSITE_DIR BACKUP_ENCRYPTION_KEY

ts="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_STAGING_DIR" "$BACKUP_OFFSITE_DIR"
dump_file="${BACKUP_STAGING_DIR}/sesame_${ts}.dump"
enc_file="${BACKUP_STAGING_DIR}/sesame_${ts}.dump.enc"
meta_file="${BACKUP_STAGING_DIR}/sesame_${ts}.meta.json"

on_err() {
  alert_failure backup_failed "échec ligne ${1} (commande: ${2})"
  rm -f "$dump_file" "$enc_file" "$meta_file"
  exit 1
}
trap 'on_err "$LINENO" "$BASH_COMMAND"' ERR

log_json info backup_start ts="$ts" db="$PGDATABASE"

pg_dump_run "$dump_file"

sha_plain="$(sha256sum "$dump_file" | awk '{print $1}')"
size_bytes="$(stat -c%s "$dump_file")"

# Clé jamais passée en argument de commande (visible via `ps`) : openssl la
# lit directement dans la variable d'environnement BACKUP_ENCRYPTION_KEY.
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -pass env:BACKUP_ENCRYPTION_KEY -in "$dump_file" -out "$enc_file"

# Contrôle d'intégrité structurel (BACKUP-004) : déchiffre en flux (jamais
# de clair sur disque après ce point) et vérifie que pg_restore reconnaît
# bien une archive valide — sans toucher à aucune base. Un contrôle
# d'intégrité seul ne prouve pas la restaurabilité réelle : voir
# restore-drill.sh (BACKUP-005) pour l'exercice de restauration complet.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -pass env:BACKUP_ENCRYPTION_KEY -in "$enc_file" \
  | pg_restore --list > /dev/null

rm -f "$dump_file"

sha_enc="$(sha256sum "$enc_file" | awk '{print $1}')"
cat > "$meta_file" <<EOF
{"ts":"$ts","db":"${PGDATABASE}","sha256_plain":"$sha_plain","sha256_enc":"$sha_enc","size_bytes":$size_bytes}
EOF

# Destination indépendante du staging (BACKUP-002) — idéalement un montage
# ou volume distinct de l'hôte applicatif ; cf. docs/backup-restore.md.
cp "$enc_file" "$BACKUP_OFFSITE_DIR/"
cp "$meta_file" "$BACKUP_OFFSITE_DIR/"
rm -f "$enc_file" "$meta_file"

trap - ERR
log_json info backup_ok ts="$ts" sha256_enc="$sha_enc" size_bytes="$size_bytes"

if [ -n "${BACKUP_RETENTION_DAYS:-}" ]; then
  find "$BACKUP_OFFSITE_DIR" -maxdepth 1 -name 'sesame_*.dump.enc' -mtime "+${BACKUP_RETENTION_DAYS}" -delete
  find "$BACKUP_OFFSITE_DIR" -maxdepth 1 -name 'sesame_*.meta.json' -mtime "+${BACKUP_RETENTION_DAYS}" -delete
fi
