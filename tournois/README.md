# Tournois — application SaaS de gestion de tournois sportifs

Implémentation du cahier des charges v1.0 (11 novembre 2026), lot **P0 (MVP)** plus les éléments P1 nécessaires
aux critères d'acceptation (arbitres, têtes de série, planning visuel, notifications, exports, statistiques,
contestations et corrections).

```
tournois/
├── api/                 API NestJS + PostgreSQL (isolation par club en RLS), moteur de compétition
│   ├── src/engine/      Moteur pur, sans base : scores, tirages, tableaux, classements, planification
│   ├── src/modules/     Comptes, tournois, participants, génération, résultats, rencontres, vues
│   ├── migrations/      Schéma SQL versionné
│   ├── scripts/         migrate.ts, load.ts (test de charge)
│   └── test/            Tests du moteur + tests de bout en bout CA01 à CA15
├── web/                 Application React (PWA) : organisateur, joueur, page publique
├── deploy/              Sauvegarde et test de restauration
└── docker-compose.yml   Déploiement de référence (db, api, web)
```

## Démarrage

### Développement

```bash
# PostgreSQL 16 : un propriétaire du schéma et un rôle applicatif sans privilège (soumis à la RLS)
psql -c "CREATE ROLE tn_owner LOGIN PASSWORD 'tn_owner'" -c "CREATE ROLE tn_app LOGIN PASSWORD 'tn_app'" \
     -c "CREATE DATABASE tournois OWNER tn_owner"

cd api && npm install && npm run migrate && DEFAULT_PLAN=club npm run dev     # http://localhost:4100
cd web && npm install && npm run dev                                           # http://localhost:5174
```

Tests (base `tournois_test` dédiée, recréée à chaque exécution) :

```bash
psql -c "CREATE DATABASE tournois_test OWNER tn_owner"
cd api && npm test
```

### Production

```bash
cp .env.example .env    # mots de passe, APP_URL, SMTP, super administrateurs
docker compose up -d --build
```

L'application écoute sur `127.0.0.1:8090` ; le HTTPS est assuré par le reverse proxy de l'hôte. Les migrations
sont appliquées au démarrage de l'API.

## Parcours

