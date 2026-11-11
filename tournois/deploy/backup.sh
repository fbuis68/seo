#!/bin/sh
# Sauvegarde quotidienne (à planifier par cron sur l'hôte) : dump compressé horodaté, rétention 30 jours.
# Restauration : voir README, section « Sauvegarde et restauration ».
set -e
DIR=${BACKUP_DIR:-/var/backups/tournois}
mkdir -p "$DIR"
FILE="$DIR/tournois-$(date +%Y%m%d-%H%M%S).dump"
docker compose exec -T db pg_dump -U tn_owner -Fc tournois > "$FILE"
# Vérification : le dump doit être lisible (liste du contenu).
docker compose exec -T db pg_restore -l < "$FILE" > /dev/null
find "$DIR" -name 'tournois-*.dump' -mtime +30 -delete
echo "Sauvegarde OK : $FILE"
