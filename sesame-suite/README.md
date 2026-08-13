# Sesame Suite — Hôtel Churchill

Application TypeScript / Node.js / PostgreSQL reproduisant le parcours client
Sesame Technology (check-in digital, taxe de séjour, préférences éco,
boutique/room-service, espace client, programme de fidélité, livret digital)
à partir de :

- `documentation_sesame_suite_1.docx` — documentation technique complète
- `dossier_lancement_dev.docx` — dossier de lancement développement
- `sesame_eco_checkin_boutique.html` — prototype HTML de référence (localStorage)
- `sesame_admin.html` — prototype back-office

## Ce qui a été construit

**Fondations backend complètes** + **parcours client intégral**, pixel-identiques
à la charte graphique et à l'ergonomie du prototype `sesame_eco_checkin_boutique.html` :

- Le fichier `public/checkin.html` est le prototype **original**, avec son
  HTML/CSS/JS conservés à l'identique (mêmes ids, mêmes classes, mêmes
  tokens CSS, mêmes polices Fraunces/Sora, mêmes calculs de taxe/éco/points).
  Seule la **couche de données** a été rebranchée : chaque lecture/écriture
  `localStorage` est remplacée par un appel à l'API `/wa/*`.
- Parcours check-in 7 étapes (réservation → chambre → taxe de séjour → KYC →
  préférences éco → boutique → récompenses/paiement).
- Espace client post check-in (clé digitale, points de fidélité, ménage,
  historique, livret digital, boutique/room-service) avec authentification
  réelle par email + code de réservation (`POST /api/auth/guest-login`).
- Base de données PostgreSQL (Prisma) couvrant l'ensemble du domaine :
  hôtel/config, chambres, réservations, déclarations de taxe de séjour,
  catalogue boutique, commandes (boutique + room service unifiées), préférences
  client, fidélité, livret digital, statuts et tâches de ménage.
- Données de démonstration Hôtel Churchill : 12 chambres, 8 réservations
  (dont la démo `demo@sesame.fr` / `DEMO-2026-0001`), 14 produits / 5
  catégories, 4 rubriques de livret, soldes de fidélité.

