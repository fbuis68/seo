#!/usr/bin/env bash
# Fonctions communes aux scripts de sauvegarde/restauration Sesame Suite
# (P0-06 — cf. docs/backup-restore.md pour la procédure complète).
set -euo pipefail

log_json() {
  # log_json <level> <event> [key=value ...] — une ligne JSON par appel,
  # jamais la valeur d'un secret (clé, mot de passe) dans "fields".
  local level="$1" event="$2"; shift 2
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local fields="" sep=""
  for kv in "$@"; do
    local key="${kv%%=*}" val="${kv#*=}"
    val="${val//\\/\\\\}"
    val="${val//\"/\\\"}"
    fields="${fields}${sep}\"${key}\":\"${val}\""
    sep=","
  done
  printf '{"ts":"%s","level":"%s","event":"%s","fields":{%s}}\n' "$ts" "$level" "$event" "$fields" \
    >> "${BACKUP_LOG_FILE:-/var/log/sesame-backup.log}"
}

require_env() {
  local missing=0
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      echo "Variable d'environnement requise manquante: $name" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || exit 2
}

alert_failure() {
  # alert_failure <event> <message> — journalise et, si configuré, notifie
  # un webhook (Slack-compatible, {"text": "..."}). Ne contient jamais le
  # contenu d'un secret, uniquement un message d'erreur technique.
  local event="$1" message="$2"
  log_json error "$event" message="$message"
  if [ -n "${BACKUP_ALERT_WEBHOOK:-}" ]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"[Sesame backup] ${event}: ${message}\"}" \
      "$BACKUP_ALERT_WEBHOOK" >/dev/null 2>&1 || true
  fi
}

# pg_dump_run <fichier-sortie> — passe par le conteneur Docker du serveur
# Postgres de prod quand DOCKER_COMPOSE_FILE est défini (évite tout décalage
# de version entre pg_dump client et le serveur, et ne nécessite pas
# d'installer les outils clients sur l'hôte) ; sinon pg_dump direct via les
# variables PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE standard.
pg_dump_run() {
  local out="$1"
  if [ -n "${DOCKER_COMPOSE_FILE:-}" ]; then
    docker compose -f "$DOCKER_COMPOSE_FILE" exec -T postgres \
      pg_dump -U "${PGUSER}" -Fc "${PGDATABASE}" > "$out"
  else
    pg_dump -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" \
      -U "${PGUSER}" -Fc "${PGDATABASE}" > "$out"
  fi
}
