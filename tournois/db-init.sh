#!/bin/sh
# Rôle applicatif sans propriété des tables : soumis à l'isolation par organisation (RLS).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "CREATE ROLE tn_app LOGIN PASSWORD '${DB_APP_PASSWORD}'"