**Organisateur** — compte + club, puis assistant en 5 étapes (informations, format, participants, règles,
publication). Un tournoi de 16 participants est créé, généré, planifié et publié en un clic à la dernière étape
(< 1 s). L'écran du tournoi regroupe : tableau de bord temps réel (rencontres terminées/en cours/restantes,
retards, scores en attente, terrains libres, anomalies), participants (ajout rapide, import CSV avec simulation,
validation, liste d'attente, présence, forfait, remplacement, QR individuels), poules, tableau, rencontres,
programme (glisser-déposer entre terrains et créneaux), classement final, partage (QR Codes imprimables, exports
CSV/Excel, rapport imprimable/PDF, statistiques), réglages (arbitres, co-organisateurs, personnalisation) et
historique.

**Joueur** (mobile, sans installation) — scan du QR Code → page du tournoi → profil simplifié → inscription (ou
association au joueur créé par l'organisateur) → confirmation. Accueil : prochaine rencontre (adversaire, terrain,
heure), scores à confirmer, mes tournois. Saisie du score par manche, confirmation ou contestation par l'adversaire.

**Spectateur** — `/p/<slug>` : en direct, poules, tableau, résultats, classement, sans connexion ni donnée de contact.

## Moteur de compétition

Le moteur (`api/src/engine`) est indépendant de la base : chaque règle est testée isolément.

| Fichier | Rôle |
|---|---|
| `scoring.ts` | Règles de score paramétrables : manches en jeux (tennis, padel : 6 jeux, tie-break, super tie-break) ou en points (badminton 21 pts plafond 30, tennis de table, volley avec manche décisive à 15), score unique (football, pétanque à 13), nul autorisé ou non, abandon, score de forfait. Contrôle de cohérence avec message précis (« Manche 2 : score 6-5 impossible »). Préréglages par discipline. |
| `draw.ts` | Toutes-contre-toutes (méthode du cercle, aller-retour), répartition en poules (serpentin par niveau, têtes de série + tirage, tirage intégral, germe conservé), tableau à élimination directe de toute taille (puissance de 2 supérieure, exemptions attribuées aux meilleures têtes de série, placement standard 1-16 / 8-9…), petite finale, croisement des qualifiés de poules. |
| `standings.ts` | Barème configurable (victoire, nul, défaite, forfait, pénalités), départage successif configurable : points, victoires, confrontation directe (mini-championnat recalculé sur les seuls ex æquo), différence de sets, de jeux, sets/jeux gagnés, classement initial. Égalité parfaite = rang partagé (ex æquo). |
| `schedule.ts` | Planification : terrains × créneaux, aucun participant sur deux rencontres simultanées, dépendances (tour précédent, fin de poule), créneaux verrouillés conservés, dépassement de la plage horaire signalé. |

### Spécification des formats

| Format | Phases | Règles |
|---|---|---|
| Poules | 1 phase toutes-contre-toutes, N poules | Rencontres aller simple ou aller-retour ; classement par poule. |
| Championnat | 1 poule unique, journées | Calendrier par journées, classement général. |
| Élimination directe | 1 tableau | Taille libre (11 joueurs → tableau de 16, 5 exemptions aux têtes de série 1 à 5) ; placement par niveau ou tirage ; petite finale optionnelle. |
| Poules + tableau final | Poules → tableau | Le tableau est créé dès la génération avec des cases « 1er poule A », « 2e poule C »… Les 1ers occupent les places de têtes de série ; les suivants sont permutés pour que deux équipes d'une même poule ne se rencontrent qu'au plus tard (moitiés opposées). Ex. 4×2 : A1-C2, D1-B2 / B1-D2, C1-A2. |

**Qualification** : une case n'est remplie que lorsque la poule est **terminée** (toutes les rencontres officielles)
et le rang **départagé**. Une égalité parfaite sur une place qualificative est signalée (« Égalité à départager »)
et l'organisateur impose l'ordre (tirage au sort, règlement) avec un motif tracé. Les qualifications restent
« provisoires » tant que la poule n'est pas terminée.

**Ajouter un format** (suisse, Americano, double élimination…) : déclarer ses phases dans `FORMATS`
(`generation.ts`) et, si besoin, un nouveau type de phase avec son générateur. Les résultats, la validation
contradictoire, la propagation et les classements sont communs à tous les formats.

## Scores : saisie, validation, corrections

| Qui | Effet |
|---|---|
| Organisateur | Résultat officiel immédiatement ; seul habilité à corriger un résultat officiel (motif obligatoire). |
| Arbitre affecté à la rencontre | Officiel, ou soumis à validation de l'organisateur selon le règlement du tournoi. Arbitrage « obligatoire » : les joueurs ne saisissent pas. |
| Joueur (ou capitaine désigné) | Saisie → l'adversaire est notifié → il **confirme** (officiel) ou **conteste** (l'organisateur tranche). Si les deux côtés saisissent : identique = officiel, différent = contestation. |

- **Concurrence** : chaque opération verrouille la rencontre (`SELECT … FOR UPDATE`), un index garantit une seule
  saisie en attente par rencontre, et un numéro de version refuse les écritures sur une donnée périmée. Deux
  saisies simultanées sont donc toujours confrontées : jamais deux résultats contradictoires validés (CA08).
- **Délai de confirmation** paramétrable ; à expiration, validation automatique (si prévue au règlement) ou alerte
  de l'organisateur (tâche périodique `SWEEP_SECONDS`).
- **Traçabilité** : toutes les saisies (auteur, date, statut, décision) et un journal d'audit **non modifiable**
  (déclencheur SQL) avec état avant/après et motif.
- **Correction d'un résultat officiel** : recalcul des classements ; si le vainqueur change et que la phase
  suivante a déjà été jouée, l'API refuse (`409 downstream_played`) et indique la rencontre concernée ;
  l'organisateur peut confirmer une correction **en cascade** qui annule (et trace) les résultats dépendants.
  Un contrôle d'intégrité (`GET /tournaments/{id}/integrity`) vérifie qu'aucune place n'est occupée sans résultat
  officiel.
- **Forfait** d'un participant : toutes ses rencontres restantes sont perdues par forfait (score de forfait du
  règlement, barème « forfait » au classement) ; s'il devait être placé plus tard dans le tableau, la rencontre est
  résolue automatiquement.

## API

Toutes les opérations contrôlent les droits côté serveur. Principaux points d'entrée :

