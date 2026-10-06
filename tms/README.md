# Application SaaS de gestion de centre de formation

Implémentation du cahier des charges v1.2 (6 octobre 2026) : application modulaire, offre gratuite
durable, souscription en ligne intégrable au site web, reprise par fichiers de sauvegarde
(sans API des logiciels sources), signature électronique payante, OpenData, assistant IA,
tableaux de bord, banque connectée et SMTP.

```
tms/
├── api/                 API NestJS + PostgreSQL (monolithe modulaire, RLS multi-organismes)
├── web/                 Espace client (React + Vite)
├── embed/               Widget de souscription à insérer sur le site web (JS autonome)
├── wordpress-plugin/    Extension WordPress « TMS — Souscription en ligne » (shortcodes)
├── docker-compose.yml   Déploiement de référence (db, api, worker, web)
└── .env.example         Variables d'environnement
```

## 1. Souscription en ligne sur le site web

Parcours (§4.1) : tarifs publics → création du compte → vérification email → organisme en **Free**
sans carte → choix volontaire d'une offre payante → paiement hébergé → confirmation serveur
(webhook) → activation des quotas.

### WordPress (recommandé)

1. Copier `wordpress-plugin/tms-souscription` dans `wp-content/plugins/` et activer l'extension.
2. *Réglages → Souscription en ligne* : URL de l'API (ex. `https://app.exemple.fr`), couleur, thème.
3. Côté API : ajouter le domaine du site dans `PUBLIC_ORIGINS`.
4. Dans la page « Tarifs » : `[tms_souscription]`
   (ou `[tms_tarifs interval="year"]`, `[tms_modules]`, `[tms_inscription plan="equipe"]`).

L'extension rend aussi les tarifs **côté serveur** (indexables, cache 1 h) avec des données
structurées schema.org (`SoftwareApplication` / `Offer`), puis le widget interactif prend le relais.
L'événement `tms_signup` est poussé dans `dataLayer` (Google Tag Manager) pour suivre les conversions.

### Autre site (HTML)

```html
<div data-tms-widget data-api="https://app.exemple.fr" data-show="pricing,modules,signup" data-plan="equipe"></div>
<script src="https://app.exemple.fr/embed/v1/tms-embed.js" defer></script>
```

Attributs : `data-show` (pricing, modules, signup), `data-plan`, `data-interval` (month|year),
`data-accent`, `data-theme` (auto|light|dark), `data-source`, `data-title`.
Événements : `tms:ready`, `tms:plan-selected`, `tms:signup`. Démonstration : `embed/demo.html`.

### Le côté modulaire

Le catalogue commercial est défini à un seul endroit, `api/src/modules/billing/catalog.ts` :

| Offre  | Prix HT/mois | Gestionnaires | Clients facturés | Apprenants/an | Sessions actives | Stockage | Signatures/mois |
|--------|-------------:|--------------:|-----------------:|--------------:|-----------------:|---------:|----------------:|
| Free   | 0 €   | 1 | 10 (archivés compris) | 50    | 3 | 1 Go   | 0  |
| Solo   | 39 €  | 1 | sans quota            | 200   | — | 10 Go  | 5  |
| Equipe | 89 €  | 3 | sans quota            | 1 000 | — | 50 Go  | 20 |
| Centre | 149 € | 6 | sans quota            | 2 500 | — | 100 Go | 50 |

Annuel = 10 mensualités. Options : banque connectée (12 €/mois), réception email (9 €/mois/boîte,
« bientôt »), pack 20 signatures (29 €). Chaque module fonctionnel (`signatures`, `smtp.custom`,
`bank`, `analytics.advanced`…) est protégé côté serveur par `@RequireFeature(...)` ; les quotas
sont vérifiés sous verrou dans la transaction de création. Le widget, l'espace client et les
contrôles serveur lisent tous ce même catalogue. Tarifs indicatifs, à confirmer après contrats.

États d'abonnement : `free`, `trialing`, `active`, `past_due` (grâce 7 jours), `read_only`,
`cancelled`. Fin d'abonnement → retour Free si le volume le permet, sinon lecture seule avec export.

## 2. Architecture (§8)

* **Monolithe modulaire NestJS** : un module par domaine (`api/src/modules/*`), enregistrés dans
  `modules/registry.ts`. Le backend est l'autorité des droits, calculs, états et quotas.
* **PostgreSQL** : Row Level Security forcée sur toutes les tables métier (`app.tenant_id` posé par
  transaction), clés étrangères composites `(tenant_id, id)` empêchant tout lien inter-organismes,
  rôle applicatif `tms_app` sans contournement RLS. Montants en `numeric`, calculs en centimes
  (`core/decimal.ts`), aucune virgule flottante.
* **File de travaux PostgreSQL** (`FOR UPDATE SKIP LOCKED`, outbox transactionnelle) au lieu de
  Redis au MVP : un composant d'infrastructure en moins. Worker séparé : `npm run worker`.
