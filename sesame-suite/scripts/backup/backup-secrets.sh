#!/usr/bin/env bash
# Sauvegarde chiffrée du fichier .env (secrets de production) — séparée de
# la sauvegarde base de données : destination et cycle de vie distincts
# (BACKUP-001/002, exigence "secrets conservés séparément").
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_env BACKUP_ENCRYPTION_KEY BACKUP_SECRETS_DEST_DIR

env_file="${1:-$SCRIPT_DIR/../../.env}"
if [ ! -f "$env_file" ]; then
  alert_failure secrets_backup_failed "fichier source introuvable: $env_file"
  exit 1
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_SECRETS_DEST_DIR"
out="${BACKUP_SECRETS_DEST_DIR}/env_${ts}.enc"

if ! openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass env:BACKUP_ENCRYPTION_KEY -in "$env_file" -out "$out"; then
  alert_failure secrets_backup_failed "chiffrement échoué"
  rm -f "$out"
  exit 1
fi

log_json info secrets_backup_ok ts="$ts" dest="$out"

if [ -n "${BACKUP_RETENTION_DAYS:-}" ]; then
  find "$BACKUP_SECRETS_DEST_DIR" -maxdepth 1 -name 'env_*.enc' -mtime "+${BACKUP_RETENTION_DAYS}" -delete
fi