```
POST   /api/auth/signup | /api/auth/login | /api/auth/logout
GET    /api/me | /api/me/tournaments | /api/me/matches | /api/me/notifications | /api/me/export   DELETE /api/me
GET    /api/catalog                                     disciplines, formats, critères de départage, offres
POST   /api/tournaments                 GET /api/tournaments?orgId=
GET    /api/tournaments/{id}            PATCH /api/tournaments/{id}        DELETE /api/tournaments/{id}
POST   /api/tournaments/{id}/publish | /generate | /schedule
GET    /api/tournaments/{id}/bracket | /matches | /rankings | /results | /dashboard | /stats | /audit | /integrity
GET    /api/tournaments/{id}/stream     temps réel (Server-Sent Events)
POST   /api/tournaments/{id}/participants | /registrations | /participants/import
PATCH  /api/participants/{id}           POST /api/participants/{id}/status | /replace
POST   /api/members/{id}/invite         QR Code individuel (usage unique, expirant, révocable)
POST   /api/tournaments/{id}/qr-codes   GET (liste)   DELETE /api/tournaments/{id}/qr-codes/{tokenId}
POST   /api/tournaments/{id}/referees | /roles      POST /api/tournaments/{id}/stages/{stageId}/tiebreak
GET    /api/matches/{id}                PATCH /api/matches/{id}/schedule   POST /api/matches/{id}/status | /penalty
POST   /api/matches/{id}/scores | /confirm-score | /dispute-score | /validate-score | /walkover
GET    /api/join/{token}                POST /api/join/register | /api/join/claim | /api/join/check-in
GET    /api/tournaments/{id}/export/{participants|results|ranking|planning}.{csv|xlsx}
GET    /api/public/tournaments/{slug}  (+ /matches, /rankings, /stream)   API publique, données publiées uniquement
GET    /api/qr.svg?data=/p/{slug}       image QR (liens de l'application uniquement)
```

Erreurs : `{ code, message, field, details, trace_id }` (400 validation, 401, 402 quota de l'offre, 403 droits,
404 introuvable — y compris pour un tournoi d'un autre club —, 409 conflit, 410 jeton expiré/révoqué/utilisé,
422 score incohérent, 429 limitation).

## Sécurité et conformité

- **Multi-club** : chaque table de tournoi porte `org_id` ; le rôle applicatif n'est pas propriétaire des tables
  et la RLS PostgreSQL filtre chaque requête sur l'organisation de la transaction. Les seuls passages entre
  organisations sont des fonctions de routage `SECURITY DEFINER` qui ne renvoient qu'une clé (CA14 vérifie l'isolation
  directement en base).
- **Rôles** : super administrateur (variable `PLATFORM_ADMINS`), responsable de club (tous les tournois du club),
  organisateur, arbitre, joueur, spectateur ; un même compte peut cumuler des rôles selon le tournoi.
- **Comptes** : mots de passe scrypt, sessions révocables (jeton haché en base), verrouillage après 8 échecs,
  limitation des requêtes (connexion, inscription, saisie de score, QR).
- **QR Codes** : jetons de 256 bits stockés hachés ; QR individuels à usage unique, expirants et révocables ;
  association à un joueur existant uniquement par jeton individuel ou validation de l'organisateur.
- **RGPD** : consentement à l'inscription, consentement parental sous 15 ans, export des données personnelles,
  suppression du compte par anonymisation (résultats conservés), coordonnées jamais exposées publiquement,
  durée de conservation par club (`organizations.retention_months`).
- En-têtes de sécurité, HSTS en production, CORS restreint à l'application (API publique ouverte).

## Temps réel et mode dégradé

Chaque changement validé publie un événement `NOTIFY` **dans la transaction** : il n'est diffusé qu'après
validation et reçu par toutes les instances de l'API, qui le relaient aux navigateurs en Server-Sent Events.
Si le flux est interrompu, l'application bascule sur un rafraîchissement toutes les 15 s, et recharge au retour
au premier plan. Le service worker ne met en cache que la coque de l'application, jamais les données : aucun score
périmé n'est affiché comme à jour.

## Performances (mesures indicatives, poste de développement, 1 instance)

`scripts/load.ts` crée un tournoi de 500 participants (64 poules + tableau final, 1 835 rencontres) :

