# Sauvegarde et restauration — P0-06

Référentiel : cahier des charges sécurité P0, domaine BACKUP-001 à 005.
Tout le contenu applicatif (données métier ET fichiers, cf. `AccDocument.
contentBase64`, `Room.photos`, `CrmTicketMessage.attachments` — pas de
stockage objet séparé dans cette architecture) vit dans la base Postgres.
**Sauvegarder la base = sauvegarder l'intégralité des données applicatives.**
Les secrets (`.env`) sont sauvegardés séparément (BACKUP-001/002).

## Statut de validation

Le pipeline (`run-backup.sh` → `restore.sh` / `restore-drill.sh`) a été
testé de bout en bout dans cette session contre un cluster PostgreSQL 16
réel (dump → chiffrement AES-256 → vérification d'intégrité structurelle →
restauration dans une base cible → données vérifiées bit à bit identiques ;
+ cas d'échec : mauvaise clé de déchiffrement → échec propre, loggé,
aucune corruption silencieuse).

**Non vérifié depuis cette session** (pas d'accès SSH au serveur de
production depuis cet environnement cloud) : l'exécution réelle via
`docker compose exec` sur l'hôte de prod, les unités systemd, et le volume
réel sous charge (taille de base en conditions réelles, durée du dump). À
valider une fois sur le serveur avant de considérer BACKUP-001 à 005
conformes en production — ne pas déclarer ce P0 clos sans ce test réel.

## RPO / RTO

- **RPO cible : 15 minutes** — fréquence du timer `sesame-backup.timer`.
  Mécanisme = dump logique complet (`pg_dump -Fc`) à chaque run, pas de
  réplication WAL continue. Convient tant que la base reste de taille
  modeste (dump de quelques secondes à quelques dizaines de secondes) ; si
  la base grossit au point qu'un dump complet dépasse plusieurs minutes,
  passer à une archive WAL continue (PITR) — non implémenté ici, à
  surveiller (cf. "Risques résiduels").
- **RTO cible : 4 heures** — mesuré réellement par `restore-drill.sh`
  (champ `restore_seconds` du rapport JSON). Sur le jeu de test local
  (quelques tables, quelques Ko) : restauration en moins d'une seconde.
  Le temps réel dépendra de la taille de la base de prod — à mesurer sur
  le premier drill en conditions réelles.

## Composants

```
scripts/backup/
  lib.sh              fonctions communes (log JSON, alerte webhook, pg_dump_run)
  run-backup.sh        dump + chiffrement + vérif intégrité + copie offsite (15 min)
  backup-secrets.sh     chiffre .env séparément, destination distincte
  restore.sh            restauration manuelle vers une base cible (reprise réelle)
  restore-drill.sh       exercice automatisé vers l'instance isolée (hebdo)

deploy/backup/
  docker-compose.drill.yml   instance Postgres isolée dédiée aux exercices
  sesame-backup.service/.timer           toutes les 15 min
  sesame-restore-drill.service/.timer    tous les lundis 03h00
```

## Variables d'environnement (`/etc/sesame-backup.env`, 0600, root)

| Variable | Rôle |
|---|---|
| `PGUSER`, `PGDATABASE` | Base de prod à sauvegarder |
| `PGHOST`, `PGPORT` | Si connexion directe (sinon voir `DOCKER_COMPOSE_FILE`) |
| `DOCKER_COMPOSE_FILE` | Si défini, `pg_dump` passe par `docker compose exec` sur le service `postgres` (recommandé : évite tout décalage de version client/serveur) |
| `BACKUP_STAGING_DIR` | Répertoire local temporaire (le clair y est supprimé dès le chiffrement fait) |
| `BACKUP_OFFSITE_DIR` | Destination des archives chiffrées — **doit être un montage/volume distinct de l'hôte applicatif** (cf. BACKUP-002 "destination indépendante") |
| `BACKUP_SECRETS_DEST_DIR` | Destination des `.env` chiffrés — distincte de `BACKUP_OFFSITE_DIR` |
| `BACKUP_ENCRYPTION_KEY` | Passphrase de chiffrement — **à stocker dans un coffre-fort/gestionnaire de mots de passe, jamais sur l'hôte de sauvegarde lui-même** ; perte = sauvegardes irrécupérables |
| `BACKUP_RETENTION_DAYS` | Optionnel — purge des archives plus anciennes |
| `BACKUP_ALERT_WEBHOOK` | Optionnel — URL webhook (format Slack `{"text":...}`) notifiée sur tout échec |
| `BACKUP_LOG_FILE` | Chemin du journal JSON structuré (défaut `/var/log/sesame-backup.log`) |
| `DRILL_PGHOST`, `DRILL_PGPORT`, `DRILL_PGUSER`, `DRILL_PGPASSWORD` | Instance isolée de `docker-compose.drill.yml` (port 5433, jamais la prod) |

