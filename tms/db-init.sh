#!/bin/sh
# Rôle applicatif sans privilège de contournement RLS ; le propriétaire des tables est POSTGRES_USER.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "CREATE ROLE tms_app LOGIN PASSWORD '${DB_APP_PASSWORD}'"