**Back-office admin complet**, même principe (HTML/CSS/JS d'origine conservés,
couche de données rebranchée sur l'API) :

- `public/admin.html`, servi sur `/admin`, avec authentification réelle
  (email + mot de passe, JWT, `POST /wa/login/login`, middleware
  `requireAdmin` sur tous les endpoints d'écriture).
- Panneaux rebranchés : Accueil (KPI), Logo & Couleurs, Typographie & Textes,
  Hôtel & Catégorie, Barèmes taxe (+ export/purge des déclarations), Gains
  (paliers de fidélité), Paramètres éco, Base clients (CRM agrégé
  réservations/fidélité/préférences), Actions marketing (campagnes
  journalisées, sans envoi réel — comme le prototype), Catalogue produits
  (CRUD), Commandes (statuts), Livret digital (CRUD des rubriques), Planning
  ménage (tâches + agents + affectation chambres), Plan de l'hôtel et
  Gestion des chambres (CRUD, canvas de plan).
- Compte admin de démonstration : voir « Comptes de démonstration » ci-dessous.

**Multi-tenant réel — comptes Sesame vs comptes hôtel** : deux rôles
`AdminUser.role` :

- **`hotel`** (compte par défaut, ex. `admin@hotel-churchill.fr`) : géranté
  par un seul établissement. Le serveur verrouille chaque requête sur son
  `entityId` (`resolveEntity()`), même si un autre `entityCode` est passé en
  paramètre — impossible d'accéder aux données d'un autre hôtel.
- **`sesame`** (compte Sesame Technology, ex. `super-admin@sesame.technology`)
  : accès à deux panneaux réservés (masqués du menu pour les comptes
  `hotel`) —
  - **"Hôtels"** : liste tous les établissements, en crée de nouveaux
    (`POST /wa/entity/create` — provisionne l'`Entity`, sa configuration par
    défaut et son compte admin `hotel`, identifiants affichés une seule
    fois), les active (bascule le contexte de *tous* les autres panneaux —
    chambres, livret, planning, etc. — sur l'établissement choisi, via un
    `entityCode` injecté automatiquement dans chaque appel API), les
    supprime, ou règle leurs paramètres opérationnels sans les activer.
  - **"Souscriptions"** : grille tarifaire globale + suivi des demandes
    d'essai. Une souscription peut être créée manuellement par Sesame et
    suit `trial → active → expired/cancelled`. **L'activation d'une
    souscription en essai provisionne automatiquement l'établissement**
    (même mécanisme que la création manuelle) — les deux chemins de
    création de compte demandés (direct, ou via souscription) aboutissent
    au même `provisionEntity()`.
- Voir « Comptes de démonstration » ci-dessous pour se connecter en tant que
  Sesame et tester ces deux panneaux.

**Groupes d'hôtels (chaînes)** — panneau "Groupes" (compte Sesame uniquement) :
rattache plusieurs établissements à un `Group`, avec pour la fidélité et pour
la politique éco un choix indépendant entre :

- **Centralisée** : un seul réglage partagé, géré depuis le panneau
  "Groupes". Pour la fidélité, cela va jusqu'au solde de points lui-même —
  un client cumule ses points sur tous les hôtels du groupe (`LoyaltyAccount`
  scopé par `groupId` au lieu de `entityId`, cf. `resolveLoyaltyScope()`) et
  la base clients (panneau CRM) agrège réservations/préférences sur tous les
  hôtels du groupe. Les établissements membres restent en lecture seule sur
  ces champs (`GET /wa/entityModuleConfig/list` renvoie les valeurs du
  groupe ; `POST /wa/entityModuleConfig/update` les ignore silencieusement
  si un hôtel tente de les modifier — bannière d'avertissement côté front).
- **Indépendante** : chaque hôtel garde ses propres réglages et son propre
  solde de fidélité, comme s'il n'était pas dans un groupe.

Rattacher un hôtel à un groupe à fidélité centralisée fusionne son solde
existant (par email) dans le solde partagé du groupe. Détacher un hôtel ne
« redescend » pas ce solde partagé — l'hôtel repart avec un historique
propre, le solde du groupe restant intact pour les établissements restants.

**Non couvert** (hors périmètre — panneau du prototype `sesame_admin.html`
gérant le CRM commercial interne de Sesame, sans rapport avec la gestion
d'un établissement) : "CRM Sesame". Son code JS reste présent dans
`admin.html` mais n'est plus accessible depuis le menu et n'est pas
rebranché sur l'API.

Également non couvert : l'app ménage (`sesame_menage.html`, application
séparée pour les agents de ménage sur le terrain). La base de données est
déjà prête à la recevoir (`RoomHousekeepingStatus`, `HousekeepingTask`,
`HousekeepingStaff`).

La simulation KYC (OCR / selfie / correspondance biométrique) reste
volontairement côté client uniquement, comme dans le prototype d'origine —
aucun service de vérification d'identité réel n'a été demandé ni intégré.

## Stack

- **Backend** : Node.js 22, TypeScript, Express, Prisma, PostgreSQL, JWT
  (session invité éphémère, en mémoire côté client — comme l'original).
- **Frontend** : le prototype HTML/CSS/JS d'origine (ES5, sans build),
  rebranché sur l'API via `fetch()`.
- **API** : endpoints nommés `/wa/<entité>/<action>`, calqués sur la
  convention `chiefOrchester` documentée (§6.6 de la documentation
  technique), pour rester compatible avec un futur remplacement par le vrai
  backend Java `com.alphacent.fmk` sans changer le contrat front-end.

## Démarrage rapide — une seule commande (Docker)

Aucune installation de Node, npm ou PostgreSQL n'est nécessaire — seul
Docker (avec le plugin `compose`) est requis :

```bash
docker compose up --build
```

Cette commande lance PostgreSQL, construit l'image du serveur, applique les
migrations, insère les données de démo Hôtel Churchill, puis démarre l'API
et l'app client sur **http://localhost:3000**. Comptez ~1 minute au premier
lancement (build de l'image). Les lancements suivants sont quasi instantanés.

Pour arrêter : `Ctrl+C` puis `docker compose down` (ajouter `-v` pour aussi
supprimer les données PostgreSQL et repartir d'une base vierge).

> Le service `app` du `docker-compose.yml` construit l'image à partir du
> `Dockerfile` du dépôt et exécute `docker-entrypoint.sh` au démarrage
> (migrations → seed → serveur). Voir ces deux fichiers pour le détail.

## Démarrage manuel (sans Docker pour l'app)

### 1. Base de données PostgreSQL

```bash
# Option A — Docker, PostgreSQL seul
docker compose up -d postgres

# Option B — PostgreSQL local déjà installé
# créer un rôle/DB "sesame"/"sesame_suite" correspondant à DATABASE_URL
```

### 2. Configuration

```bash
cp .env.example .env
# ajuster DATABASE_URL si nécessaire
```

### 3. Installation, migrations, seed

```bash
npm install
npm run prisma:migrate     # applique le schéma
npm run seed                # données de démo Hôtel Churchill
```

### 4. Lancer le serveur

```bash
npm run dev      # tsx watch — http://localhost:3000
# ou
npm run build && npm start
```

L'app client est servie sur `http://localhost:3000/`.

### Comptes de démonstration (espace client)

| Email | Code réservation | Séjour |
|---|---|---|
| demo@sesame.fr | DEMO-2026-0001 | Suite A43 — Attique, 10→15 août 2026 (en cours) |
| camille.bernard@gmail.com | HCH-2026-1042 | Suite A12, 2 séjours dans l'historique |
| thomas.moreau@email.fr | HCH-2026-1078 | B13, 2 séjours dans l'historique |

### Compte de démonstration (back-office admin)

Accès sur `http://localhost:3000/admin` :

| Email | Mot de passe |
|---|---|
| admin@hotel-churchill.fr | churchill2026 |

Personnalisable via les variables d'environnement `SEED_ADMIN_EMAIL` /
`SEED_ADMIN_PASSWORD` avant de lancer le seed.

### Compte de démonstration (Sesame — multi-établissements)

Même URL `http://localhost:3000/admin`, ce compte donne accès aux panneaux
"Hôtels" et "Souscriptions" (voir ci-dessus) :

| Email | Mot de passe |
|---|---|
| super-admin@sesame.technology | sesame2026 |

Personnalisable via `SEED_SESAME_ADMIN_EMAIL` / `SEED_SESAME_ADMIN_PASSWORD`.

## Structure du projet

```
sesame-suite/
  prisma/
    schema.prisma       # modèle de données (Entity, EntityModuleConfig, Room,
                         # Booking, Occupant, TaxeSejourRecord, KycRecord,
                         # Product, Order, ClientPrefs, LoyaltyAccount/Transaction,
                         # LivretSection, RoomHousekeepingStatus, HousekeepingTask/Staff)
    seed.ts              # données de démo Hôtel Churchill
  src/
    app.ts               # bootstrap Express, montage des routes /wa/* et /api/*
    index.ts             # point d'entrée
    config.ts, db.ts
    lib/                 # helpers (résolution entité multi-tenant, normalisation)
    middleware/errorHandler.ts
    routes/
      config.ts            # GET /wa/entityModuleConfig/list — bundle CFG complet
      facility.ts           # GET /wa/facility/list
      booking.ts             # GET /wa/booking/list, POST /wa/booking/checkin
      taxeSejourRecord.ts     # POST /wa/taxeSejourRecord/create
      roomservice.ts           # GET/POST /wa/roomservice/* (boutique + room service unifiés)
      clientPrefs.ts            # GET/POST /wa/clientPrefs/*
      loyalty.ts                 # GET /wa/loyalty/list, POST /wa/loyalty/credit
      livret.ts                   # GET /wa/livret/list
      housekeepingTask.ts          # GET/POST /wa/housekeepingTask/* (CRUD + createEco)
      housekeepingStaff.ts          # GET/POST /wa/housekeepingStaff/*
      crm.ts                         # GET /wa/crm/clients (agrégation)
      campaign.ts                     # GET/POST /wa/campaign/* (marketing, journalisation)
      login.ts                         # POST /wa/login/login (admin, tous rôles)
      entity.ts                         # GET/POST /wa/entity/* (compte sesame uniquement)
      subscription.ts                    # GET/POST /wa/subscription/*, /wa/pricingConfig/* (sesame)
      group.ts                            # GET/POST /wa/group/* (chaînes d'hôtels, sesame uniquement)
      auth.ts                              # POST /api/auth/guest-login (client)
    lib/provisionEntity.ts                # provisionne Entity + config + AdminUser hotel
    lib/loyaltyScope.ts                    # résout le scope de fidélité (entité ou groupe centralisé)
  public/
    checkin.html          # prototype d'origine (client), rebranché sur l'API
    admin.html             # prototype d'origine (back-office), rebranché sur l'API
```

## Prochaine itération suggérée

1. App agent ménage (`sesame_menage.html`) branchée sur
   `RoomHousekeepingStatus` / `HousekeepingTask` / `HousekeepingStaff`.
2. Export CSV taxe de séjour (`TaxeSejourRecord.findByPeriod` côté doc)
   et génération QR réelle (actuellement simulée, comme dans le prototype).
3. Panneau "CRM Sesame" (suivi commercial interne de Sesame — prospects,
   devis/factures, tickets support), laissé hors périmètre.
4. Paiement réel du mandat GoCardless sur les souscriptions (actuellement
   simulé — champs IBAN informatifs uniquement, comme le prototype
   d'origine) ; page publique d'inscription en libre-service (le prototype
   y fait référence sous le nom `sesame_onboarding.html` mais ce fichier
   n'a pas été fourni) — pour l'instant Sesame crée les souscriptions et
   les hôtels depuis le back-office.
