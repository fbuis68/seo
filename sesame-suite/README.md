# Sesame Suite — Hôtel Churchill

Application TypeScript / Node.js / PostgreSQL reproduisant le parcours client
Sesame Technology (check-in digital, taxe de séjour, préférences éco,
boutique/room-service, espace client, programme de fidélité, livret digital)
à partir de :

- `documentation_sesame_suite_1.docx` — documentation technique complète
- `dossier_lancement_dev.docx` — dossier de lancement développement
- `sesame_eco_checkin_boutique.html` — prototype HTML de référence (localStorage)
- `sesame_admin.html` — prototype back-office (référence pour une itération future)

## Ce qui a été construit (itération 1)

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

**Non couvert dans cette itération** (périmètre convenu — voir conversation) :
le back-office admin (`sesame_admin.html`, 19 panneaux), l'app ménage
(`sesame_menage.html`), le CRM/marketing, l'éditeur du livret. La base de
données est déjà prête à les recevoir (tables `Product`, `LivretSection`,
`HousekeepingTask/Staff`, `Order.status`, etc.) ; il reste à construire les
écrans d'administration au-dessus.

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

## Démarrage

### 1. Base de données PostgreSQL

```bash
# Option A — Docker (recommandé sur poste de dev classique)
docker compose up -d

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
      housekeepingTask.ts          # POST /wa/housekeepingTask/createEco
      auth.ts                       # POST /api/auth/guest-login
  public/
    checkin.html          # prototype d'origine, rebranché sur l'API
```

## Prochaine itération suggérée

1. Back-office admin (`sesame_admin.html`) : mêmes principes — HTML/CSS
   conservés, panneaux rebranchés un par un sur `/wa/*` (config, chambres,
   catalogue, commandes, livret, planning ménage, CRM, marketing).
2. Authentification admin (actuellement absente — le check-in client n'en a
   jamais eu besoin, mais l'admin en aura besoin).
3. App agent ménage (`sesame_menage.html`) branchée sur
   `RoomHousekeepingStatus` / `HousekeepingTask` / `HousekeepingStaff`.
4. Export CSV taxe de séjour (`TaxeSejourRecord.findByPeriod` côté doc)
   et génération QR réelle (actuellement simulée, comme dans le prototype).