## Déploiement sur le serveur de production

```bash
# 1. Instance isolée pour les exercices (une seule fois)
cd /opt/sesame-suite
DRILL_PGPASSWORD=$(openssl rand -hex 24) # noter dans le coffre-fort
docker compose -f deploy/backup/docker-compose.drill.yml up -d

# 2. Fichier d'environnement des sauvegardes
sudo install -m 0600 -o root -g root /dev/null /etc/sesame-backup.env
sudo tee /etc/sesame-backup.env <<'EOF'
PGUSER=sesame
PGDATABASE=sesame_suite
DOCKER_COMPOSE_FILE=/opt/sesame-suite/docker-compose.yml
BACKUP_STAGING_DIR=/var/lib/sesame-backup/staging
BACKUP_OFFSITE_DIR=/data/sesame-backups        # partition /data distincte, cf. migration docker data-root déjà faite
BACKUP_SECRETS_DEST_DIR=/data/sesame-secrets
BACKUP_ENCRYPTION_KEY=<à générer avec openssl rand -hex 32, stocker dans le coffre-fort>
BACKUP_RETENTION_DAYS=30
BACKUP_ALERT_WEBHOOK=<url webhook alerting, optionnel>
BACKUP_LOG_FILE=/var/log/sesame-backup.log
DRILL_PGHOST=127.0.0.1
DRILL_PGPORT=5433
DRILL_PGUSER=sesame_drill
DRILL_PGPASSWORD=<celui généré à l'étape 1>
EOF

# 3. Unités systemd
sudo cp deploy/backup/sesame-backup.service deploy/backup/sesame-backup.timer \
        deploy/backup/sesame-restore-drill.service deploy/backup/sesame-restore-drill.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sesame-backup.timer sesame-restore-drill.timer

# 4. Premier test manuel AVANT de faire confiance au timer
sudo systemctl start sesame-backup.service
sudo journalctl -u sesame-backup.service -n 50
sudo systemctl start sesame-restore-drill.service
cat /var/lib/sesame-backup/staging/drill_report_*.json   # dernier rapport
```

## Restauration réelle (sinistre)

```bash
source /etc/sesame-backup.env   # charge PGUSER, BACKUP_ENCRYPTION_KEY...
export PGHOST=127.0.0.1 PGPORT=5432   # base cible de reprise, PAS la prod vivante
ls -t "$BACKUP_OFFSITE_DIR"/sesame_*.dump.enc | head -1   # dernière sauvegarde
scripts/backup/restore.sh "$BACKUP_OFFSITE_DIR"/sesame_<horodatage>.dump.enc sesame_suite_recovery
cd /opt/sesame-suite && npx prisma migrate deploy   # vérifie la cohérence du schéma
# contrôles métier avant bascule : compter les réservations récentes,
# vérifier un AdminUser connu, comparer avec le dernier rapport de drill.
```

Pour restaurer les secrets : `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000
-pass env:BACKUP_ENCRYPTION_KEY -in <env_horodaté.enc> -out .env.recovered`.

## Risques résiduels (à ne pas déclarer couverts)

- **Pas d'immutabilité/WORM réelle** sur `BACKUP_OFFSITE_DIR` : un compte
  compromis avec accès à ce chemin peut supprimer les archives. Mitigé en
  partie par la séparation de répertoire (pas le même compte que l'app),
  mais pas de verrou de conservation (object lock) faute d'infra S3/objet
  dans cette stack. À renforcer si une destination compatible devient
  disponible.
- **RPO 15 min par dump complet**, pas par WAL continu — ne tient pas si la
  base grossit significativement (cf. section RPO/RTO).
- **Chiffrement symétrique à clé unique** (`BACKUP_ENCRYPTION_KEY`) partagée
  entre DB et secrets (répertoires distincts, mais même clé) — une fuite de
  cette clé expose les deux. Rotation possible (re-chiffrer les archives
  existantes) mais non automatisée.
- **TLS non vérifié** sur la connexion `pg_dump`/`pg_restore` quand elle
  transite par le réseau (non applicable tant que tout reste sur le réseau
  interne docker-compose/localhost, cf. audit DB-004).
- **Pas encore exécuté en conditions réelles de prod** (cf. "Statut de
  validation" plus haut) — le premier run réel sur le serveur est une
  étape de validation à part entière, pas une formalité.
