#!/bin/sh
# Test de restauration (mensuel) : restaure le dernier dump dans une base temporaire et compte les résultats officiels.
set -e
DIR=${BACKUP_DIR:-/var/backups/tournois}
LAST=$(ls -1t "$DIR"/tournois-*.dump | head -1)
docker compose exec -T db psql -U tn_owner -d postgres -c "DROP DATABASE IF EXISTS restore_test" -c "CREATE DATABASE restore_test"
docker compose exec -T db pg_restore -U tn_owner -d restore_test --no-owner < "$LAST"
docker compose exec -T db psql -U tn_owner -d restore_test -tc "SELECT count(*) || ' rencontres officielles restaurées' FROM matches WHERE status IN ('completed','walkover')"
docker compose exec -T db psql -U tn_owner -d postgres -c "DROP DATABASE restore_test"
echo "Restauration testée depuis $LAST"