| Mesure | Résultat |
|---|---|
| Import CSV de 500 participants | 1,6 s |
| Génération et planification de 1 835 rencontres | 2,5 s |
| Vue organisateur complète | ~100 ms |
| Page publique, 50 clients simultanés (1,5 Mo non compressés) | p95 ≈ 320 ms, ~160 req/s (6 ms par requête en cache) |
| Validation d'un score avec recalcul des classements | p50 ≈ 270 ms, p95 ≈ 570 ms |

Les vues publiques sont mises en cache et invalidées par les événements temps réel. Avant mise en production,
reproduire ces tests sur l'infrastructure cible (objectifs §20 : 1 000 utilisateurs, 100 tournois actifs).

## Exploitation

- **Sauvegarde** : `deploy/backup.sh` (cron quotidien) — dump PostgreSQL compressé, vérifié, rétention 30 jours.
- **Test de restauration** : `deploy/restore-test.sh` (mensuel) — restaure le dernier dump dans une base
  temporaire et compte les résultats officiels.
- **Restauration** : `docker compose stop api && docker compose exec -T db pg_restore -U tn_owner -d tournois --clean < fichier.dump && docker compose start api`.
- **Offres** : `api/src/core/plans.ts` (Gratuit : 32 participants, 3 tournois actifs ; Club : 256, exports Excel,
  plusieurs organisateurs ; Pro : 2 000, API). `DEFAULT_PLAN` attribue l'offre des nouveaux clubs (ex. `club`
  pendant la phase pilote) ; le super administrateur change l'offre d'un club depuis « Compte ».

## Critères d'acceptation

`api/test/acceptance.e2e.test.ts` exécute chaque critère de bout en bout sur PostgreSQL :

| Réf. | Vérification automatisée |
|---|---|
| CA01 | Tournoi de 16 équipes créé, publié, 32 rencontres générées et planifiées. |
| CA02 | 4 poules de 4 équilibrées (têtes de série 1-4 séparées), 6 rencontres par poule, aucun conflit terrain/joueur. |
| CA03 | Score saisi par un joueur → statut « à confirmer », notification de l'adversaire. |
| CA04 | Confirmation → résultat officiel, classement recalculé, événement temps réel, page publique à jour. |
| CA05 | Cycle à 3 départagé par confrontation directe ; égalité parfaite signalée puis arbitrée par l'organisateur. |
| CA06 | Fin des poules → 8 qualifiés placés, aucune revanche de poule en quart. |
| CA07 | Inscription par QR (fermée avant publication, privée sans lien public), invitation partenaire à usage unique, jeton révoqué refusé, demande d'association validée, liste d'attente et promotion, présence par QR. |
| CA08 | Saisies simultanées différentes → contestation, aucun vainqueur ; identiques → un seul résultat officiel ; version périmée et score incohérent refusés. |
| CA09 | Correction : motif obligatoire, refus si demi-finale jouée, correction en cascade tracée, intégrité vérifiée. |
| CA10 | Joueur : prochaine rencontre (terrain, heure), page publique sans contact, QR image. |
| CA11 | Joueur hors rencontre, inconnu, non connecté : refusés ; résultat officiel non modifiable ; tournoi privé invisible. |
| CA12 | Arbitrage obligatoire, arbitre non affecté refusé, score d'arbitre officiel ou à valider selon le règlement. |
| CA13 | Forfait : 2 rencontres perdues par forfait, barème forfait appliqué, rang cohérent. |
| CA14 | Deux clubs simultanés : 404 croisés, isolation vérifiée directement en base (RLS). |
| CA15 | 11 joueurs : tableau de 16, 5 exemptions aux têtes de série 1-5, tournoi joué jusqu'au classement final (5e et 9e ex æquo). |

## Limites connues et suites

- Formats P3 (suisse, double élimination, Americano/Mexicano, montante-descendante) : architecture prête
  (registre `FORMATS`), non implémentés.
- Notifications : web et email (SMTP) ; SMS/WhatsApp à brancher sur `Notifier`. Pas de notification push Web.
- Exports PDF via l'impression du navigateur (rapport imprimable) ; Excel natif (.xlsx).
- Import Excel : enregistrer le fichier en CSV (l'import .xlsx direct n'est pas encore pris en charge).
- Classement multi-tournois, saisons, paiement en ligne, mode hors ligne avec synchronisation : P2, non traités.
- Le planning automatique place les rencontres sur une plage continue (un jour) ; les tournois sur plusieurs
  jours se planifient en ajustant les créneaux depuis le programme.
