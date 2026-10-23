#!/usr/bin/env bash
# Restauration d'une sauvegarde chiffrée vers une base cible — procédure de
# reprise réelle (P0-06 BACKUP-005). Pour l'exercice automatisé périodique,
# voir restore-drill.sh : celui-ci restaure vers CE QUE VOUS LUI DONNEZ,
# donc ne jamais le viser sur la base de production sans le vouloir.
#
# Usage: restore.sh <fichier.dump.enc> <base_cible>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

enc_file="${1:?Usage: restore.sh <fichier.dump.enc> <base_cible>}"
target_db="${2:?Usage: restore.sh <fichier.dump.enc> <base_cible>}"
require_env BACKUP_ENCRYPTION_KEY PGUSER

if [ ! -f "$enc_file" ]; then
  echo "Fichier introuvable: $enc_file" >&2
  exit 1
fi

echo "Restauration de '$enc_file' vers la base '$target_db' sur ${PGHOST:-localhost}:${PGPORT:-5432}."
echo "CTRL+C dans les 5 secondes pour annuler."
sleep 5

tmp_dump="$(mktemp)"
trap 'rm -f "$tmp_dump"' EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -in "$enc_file" -out "$tmp_dump"

pg_restore --list "$tmp_dump" > /dev/null

createdb -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "$PGUSER" "$target_db" 2>/dev/null || true

pg_restore -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "$PGUSER" \
  --clean --if-exists --no-owner --dbname "$target_db" -j 4 "$tmp_dump"

echo "Restauration terminée vers '$target_db'."
echo "Étape suivante : npx prisma migrate deploy (vérifier schéma) puis contrôles métier — cf. docs/backup-restore.md."