* **Stockage objet** privé par organisme (disque local, même contrat qu'un S3), originaux
  immuables avec SHA-256.
* Secrets clients (clés IA, SMTP, jetons bancaires) chiffrés AES-256-GCM (`SECRET_KEY`).

| Module | Contenu | Exigences |
|--------|---------|-----------|
| identity | Inscription, vérification email, connexion (anti force brute), sessions révocables, invitations, accès support temporaire | §4, REC-01/03 |
| billing | Catalogue, droits/quotas, Stripe Checkout + webhooks signés idempotents, upgrade/downgrade/résiliation, crédits de signature | §7, FREE-01, REC-09/10/25-29 |
| crm | Clients/prospects, personnes multi-rôles, SIRET (Luhn), fusion validée, archivage | REF-01/02 |
| catalog | Programmes versionnés, version figée dès usage (trigger SQL) | CAT-01, REC-05 |
| sessions | Cycle de vie, créneaux (UTC + fuseau IANA), chevauchements avec dérogation tracée, inscriptions, financeurs, présences | SES-01, INS-01, PRE-01 |
| quality | Questionnaires, réponses individuelles, réclamations | QUA-01 |
| finance | Devis, factures/acomptes/avoirs immuables, numérotation atomique, règlements et affectations, facturation électronique (partenaire) | FIN-01/02, REC-07/08 |
| documents | Génération PDF (convention, convocation, attestation, émargement, facture), dépôt, téléchargement contrôlé | DOC-01 |
| signatures | Envoi payant, réservation/débit de crédits, rapprochement par idempotence, webhooks désordonnés, archivage preuve | SIG-01..09, REC-29-31 |
| analytics | Dictionnaire de métriques versionné, CA net HT, encaissements, balance âgée, drill-down, CSV | DASH-01, REC-41/42 |
| exports | Export complet ZIP + manifeste SHA-256, réimportable | EXP-01, REC-18/35 |
| migration | Reprise par sauvegardes : ZIP sécurisé, CSV/XLSX, profils versionnés, simulation, publication transactionnelle, rollback par compensation, rapport | §6, REC-11-17/23/24/27 |
| opendata | Registre des sources, ingestion avec quarantaine, Sirene, propositions d'enrichissement | OD-01, §8.2-8.4, REC-32-34 |
| ai | BYOK OpenAI/Gemini, outils allowlistés, propositions confirmées et invalidées si données changent, budget | AI-01, §5.2, REC-37-40 |
| bank | Agrégateur lecture seule, consentement, synchro curseur, rapprochement déterministe validé | BANK-01..10, REC-43-45 |
| mail | SMTP client (465/587, TLS vérifié, anti-SSRF), file avec `delivery_unknown` | MAIL-01, REC-46/47 |

## 3. Démarrer en local

Prérequis : Node 22, PostgreSQL 16.

```bash
# Base de données
psql -U postgres -c "CREATE ROLE tms_owner LOGIN PASSWORD 'tms_owner'; CREATE ROLE tms_app LOGIN PASSWORD 'tms_app';"
psql -U postgres -c "CREATE DATABASE tms OWNER tms_owner; CREATE DATABASE tms_test OWNER tms_owner;"

cd tms/api && npm install && npm run migrate
PUBLIC_ORIGINS=http://localhost:8080 npm run dev     # API :4000, paiement simulé, worker intégré
cd ../web && npm install && npm run dev                # Espace client :5173
cd ../embed && python3 -m http.server 8080             # Démo du site vitrine : http://localhost:8080/demo.html
```

En développement, `PAYMENT_PROVIDER=fake` fournit une page de paiement simulée et des webhooks
signés ; les emails système sont affichés dans la console de l'API.

### Tests

```bash
cd tms/api && npm test     # 30 scénarios e2e sur base réelle (tms_test)
```

Couvrent notamment : souscription et webhooks (doublons, signature invalide, past_due), quotas Free
(11ᵉ client, 51ᵉ apprenant, archivage), isolation inter-organismes, émission concurrente de factures,
reprise (archives malveillantes, réimport sans doublon, rollback bloqué, dépassement de quota,
absence de client réseau dans le module), export natif puis réimport, signature (timeout, webhooks
désordonnés, archivage), IA (confirmation, invalidation, quota), banque, SMTP, OpenData.

## 4. Mise en production

`docker compose up -d --build` avec un `.env` rempli depuis `.env.example`. Points à fournir :

* **Stripe** : créer les prix (Solo/Equipe/Centre × mois/an, options, pack) et renseigner les
  `STRIPE_PRICE_*` ; webhook vers `https://…/api/v1/webhooks/payment`.
* **SMTP système** (`SYSTEM_SMTP_URL`) pour la vérification d'email.
* **Pages légales** : CGV, confidentialité, accord de sous-traitance aux URL `APP_URL/legal/*`.
* HTTPS, sauvegardes PostgreSQL (PITR) et du volume `storage`, hébergement UE.

## 5. Ce qui reste à faire / dépendances externes

Le code fournit les adaptateurs et des **simulateurs** ; les contrats réels conditionnent la mise
en service (§12, §14) :

* **Signature électronique** : choisir le prestataire (niveau eIDAS) et écrire son adaptateur
  (`signatures/signature.provider.ts`, interface prête). Seul le simulateur existe.
* **Facturation électronique** : partenaire plateforme agréée à sélectionner
  (`finance/einvoice.provider.ts`, simulateur). Ne pas commercialiser comme solution fiscale complète
  avant validation.
* **Agrégateur bancaire** (Powens ou autre) : contrat, statut réglementaire, adaptateur
  (`bank/bank.provider.ts`, simulateur).
* **Profils Dendreo / Digiforma** : marqués *provisoires* ; à valider sur au moins deux sauvegardes
  réelles anonymisées par produit avant d'afficher « compatible ». Le profil générique et l'export
  natif sont testés.
* **OpenData** : URL des ressources data.gouv.fr à renseigner ; adaptateurs à recetter sur les
  fichiers réels (schémas supposés par alias). Recherche Sirene branchée sur l'API publique.
* **IA** : « Sign in with ChatGPT » affiché indisponible tant que l'accès commercial n'est pas
  obtenu ; réponses non diffusées en flux (streaming) au MVP ; jeu d'évaluation de 50 demandes à
  constituer.
* **P1** : réception email IMAP/API, MFA, rapprochement Qonto direct, BPF renforcé, catalogue public
  des programmes côté site.
* Le déploiement Docker n'a pas pu être exécuté dans l'environnement de développement (pas de
  démon Docker) : à valider en préproduction.
