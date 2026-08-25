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
- Panneaux rebranchés : Accueil (KPI), **Arrivées du jour** (voir
  ci-dessous), Logo & Couleurs, Typographie & Textes, Hôtel & Catégorie,
  Barèmes taxe (+ export/purge des déclarations), Gains (paliers de
  fidélité), Paramètres éco, Base clients (CRM agrégé
  réservations/fidélité/préférences), Actions marketing (campagnes
  journalisées, sans envoi réel — comme le prototype), Catalogue produits
  (CRUD), Commandes (statuts), Livret digital (CRUD des rubriques), Planning
  ménage (tâches + agents + affectation chambres), Plan de l'hôtel et
  Gestion des chambres (CRUD, canvas de plan).
- **Arrivées du jour** (`data-pan="reservations"`) : liste par défaut les
  réservations dont l'arrivée est prévue aujourd'hui (`Booking.startDate`),
  avec pour chacune les options retenues par le client au check-in éco —
  ménage (`ClientPrefs.menageFreq`, lié par email), boutique/room service
  (`Order[]` liés par `bookingCode`, nombre + montant total), taxe de
  séjour (`TaxeSejourRecord` lié par `bookingCode`, montant net calculé) —
  en un coup d'œil plutôt qu'en ouvrant chaque réservation une par une. Case
  à cocher **"Toutes les réservations (y compris expirées)"** : bascule sans
  rechargement serveur (`RESA_CACHE` contient déjà tout l'historique non
  annulé) vers la liste complète, triée par date d'arrivée décroissante, avec
  un badge "Expirée" distinct pour les séjours déjà terminés. Chaque carte
  affiche désormais les dates d'arrivée/départ et un bouton **"Modifier"**
  (modale : contact, dates, chambre) — `POST /wa/booking/update`
  (`requireAdmin`, distinct de `/booking/checkin` qui reste accessible sans
  auth pour le parcours check-in du client lui-même).
  Statut check-in (fait / pas encore arrivé) visible directement.
- **Interface responsive** : comme le CRM, la barre latérale devient un
  tiroir accessible par un bouton ☰ sous 900px de large (fermé
  automatiquement à la navigation), les grilles de cartes passent à 2 puis
  1 colonne selon la largeur d'écran.
- **Indicateurs réels par période, sur l'Accueil** (section "Indicateurs
  réels", au-dessus des cartes d'estimation existantes) : séjours, chiffre
  d'affaires généré, taxe de séjour collectée, ménages évités, eau
  économisée, CO₂ évité, temps homme check-in gagné — calculés à partir des
  vraies données historiques (`Booking`, `Order`, `TaxeSejourRecord`,
  `HousekeepingTask`), pas d'une simulation.
  - Période au choix : 7 jours, ce mois-ci, mois dernier, cette année, ou
    plage personnalisée — avec comparaison automatique à la période
    précédente de même durée (delta en %).
  - **Ménages évités / eau / CO₂** : calculés uniquement sur les séjours
    ayant réellement utilisé le check-in éco (tâches `HousekeepingTask`
    `ecoAuto=true` réellement planifiées — écart entre nuits du séjour et
    ménages effectivement programmés), pas une estimation par séjour type.
  - **Chiffre d'affaires généré** : somme des commandes room service/boutique
    (`Order.total`) sur la période — le seul revenu réel présent dans le
    schéma (pas de tarif de chambre facturé enregistré par réservation),
    précisé dans l'interface pour ne pas laisser croire à un CA hôtelier
    complet.
  - **Temps homme check-in gagné** : nombre réel de check-in effectués ×
    minutes économisées par étape (`CFG.checkinModules[k].staffMinutesSaved`,
    réglable dans "Hôtel & Catégorie" — jusqu'ici configuré mais jamais
    utilisé nulle part).
  - Les cartes "KPI hôtelier"/"KPI client" existantes (estimation à partir
    d'un séjour type × un nombre de séjours/an saisi à la main) restent en
    dessous, désormais explicitement libellées "(estimation)" pour ne pas
    les confondre avec les indicateurs réels.
  - **Correction** : sur un compte Sesame, changer d'établissement actif
    (panneau "Hôtels") ne rafraîchissait pas ces indicateurs — le cache
    `KPI_RAW` (rempli une seule fois par page) n'était jamais réinitialisé à
    l'activation d'un nouvel hôtel, si bien que l'Accueil pouvait continuer
    d'afficher les indicateurs de l'hôtel précédemment consulté. `KPI_RAW`
    est maintenant remis à `null` dans `bootAdminApp()`, comme c'était déjà
    le cas pour `CFG.rooms` pour la même raison.
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

**Intégration réservations (connecteur générique)** — panneau "Intégration
réservations" (accessible à tout compte `hotel`, chaque établissement gère le
sien) : remplace l'ancien panneau "API Sesame" du prototype, câblé
uniquement sur l'API propriétaire de Sesame. Le nouveau connecteur parle à
**n'importe quel système externe** — PMS, moteur de réservation — qu'il
s'agisse ou non d'un client Sesame :

- URL + authentification configurables : aucune, clé API en en-tête, Bearer
  token, Basic auth, **ou connexion en deux temps (login + mot de passe →
  token)** — ce dernier mode couvre le cas de la vraie API Sesame
  Technology, qui n'accepte pas de clé statique : `POST {serveur}/ws/login/
  login?login=email` (email en paramètre d'URL, mot de passe en body JSON)
  renvoie un token, à réutiliser tel quel (sans préfixe) dans l'en-tête
  `Authorization` des appels suivants. Vérifié en direct le 17/08/2026 contre
  `newtest.sesame.technology` (curl brut, hors application) : la réponse est
  `{"data":{"profiles":[{"entityCode":"...","token":"..."},...]}}` — **un
  profil par établissement auquel le compte a accès**, pas un token unique
  (`data.token` seul n'existe pas). Le serveur se reconnecte à chaque
  synchronisation (pas de cache de token, pour rester correct sans avoir à
  deviner sa durée de validité) — `src/lib/bookingSource.ts::performLogin()`.
  Ce mode est générique : email/mot de passe en query ou en body, noms de
  champs, chemin du token et en-tête cible sont tous configurables, donc il
  couvre aussi d'autres systèmes tiers utilisant ce même schéma
  login-puis-token, pas seulement Sesame. Un **champ supplémentaire
  optionnel** (nom + valeur, envoyé dans le même corps JSON que
  email/mot de passe) couvre les systèmes qui exigent un troisième
  paramètre de connexion — ex : le PMS Thaïs, dont les comptes
  multi-établissements exigent un `"client":"<code groupe>"` en plus de
  `username`/`password`.
  - **Sélection du profil dans un tableau** (`loginProfileListPath`,
    `loginProfileMatchField`, `loginProfileMatchValue`) : pour l'API Sesame
    (et tout système au même schéma), le compte utilisé pour la connexion
    peut avoir accès à plusieurs établissements — la réponse contient alors
    un tableau avec un profil par établissement, pas un token unique. Ces 3
    champs retrouvent le bon profil par un champ de comparaison (ex :
    `entityCode` = code de l'hôtel) au lieu de dépendre d'un index de
    tableau fixe et fragile (l'ordre n'est pas garanti stable). Quand ils
    sont renseignés, `loginTokenPath` s'applique au profil trouvé plutôt
    qu'à la réponse entière (ex : juste `token`). Erreur explicite listant
    les valeurs disponibles si aucun profil ne correspond.
  - **Bug corrigé — fuite entre établissements** (`resultEntityField`,
    18/08/2026) : sur l'API Sesame, le token authentifie le **compte**, pas
    strictement l'établissement sélectionné ci-dessus — confirmé en
    pratique, `/wa/booking/list` a renvoyé des réservations d'un autre
    établissement accessible par le même compte (repérable via le
    placeholder email Sesame `{...}@{NomEtablissement}.nomail`, qui trahit
    l'établissement réel de la réservation). Quand `resultEntityField` est
    renseigné (dot-path dans chaque élément reçu, ex : `entityId`), on ne
    garde que les éléments dont ce champ correspond à l'`entityId` du
    profil sélectionné à la connexion — appliqué automatiquement par le
    modèle de connecteur Sesame (`PMS_PRESETS.sesame`, cf. plus bas).
    Concerne à la fois les réservations et les chambres (même mécanisme de
    connexion, même filtre appliqué aux deux endpoints).
- **Méthode HTTP configurable** (`endpointMethod`/`facilityEndpointMethod`,
  GET par défaut) : la plupart des API répondent à un simple GET, mais
  l'API Sesame Technology (`POST /wa/booking/list`, confirmé le 17/08/2026)
  exige un POST avec un corps `application/x-www-form-urlencoded` — souvent
  juste de la pagination (`start`/`limit`). `endpointBodyParams`/
  `facilityEndpointBodyParams` (paires clé=valeur, une par ligne dans
  l'interface) ne sont envoyés que si la méthode est POST.
- **Nettoyage des réservations de groupe** (`mapBookings()::firstOf()`) :
  l'API Sesame renvoie parfois un seul enregistrement pour plusieurs
  chambres/occupants liés (réservation de groupe), avec les champs
  concaténés par une virgule (ex : `personEmail` = `"a@x.com,b@y.com"`,
  `facilityCode` = `"CH1,CH1"`). Notre schéma ne modélisant qu'un occupant
  et une chambre par réservation, seule la première valeur est conservée
  (email, prénom, nom, téléphone, code chambre) plutôt que d'importer une
  chaîne agrégée invalide.
- **Modèle de connecteur** (`PMS_PRESETS` dans `admin.html`, champ
  `presetId`) : un menu "Système source" (Sesame Technology / Mews / Opera
  Cloud (OHIP) / Thaïs / Personnalisé) applique automatiquement les réglages
  techniques fixes d'un système connu (chemins d'API, méthode, mapping des
  champs) et replie tout le formulaire technique sous "Réglages techniques
  avancés" — seuls les identifiants propres à ce client (compte, mot de
  passe, code établissement...) restent visibles, dans une section
  "Identifiants" compacte qui écrit directement dans les champs techniques
  sous-jacents (aucun champ dupliqué côté serveur). "Personnalisé" laisse le
  formulaire complet visible comme avant. Fiabilité inégale selon le
  système, assumée explicitement dans l'encart affiché sous le menu :
  - **Sesame Technology** : entièrement vérifié en conditions réelles le
    17/08/2026 (voir plus haut).
  - **Mews** : chemins et authentification (ClientToken/AccessToken/Client
    dans le corps JSON, cf. `endpointBodyFormat="json"` ci-dessous)
    conformes à la documentation Connector API publique, mais l'API ne
    renvoie pas l'email/nom du client dans la liste des réservations (il
    faudrait un appel supplémentaire vers `/customers/getAll`, non pris en
    charge) — l'import échoue tant que ce champ obligatoire n'est pas
    mappé. Encart orange dédié plutôt que de masquer cette limite.
  - **Opera Cloud (OHIP)** et **Thaïs** : préparent uniquement les
    identifiants (aucun chemin d'API deviné/inventé) — OHIP utilise un vrai
    flux OAuth2 par formulaire (`grant_type=password` + en-têtes
    `x-hotelid`/`x-app-key`) que ce connecteur ne sait pas encore réaliser ;
    la documentation Thaïs fournie ne menait pas à une page consultable.
    Encart orange explicite : connexion non fonctionnelle sans évolution du
    connecteur ou confirmation du fournisseur.
- **Corps JSON en POST** (`endpointBodyFormat`/`facilityEndpointBodyFormat`,
  "form" par défaut) : à côté du formulaire URL-encodé existant (Sesame),
  certaines API (Mews) exigent un corps JSON — mêmes `endpointBodyParams`,
  sérialisés différemment selon ce réglage.
- Mapping des champs par chemin JSON libre (ex : `guest.email`,
  `stay.check_in`) — aucune forme de réponse n'est supposée à l'avance,
  contrairement à l'ancien panneau qui ne comprenait que le format Sesame.
- **Chambres (facilities)** : section dédiée, endpoint + mapping séparés
  (`facilityEndpointPath`, `facilityFieldMapping` : code*, nom, étage,
  catégorie, capacité, surface). Sert à résoudre le problème des codes de
  chambre qui ne coïncident pas d'un système à l'autre (ex : la vraie API
  Sesame utilise des codes du type `room214`, alors que les chambres de démo
  de cette app utilisent des codes fictifs comme `A11`) : en important les
  chambres avec leurs codes exacts de la source externe (`Room.code` en
  `upsert`), le mapping `facilityCode` des réservations retrouve ensuite la
  bonne chambre par correspondance exacte. Optionnel — une réservation dont
  le `facilityCode` ne correspond à aucune chambre connue est quand même
  importée, simplement sans chambre associée. Boutons **"Tester les
  chambres"** / **"Importer les chambres"** dédiés ; import manuel
  uniquement (les chambres changent rarement, contrairement aux
  réservations — la synchronisation automatique ne porte que sur celles-ci).
- Bouton **"Tester la connexion"** : aperçu à blanc (aucune écriture) des
  réservations mappées, avec le détail des éléments ignorés (champ requis
  manquant, date invalide…).
- Bouton **"Importer maintenant"** : import réel, `upsert` par
  `(entityId, code)` — relancer l'import met à jour les réservations déjà
  importées plutôt que de les dupliquer. Les réservations importées portent
  `Booking.importedFrom` (nom de la source).
- **Synchronisation automatique** en plus du bouton manuel : un intervalle
  (toutes les heures / 6h / jour) déclenche l'import tout seul —
  `src/lib/bookingSourceScheduler.ts` vérifie toutes les minutes, côté
  serveur, quels connecteurs actifs ont dépassé leur intervalle depuis leur
  dernière synchronisation.
- L'appel HTTP vers la source externe se fait **depuis le serveur**, pas
  depuis le navigateur — aucun souci de CORS ni de proxy PHP à déployer,
  contrairement à l'ancien panneau.

**Inscription en ligne (`public/onboarding.html`, accessible sur `/onboarding`)**
— wizard public en 5 étapes ("Démarrer mon essai") permettant à un prospect
de créer lui-même son établissement, sans intervention manuelle d'un compte
Sesame :

- `GET /onboarding/pricing` (public) sert la grille tarifaire et le
  catalogue de modules — plus aucune valeur figée côté client, la source de
  vérité reste la même `PricingConfig` que le panneau "Souscriptions".
- `POST /onboarding/register` (public) provisionne directement
  l'établissement + son compte admin (réutilise `provisionEntity()`, la
  brique commune avec la création manuelle et l'activation d'une
  souscription) et crée la fiche `Subscription` (statut `trial`), **déjà
  reliée à l'entité créée** — visible immédiatement dans le panneau
  "Souscriptions" du back-office Sesame, qui fait donc office de suivi
  commercial interne (équivalent d'un CRM basique) tant qu'aucun outil
  externe (HubSpot, Pipedrive…) n'est branché. Le tarif est toujours
  recalculé côté serveur à partir de la grille publique — jamais depuis les
  prix envoyés par le client.
- Champ "Identifiant établissement (si connu)" (cas d'un client déjà
  équipé de Sesame côté PMS) : **jamais rattaché automatiquement** à une
  entité existante depuis ce point d'entrée public — ce serait une prise de
  contrôle de compte triviale (n'importe qui pourrait saisir le code d'un
  établissement tiers). La valeur est seulement notée dans la fiche
  souscription pour vérification manuelle par l'équipe Sesame.
- Mandat SEPA (GoCardless) : seuls le titulaire et les 4 derniers chiffres
  de l'IBAN sont conservés en base — jamais l'IBAN ni le BIC complets, qui
  n'ont pas leur place côté serveur tant qu'aucun vrai prestataire de
  paiement ne les tokenise à la source. Le mandat reste à l'état
  `pending_activation` (aucune vraie intégration GoCardless branchée à ce
  stade — à faire quand le besoin sera confirmé).
- Aucun envoi d'email n'est déclenché (pas de fournisseur SMTP configuré
  dans ce projet) — le panneau "Souscriptions" ci-dessus est la source de
  vérité pour l'équipe commerciale à ce stade.
- Après soumission, `wizGoToAdmin()` **efface toute session admin déjà
  présente dans le navigateur** (`sessionStorage`) avant de rediriger vers
  `admin.html` — sinon une session encore ouverte (ex : un autre
  établissement testé plus tôt dans le même onglet) serait reprise telle
  quelle, et les identifiants tout juste affichés à l'écran seraient
  ignorés silencieusement.

**Parcours client réellement multi-tenant (`public/checkin.html`)** — corrige
une limite du prototype d'origine, qui restait mono-tenant côté client (tous
les appels API omettaient `entityCode`, résolu par défaut sur un unique
établissement serveur). Un paramètre d'URL `?entityCode=E0000000X` cible
maintenant l'établissement voulu, propagé automatiquement à tous les appels
API via un petit wrapper (`apiFetch()`, même principe que `adminFetch()`
côté back-office) — sans lui, comportement historique inchangé (repli sur
l'établissement par défaut du serveur). L'URL complète et prête à copier
(`https://.../?entityCode=...`) — **à insérer dans la procédure de check-in
du PMS du client** (lien envoyé au client avant son séjour, etc.) — est
affichée dans le panneau "Hôtel" du back-office, avec un bouton de copie.

**CRM commercial interne (`public/crm.html`, accessible sur `/crm`)** —
remplace l'ancien panneau "CRM Sesame" du prototype (jamais branché, déjà
retiré du menu) par une nouvelle application dédiée, à ne pas confondre avec
`/wa/crm/*` qui gère les clients finaux **de chaque hôtel** : celle-ci gère
le pipeline commercial de Sesame elle-même (prospects/clients hôteliers).
Réservée aux comptes `sesame` — réutilise la session admin existante si déjà
connecté (accès direct par l'URL `/crm`, plus de lien dans le menu du
back-office), sinon formulaire de connexion dédié qui rejette explicitement
tout compte `hotel`. Interface responsive : la barre latérale devient un
tiroir accessible par un bouton ☰ sous 900px de large, les grilles de
graphiques passent en une colonne, les tableaux défilent horizontalement.
Ascenseur de la zone principale (`.main`, y compris la vue Grille) toujours
visible et stylé (au lieu de l'ascenseur système, masqué par défaut sur
certains OS/navigateurs — ce qui rendait le défilement peu évident).
**Correction** : au-delà d'une poignée de fiches, la vue Liste restait
tronquée sans aucun ascenseur — `.tbl-wrap` (conteneur du tableau) avait
`overflow:hidden`, ce qui en flexbox lui donne un `min-height` automatique
de 0 au lieu de la taille de son contenu ; il se faisait donc écraser par
`.main` au lieu de le faire déborder. Corrigé avec `flex-shrink:0`.

- Fiche par établissement : coordonnées, score de risque de churn calculé,
  usage des accès (NFC/Mobile/Code/QR — les 4 se totalisent à 100% par
  fiche), features actives Sesame, **parcours client activés** (étapes
  d'onboarding et rubriques de l'espace client, voir ci-dessous),
  opportunités d'upsell, **journal d'activité** (appels, emails, relances…
  avec statut fait/à faire), vues Liste/Grille, vue Contrats (sans/en
  cours/signé), export CSV.
- **Alimenté automatiquement par l'inscription en ligne** : chaque
  soumission complétée du wizard `/onboarding` crée un enregistrement de
  prospect (`CrmProspect`) directement relié à l'établissement et à la
  souscription créés, avec les coordonnées et le nombre de modules
  souscrits déjà renseignés, plus une première entrée de journal
  ("Inscription en ligne complétée — modules : …") — le commercial n'a rien
  à ressaisir pour démarrer le suivi.
- CRUD complet côté serveur (`/wa/crmProspect/*`, `requireSesame`) —
  plus aucune donnée en `localStorage` contrairement au prototype.
- **Portefeuille de démarrage** : les 67 prospects/clients fournis avec la
  maquette d'origine sont seedés (`prisma/seed.ts`, garde `count===0` — une
  seule fois, jamais réécrasé ensuite pour ne pas perdre les modifications
  faites depuis l'app).
  - **Taux d'usage des accès (NFC/Mobile/Code/QR)** : valeurs réelles
    importées de l'audit clients Sesame (`AUDIT_CLIENTS_SESAME_2025.xlsx`,
    lignes "Taux d'utilisation…") pour 59 des 67 fiches — remplace les
    placeholders à 0 précédemment affichés pour la quasi-totalité du
    portefeuille. Les 8 fiches sans ligne d'audit correspondante gardent
    leurs valeurs à 0 plutôt qu'une valeur inventée.
  - **Parcours client activés** : 7 nouveaux indicateurs par fiche —
    onboarding (choix de la chambre, déclaration occupant, vérification
    d'identité, préférences ménage) et rubriques de l'espace client
    (boutique, points fidélité, évènements — livret digital et gestion de
    demande existaient déjà). Pré-cochés à la création selon le secteur du
    client (`sectorGroupFor()`/`journeyFlagsFor()` dans `seed.ts`) : les
    étapes propres à l'hébergement (chambre, ménage) ne s'appliquent qu'aux
    secteurs hôteliers, l'identité et les rubriques de l'espace client sont
    universelles — éditable ensuite fiche par fiche comme les autres
    indicateurs.
  - **Correction pour les bases déjà provisionnées** : sur un déploiement
    ayant déjà des fiches en base avant cette fonctionnalité (volume
    Postgres persistant, `docker compose up --build` sans repartir d'une
    base vierge), `seed.ts` ne réinsère jamais les 67 fiches une fois
    présentes (garde `count===0`) — les nouvelles colonnes y restaient donc
    à leur valeur par défaut (`code`=0, indicateurs de parcours=`false`),
    sans jamais recevoir les données ci-dessus. Corrigé par une migration
    Prisma dédiée (`20260817090000_crm_prospect_backfill_usage_journey_data`)
    qui applique les mêmes valeurs aux fiches existantes, une seule fois
    par base comme toute migration — sans risque d'écraser un indicateur
    modifié depuis dans l'app (les taux d'usage ne sont corrigés que sur
    les fiches encore à 0 sur les 4 colonnes).
  - **Coordonnées et installation** (référent, téléphone, PMS, site web,
    nombre de modules) : également importés du même audit (colonnes
    "Référent du projet" — texte libre nom/rôle/email/téléphone sur des
    lignes séparées, extrait par classification ligne à ligne plutôt que
    par position fixe vu l'hétérogénéité du texte saisi —, "Interface
    (PMS)", "Site internet", "Nombre module") pour 65 des 67 fiches.
    Migration dédiée pour les bases déjà provisionnées
    (`20260817120000_crm_prospect_backfill_contact_info`) — chacun des 5
    champs est corrigé indépendamment des autres (jamais groupés en une
    seule requête), pour ne jamais écraser un champ déjà édité juste parce
    qu'un champ voisin est encore vide.
- **Vue liste** : quatre graphiques calculés en direct sur les fiches
  réelles — répartition par secteur (icône dédiée par secteur : hôtel,
  immeuble, mallette, haltère, maison, carton, cœur, histogramme…), taux
  d'adoption des modules Sesame en tant qu'intégration technique (WebApp,
  Mobile V2, check-in, offline — livret digital et gestion de demande
  vivent uniquement dans "Parcours client activés" pour ne pas doubler le
  même indicateur dans deux graphiques), parcours client activés
  (onboarding + espace client, cf. ci-dessus), et **répartition des accès
  en camembert**
  (NFC/Mobile/Code/QR — un anneau SVG plutôt que 4 barres, plus lisible
  pour une répartition qui se totalise à 100%), calculée uniquement sur les
  fiches Client ayant réellement des données d'usage (audit) — une fiche
  pas encore auditée n'est pas comptée comme "0% partout", ce qui
  fausserait la répartition ; la couverture (ex. "59 / 67 fiches Client
  avec données d'usage réelles") est affichée sous le graphique. Palette
  catégorielle à 4 teintes validée avec le validateur `dataviz` en mode
  "toutes paires" (contrainte plus stricte que les paires adjacentes,
  nécessaire dès que les segments d'un même graphique peuvent tous se
  toucher) — bleu/jaune/magenta/vert, définie par thème (`--dch-*` dans
  `crm.html`) avec un jeu de teintes assombries dédié pour le thème Nuit,
  validé séparément contre son fond sombre. Chaque fiche/PMS affiche aussi
  un badge coloré déterministe (initiales, couleur dérivée du nom) — pas de
  logo tiers hébergé, pour ne reproduire aucune marque sans autorisation.
- **Alimenté aussi par le formulaire de contact du site web public** :
  `POST /contact` (public, hors `/wa`) reçoit `{nom, email, secteur,
  message}`, crée (ou réutilise, retrouvé par email — pas de doublon sur des
  soumissions répétées) une fiche `CrmProspect`, et y ajoute systématiquement
  une entrée de journal non traitée (`CrmActivity`, type "Relance", auteur
  "Site web", texte = message du formulaire) — visible immédiatement comme
  tâche à faire dans la fiche. Voir `docs/formulaire-contact-site-web.md`
  pour les instructions à transmettre à l'équipe qui gère le site web.
- **Type Prospect / Client** (`CrmProspect.type`) : les fiches créées
  manuellement depuis "+ Nouveau client" restent `Client` par défaut ; celles
  créées automatiquement par l'inscription en ligne (`/onboarding/register`)
  et par le formulaire de contact (`POST /contact`) sont taguées `Prospect` —
  filtrable dans la vue liste, affiché en badge partout (liste, grille,
  fiche).
- **Taux d'usage des accès (troisième graphique de la vue liste)** :
  moyenne NFC / QR / Mobile calculée en direct, **restreinte aux fiches de
  type `Client`** — les prospects n'ont pas encore d'usage réel et
  fausseraient la moyenne à la baisse. Troisième teinte validée `dataviz`
  (aqua `#1baf7a`, CVD ΔE 9.2 / normal-vision ΔE 27.6 face au bleu/orange
  déjà utilisés).
- **Suppression d'une fiche** : bouton "🗑 Supprimer" dans la fiche détail
  (`POST /wa/crmProspect/delete`, déjà existant côté serveur, maintenant
  relié à l'interface) — confirmation requise, action irréversible.
- **Accès admin basé sur les contacts CRM** (carte "Accès admin" dans la
  fiche, `src/routes/adminUser.ts`, réservé aux comptes Sesame) : la fiche
  CRM devient la source de vérité de "qui a le droit d'entrer dans le
  back-office" d'un établissement.
  - N'apparaît en mode actionnable que si le contact est rattaché à un
    établissement Sesame déjà provisionné (`CrmProspect.entityId` non nul —
    ce qui arrive automatiquement pour toute inscription en ligne via
    `/onboarding/register`, ou manuellement en activant une souscription).
    Sinon, la carte l'explique et ne propose aucune action.
  - **Créer un accès** (`POST /wa/adminUser/create`) : crée un `AdminUser`
    (rôle "Établissement" ou "Sesame") sur l'email de la fiche, génère un
    mot de passe temporaire affiché **une seule fois**.
  - **Réinitialiser le mot de passe** / **Révoquer l'accès**
    (`/wa/adminUser/resetPassword`, `/wa/adminUser/delete`) une fois le
    compte créé.
  - Un même email ne peut avoir qu'un seul compte admin (contrainte
    d'unicité déjà existante sur `AdminUser.email`) — la fiche interroge
    `GET /wa/adminUser/status?entityId=&email=` pour savoir si un compte
    existe déjà avant de proposer "Créer" ou "Réinitialiser/Révoquer".
- **Canaux convergents (Email / SMS / WhatsApp) + modèles multi-canal**,
  dans l'onglet "Canaux" du CRM et du back-office de chaque hôtel — même
  mécanisme générique paramétré par portée (`?scope=crm` = Sesame global,
  sinon l'hôtel courant, comme partout ailleurs) :
  - **Email** : SMTP classique (`src/lib/email.ts`, endpoints
    `/wa/smtpConfig/*`).
  - **SMS et WhatsApp** : **Twilio** couvre les deux canaux avec les mêmes
    identifiants de compte (`src/lib/sms.ts`, endpoints `/wa/channelConfig/*`,
    appel HTTP direct, sans SDK). Depuis le 18/08/2026, le canal SMS peut
    aussi être configuré sur **DocPartner (SMSPartner.fr)**, un second
    provider choisi via un sélecteur "Fournisseur" dans la carte SMS de
    l'onglet Canaux (CRM et back-office) — intégré à partir de la
    documentation officielle fournie par l'utilisateur (`api.smspartner.fr/v1`,
    endpoint `POST /send`). Ce partenaire ne couvre que le SMS (pas de
    WhatsApp) et s'authentifie avec une **clé API unique** dans le corps JSON
    plutôt qu'un couple Account SID/Auth Token + en-tête Basic comme Twilio —
    d'où un champ `apiKey` dédié sur `ChannelConfig` et un client HTTP
    (`sendViaSmsPartner()`) distinct de `sendViaTwilio()`, choisi par
    `sendViaProvider()` selon `ChannelConfig.provider` (`twilio` par défaut,
    `smspartner` uniquement valide sur le canal `sms`). Le "Numéro
    expéditeur" devient un nom d'émetteur alphanumérique (3-11 caractères,
    ex. `Churchill`) chez ce partenaire, la plateforme utilisant sinon un
    shortcode opérateur par défaut. Changer de fournisseur réécrit
    entièrement la ligne `ChannelConfig` (SID/Token remis à `null` en passant
    à DocPartner, et vice-versa) pour éviter que des identifiants de l'ancien
    provider ne traînent silencieusement en base.
  - **Modèles** : un seul modèle de gabarit `{{variable}}` par canal
    (`MessageTemplate`, endpoints `/wa/messageTemplate/*`) — objet+HTML pour
    l'email, texte brut pour SMS/WhatsApp.
  - **Envoi** : `POST /wa/message/send` (`src/lib/messaging.ts`) est le point
    de convergence unique — il choisit le transport (SMTP ou Twilio) selon
    le canal demandé. Depuis une fiche CRM, "✉ Email" (canal choisi dans la
    modale) envoie un modèle au client/prospect et journalise l'envoi.
  - Chaque canal a son bouton "Tester" pour vérifier sa configuration
    indépendamment.
- **Automatisations** (onglet dédié, CRM et back-office) : des règles qui
  envoient un message sur un déclencheur métier ou une récurrence
  programmée (`src/lib/automation.ts`, `AutomationRule`, endpoints
  `/wa/automationRule/*`). Déclencheurs disponibles :
  - Hôtel : réservation créée, check-in effectué, commande créée, commande
    livrée, commande annulée (immédiats) ; **début de séjour**, **fin de
    séjour** (date pivot + délai paramétrable, voir ci-dessous).
  - CRM : nouveau prospect, contrat signé, souscription activée, souscription
    annulée (immédiats) ; **fin d'essai souscription** (date pivot + délai) ;
    newsletter récurrente (jour/heure paramétrables, ex. "tous les mois à
    11h00", avec segment d'audience Prospect/Client/secteur).
  - **Paramétrage temporel harmonisé** — un même mécanisme "Sens / Délai /
    Unité" pour tous les déclencheurs à date pivot, côté hôtel comme côté
    CRM (seuls les déclencheurs eux-mêmes diffèrent, pas la façon de régler
    "quand") : Avant/Après × une valeur × Minutes/Heures/Jours/Mois — ex.
    "J-5" (5 jours avant), "H-10" (10 heures avant), "M+1" (1 mois après).
    En base, le sens est porté par le signe d'`AutomationRule.offsetValue`
    (négatif = avant, positif = après) plutôt que par deux modes séparés ;
    les mois utilisent une arithmétique calendaire (`applyOffset()` dans
    `src/lib/automation.ts`), pas une durée fixe.
  - Les déclencheurs immédiats sont câblés en synchrone dans les routes
    concernées (`booking.ts`, `roomservice.ts`, `bookingSource.ts`,
    `crmProspect.ts`, `onboarding.ts`, `contact.ts`, `subscription.ts`) via
    `fireTrigger()` — fire-and-forget, un échec d'envoi n'interrompt jamais
    la requête métier appelante. Les déclencheurs à date pivot/récurrence
    sont balayés toutes les 15 min par `automationScheduler.ts` (même
    pattern que le planificateur de synchronisation réservations) ; "fin
    d'essai souscription" lit le modèle `Subscription`, "début/fin de
    séjour" lit `Booking`. `AutomationRuleLog` déduplique les envois (une
    ligne par règle × cible déjà notifiée).
  - **Diagnostic d'une règle** : chaque règle affiche la date/l'heure de son
    dernier envoi réussi, et — en rouge — le dernier problème rencontré
    (`lastError`/`lastErrorAt`), y compris le cas silencieux où la fiche à
    l'origine de l'événement n'a pas d'email/téléphone renseigné pour le
    canal choisi (ce n'est pas un échec d'envoi, mais rien n'est parti non
    plus — l'ancien comportement ne l'indiquait nulle part). Un bouton
    "Tester" (`POST /wa/automationRule/test`) envoie immédiatement un essai
    à une adresse/numéro donné et affiche l'erreur réelle en cas d'échec,
    sans attendre un vrai événement métier.
  - **Destinataire par règle** : par défaut celui de l'événement (email/tel
    de la réservation ou du prospect selon le canal) ; "Personnalisé"
    permet de cibler une adresse ou un **numéro mobile** fixe à la place —
    ex. notifier la réception plutôt que le client sur "Commande créée".
    Validé à la création : une adresse email est refusée sur un canal
    SMS/WhatsApp (et inversement), pour éviter d'envoyer un SMS vers un
    champ qui contient en réalité une adresse email.
  - **Expéditeur par règle** (email uniquement) : nom d'expéditeur affiché,
    remplace celui de la config SMTP pour cette règle précise sans avoir à
    multiplier les configurations SMTP (ex. "Réception Hôtel Churchill"
    pour une règle, nom de la config par défaut pour les autres).

- **Signal d'engagement entrant** (CRM uniquement) — badge "✉ N" affiché sur
  chaque fiche (liste, grille, fiche détaillée) dès qu'un prospect/client a
  répondu par email, pour confirmer son intérêt sans dépendre d'une
  déclaration manuelle. Ajouté le 18/08/2026 à la demande explicite de ne
  **pas** avoir à créer une règle Power Automate par adresse email :
  - `POST /wa/crmProspect/inboundSignal` (`src/routes/crmProspect.ts`) —
    endpoint public (pas de session admin, appelé par un flux externe),
    protégé par une clé partagée en header `X-Inbound-Secret` (comparée à
    `INBOUND_EMAIL_SECRET`, cf. `.env.example`). Reçoit `{email,
    receivedAt?}`, cherche la fiche `CrmProspect` dont l'email correspond
    (comparaison insensible à la casse) et incrémente
    `CrmProspect.inboundReplyCount` + met à jour `lastInboundReplyAt`. Une
    adresse qui ne correspond à aucune fiche renvoie `{ok:true,
    matched:false}` (pas une erreur — la plupart des emails entrants sur une
    boîte partagée ne concernent aucun contact CRM). Le **contenu** des
    emails n'est jamais stocké, uniquement un compteur.
  - **Un seul flux Power Automate générique par boîte partagée** (pas un par
    contact) : déclencheur "Quand un nouvel email arrive" sur chacune des
    boîtes `fbuis@sesame-technology.com` et `jtlod@sesame-technology.com` →
    action HTTP POST vers `/wa/crmProspect/inboundSignal` avec l'adresse de
    l'expéditeur (`From`) dans le corps — c'est le backend qui fait le
    rapprochement avec la base CRM, pas Power Automate. Deux flux à créer
    (un par boîte), tous deux pointant vers le même endpoint.

- **Assignation d'un commercial** — chaque fiche CRM (`CrmProspect.commercialId`)
  peut être rattachée à un compte Sesame (`role="sesame"`, via
  `GET /wa/commercial/list`), éditable depuis la fiche (section "Installation
  &amp; commercial" de la modale) ou à la création. Affiché en toutes lettres
  dans la fiche détaillée et en pastille d'initiales (`.commercial-chip`) dans
  la liste, la grille et les cartes du pipeline "Affaires" ci-dessous.

- **Module "Gestion des affaires"** (18/08/2026) — pipeline commercial greffé
  sur le CRM, nouvel onglet "Affaires" (`showAffaires()`), avec production de
  devis souple et automatique :
  - **CrmDeal** (`src/routes/crmDeal.ts`) : une affaire est rattachée à une
    fiche `CrmProspect` (plusieurs affaires possibles par fiche — upsell,
    renouvellement…), avec titre, étape (`Nouveau → Qualification → Devis
    envoyé → Négociation → Gagné/Perdu`), valeur mensuelle estimée,
    probabilité (0-100%) et date de clôture prévue. Vue Kanban par étape
    (`.kanban-wrap`), filtrable par commercial, avec le total (nombre +
    valeur) par colonne. Une carte "Affaires" sur chaque fiche liste les
    opportunités de ce client avec un raccourci "+ Nouvelle affaire".
  - **CrmQuote** (`src/routes/crmQuote.ts`) — devis rattaché à une affaire,
    numéroté automatiquement (`DEV-{année}-{séquence}`, ex. `DEV-2026-0001`) :
    - **Automatique** : `GET /wa/crmQuote/catalog` réexpose le même catalogue
      de modules Sesame que le wizard d'inscription (`ONBOARDING_MODULES` +
      `PricingConfig`, cf. section précédente) — une seule source de vérité
      tarifaire dans toute l'app. Cliquer un module dans le constructeur de
      devis ajoute une ligne pré-remplie à son prix courant.
    - **Souple** : les lignes (`CrmQuote.lines`, JSON libre) mélangent
      librement modules Sesame et lignes personnalisées (libellé, quantité,
      prix unitaire, mensuel/ponctuel éditables), plus une remise globale en
      %. Le total (mensuel récurrent + frais ponctuels, avant/après remise)
      est recalculé à la volée à chaque modification.
    - **Aperçu / impression** : `printQuote()` ouvre un document HTML autonome
      dans un nouvel onglet (mise en page dédiée à l'impression/export PDF
      via le navigateur, pas de dépendance PDF côté serveur) reprenant les
      lignes, le total et les notes du devis.
  - **Bug corrigé au passage** : `showFiche()` appelait `setNav('n-fiche')`,
    id d'un nav-item supprimé lors du renommage "Fiche Client" → "Home" plus
    tôt dans la session — `setNav()` levait alors une exception
    (`Cannot read properties of null`) qui interrompait le rendu, rendant
    **impossible l'ouverture de toute fiche client** depuis ce renommage.
    `setNav()` protège désormais l'ajout de la classe `active` contre un id
    sans nav-item correspondant (cas légitime : la vue fiche n'a pas
    d'entrée dédiée dans la barre latérale).

- **Gestion des utilisateurs CRM + rôle "commercial"** (18/08/2026) —
  `AdminUser.crmRole` (`admin` | `commercial`) et `AdminUser.active`
  (désactivation sans suppression, pour garder l'historique). Nouvel onglet
  "Utilisateurs CRM" (`src/routes/crmUser.ts`, `requireCrmAdmin`), masqué
  dans la barre latérale si le compte connecté n'a pas `crmRole="admin"` —
  côté serveur c'est `requireCrmAdmin` qui fait autorité, pas le masquage
  côté client. Un compte désactivé ne peut plus se connecter
  (`POST /wa/login/login`), avec le même message générique que pour un mot
  de passe incorrect (pas d'énumération). La migration bascule tous les
  comptes `role="sesame"` déjà existants sur `crmRole="admin"` pour ne
  retirer aucun accès à personne. Comptes créés avec un mot de passe
  temporaire affiché une seule fois (même mécanisme que
  `adminUser.ts`) ; réinitialisable via `POST /wa/crmUser/resetPassword`.

- **Catalogue produits Sesame (stockable / non-stockable)** — `CrmProduct`
  (`src/routes/crmProduct.ts`, onglet "Produits") : matériel et prestations
  facturables au devis (contrôles d'accès, gateway, formation…), distinct du
  catalogue "modules" SaaS utilisé pour le pricing des souscriptions. Un
  indicateur `stockable` prépare une gestion de stock à venir — `stockQty`
  existe déjà en base mais n'est lu/écrit nulle part pour l'instant,
  volontairement, tant que cette gestion de stock n'est pas construite.
  Chaque produit porte une `description` (sous-texte verbeux) reprise
  automatiquement sur la ligne de devis quand on l'ajoute depuis le
  catalogue, pour coller au format réel des devis Sesame (étudié à partir de
  deux devis réels fournis par l'utilisateur, dont un signé).

- **Modèles de devis récurrents + duplication** — répond au besoin exprimé
  de gagner du temps sur des devis verbeux et répétitifs :
  - `CrmQuoteTemplate` (`src/routes/crmQuote.ts`) : un modèle porte déjà
    toutes les lignes (libellés/descriptions/prix) ; "Charger un modèle"
    dans le constructeur de devis les applique en un clic, il ne reste plus
    qu'à ajuster les quantités à la marge. "Enregistrer comme modèle"
    inverse le sens : capitaliser un devis déjà saisi en modèle réutilisable.
  - `POST /wa/crmQuote/duplicate` clone un devis existant (même lignes/
    remise/notes, nouveau numéro, statut réinitialisé à "brouillon") —
    accessible depuis le constructeur de devis et directement depuis la
    liste des devis d'une affaire.
  - Chaque ligne de devis (`CrmQuote.lines`) porte désormais un champ
    `description` optionnel, affiché comme sous-texte en italique sous le
    libellé — sur l'écran, à l'impression (`printQuote()`) et sur la page de
    signature — pour retrouver le niveau de détail des devis Sesame réels
    (ex. "Technologies d'ouverture embarquées ; code dynamique, NFC/RFID,
    Data" sous "Contrôle d'accès Sesame Oneway").
  - **Bug corrigé au passage** : les libellés de modules/produits contenant
    une apostrophe (très fréquent en français — "Contrôle d'accès",
    "l'installation"…) cassaient l'attribut `onclick` généré pour les
    boutons d'ajout rapide au catalogue, `esc()` n'échappant que pour l'HTML
    et non pour un argument de chaîne JS entre guillemets simples. Nouvelle
    fonction `jsStr()` dédiée à cet échappement, appliquée aux deux
    catalogues (modules Sesame et produits) du constructeur de devis.

- **Signature électronique des devis + passage automatique en "Gagné"**
  (18/08/2026) — explicitement **une signature électronique simple, pas une
  signature qualifiée eIDAS certifiée par un tiers de confiance** (type
  Yousign/DocuSign) : nom saisi + tracé (canvas) + horodatage/IP/user-agent
  enregistrés à titre de preuve de consentement (`CrmQuoteSignature`), à la
  manière d'un "clic pour accepter". Ce choix est assumé et signalé
  explicitement à l'utilisateur final sur la page de signature ainsi qu'au
  commercial dans le constructeur de devis — si une valeur légale certifiée
  est nécessaire, une intégration avec un vrai prestataire d'e-signature
  serait à prévoir séparément.
  - `POST /wa/crmQuote/requestSignature` génère un `signToken` unique
    (aléatoire, 24 octets) et bascule le devis en statut "envoyé" ; le lien
    public correspondant (`/devis-signature.html?token=…`) est affiché avec
    un bouton "Copier" dans le constructeur de devis.
  - `public/devis-signature.html` — page publique autonome (sans
    authentification, le signataire n'a pas de compte CRM) : affiche le
    devis en lecture seule (même mise en forme que l'aperçu d'impression,
    descriptions incluses), capture nom + signature dessinée au doigt/à la
    souris (Pointer Events, sans dépendance externe) + consentement
    explicite, puis `POST /wa/crmQuote/sign`. Un lien déjà utilisé affiche
    "Ce devis a déjà été signé" plutôt que de permettre une double signature.
  - **Passage automatique en "Gagné"** : la signature met à jour en une
    transaction (`prisma.$transaction`) le statut du devis (`accepté`) *et*
    l'étape de l'affaire parente (`CrmDeal.stage = "Gagné"`) — comportement
    explicitement demandé, sans étape manuelle intermédiaire.

- **KPI de pipe sur Home, dédoublonnés de Vue liste** — `renderPipelineKpis()`
  (affaires ouvertes, valeur du pipe, valeur pondérée par probabilité, taux
  de conversion Gagné/(Gagné+Perdu)) affiché en tête de la page Home,
  au-dessus des indicateurs déjà existants (`renderInsights()`). Cette
  dernière carte était jusqu'ici dupliquée à l'identique sur Vue liste — son
  appel y a été retiré (18/08/2026) pour ne garder qu'un seul endroit où
  consulter ces indicateurs ; les 4 compteurs rapides propres à Vue liste
  (Clients / Risque élevé / Sans contrat / Activités totales) restent en
  place, ce ne sont pas des doublons.

- **Mot de passe oublié**, harmonisé entre le CRM (`crm.html`, comptes
  `role="sesame"`) et le back-office hôtel (`admin.html`, comptes
  `role="hotel"`) — même flux, même écran de connexion, seule la portée du
  compte concerné diffère :
  - Lien "Mot de passe oublié ?" sur l'écran de connexion → email → si un
    compte existe, un lien de réinitialisation valable 1h est envoyé
    (`POST /wa/login/forgotPassword`). Réponse strictement identique que le
    compte existe ou non, et même en cas d'échec d'envoi (uniquement
    journalisé côté serveur) — empêche l'énumération des comptes existants.
  - Le lien pointe vers `admin.html?resetToken=…` ou `crm.html?resetToken=…`
    selon le rôle du compte, et affiche un formulaire de nouveau mot de
    passe (`POST /wa/login/resetPassword`, minimum 8 caractères).
  - **Sécurité du token** (`src/lib/passwordReset.ts`,
    `PasswordResetToken`) : généré aléatoirement (32 octets), seul son hash
    SHA-256 est stocké en base (comme un mot de passe — une fuite de la
    base ne permet pas de reconstituer les tokens envoyés par email) ; à
    usage unique (marqué utilisé dès la première consommation, un rejeu du
    même lien échoue) ; expire après 1h.
  - **Envoi de l'email** : réutilise la config SMTP déjà en place pour le
    compte (celle de son établissement pour un compte hôtel, celle du CRM
    pour un compte Sesame) via `sendEmailRaw()` — avec repli automatique
    sur la config SMTP globale Sesame si celle de l'établissement n'est pas
    configurée, pour qu'un hôtel n'ayant pas encore paramétré son SMTP ne
    reste jamais bloqué hors de la page qui lui permettrait justement de le
    configurer.

- **Verrouillage de modules dans la nav du back-office** (`public/admin.html`,
  endpoints `/wa/subscription/mine`, `/wa/subscription/updateModules`,
  `/wa/subscription/requestModule`) : un panneau dont le module associé
  n'est pas souscrit reste **visible mais grisé**, avec un cadenas — cliquer
  dessus ouvre une offre de souscription (bénéfice + prix) au lieu du
  panneau.
  - Mapping panneau → module : `tarifs`→taxe, `gains`→rewards, `eco`→eco,
    `crm`/`marketing`→crm, `roomservice`/`orders`→roomservice. Les panneaux
    sans module associé (Accueil, Charte, Planning, Livret, Intégration…)
    ne sont jamais verrouillés.
  - **Aucune régression sur les établissements existants** : un
    établissement sans `Subscription` formelle (créé via le panneau Hôtels
    ou le seed, plutôt que l'inscription en ligne) n'a **rien** de
    verrouillé — le verrouillage ne s'active que si une souscription réelle
    existe et exclut explicitement le module.
  - CTA de l'offre : un compte **hôtel** envoie une demande d'activation
    (journalisée sur la fiche CRM prospect liée, pour suivi manuel par
    l'équipe Sesame — pas de paiement en ligne dans cette app) ; un compte
    **sesame** est renvoyé directement sur la fiche Souscription de
    l'établissement, où les modules sont maintenant **éditables** (cases à
    cocher, avant : figés à la création de la souscription).
  - C'est une gate de **navigation** uniquement — les endpoints API des
    panneaux concernés ne sont pas verrouillés côté serveur.
- **Bouton d'aide sur chaque panneau** (icône "?" dans la nav) : un
  popover avec le bénéfice en une ou deux phrases, sans avoir à ouvrir le
  panneau pour comprendre à quoi il sert.
- **Badge "New" dynamique** (`GET /changelog`, `src/lib/changelog.ts`) :
  affiché sur un panneau tant que sa dernière entrée de changelog a moins
  de 21 jours ; cliquer dessus explique la correction/nouveauté. Remplace
  l'ancien badge "New" codé en dur sur "Planning". Convention pour la
  suite : ajouter une entrée dans `CHANGELOG` à chaque correction/amélioration
  notable d'un panneau, rédigée pour l'utilisateur (le "quoi" et le
  "pourquoi ça vous concerne"), pas un message de commit.

- **Thèmes d'interface**, sur le CRM et le back-office : bouton palette
  dans la barre supérieure (`toggleThemePicker()`), 5 thèmes au choix —
  Signature (par défaut, bordeaux), Émeraude, Océan, Ardoise, Nuit (sombre).
  - **Préférence partagée entre les deux apps** : un seul réglage
    `localStorage.SESAME_UI_THEME`, appliqué dès le chargement de la page
    par un petit script inline placé avant la feuille de style (évite le
    flash du mauvais thème) — changer de thème dans l'un se répercute
    automatiquement dans l'autre à la prochaine ouverture.
  - **Uniquement le "chrome"** (fond de page, cartes, bordures, texte,
    couleur d'accent, survols) est thémé, via des variables CSS
    (`html[data-theme="…"]`). Les couleurs sémantiques — badges de statut,
    tags CRM (risque/contrat/secteur), points du journal d'activité,
    pastilles de statut chambre, couleurs des cartes KPI — restent
    volontairement fixes d'un thème à l'autre, pour ne jamais faire dériver
    leur sens (même principe que la palette d'un graphique, jamais recolorée
    selon le thème de l'appli).
  - À ne pas confondre avec la **charte de marque** existante (panneau
    "Logo & Couleurs" de l'admin, `THEMES`/`applyTheme()`) : celle-ci définit
    les couleurs de l'app mobile de check-in **destinée aux clients**
    (`--brand-*`, stockées dans `CFG.colors`) — sujet totalement séparé du
    thème visuel du back-office/CRM lui-même.
  - **Barre latérale de l'admin** (`--sb`) : teintée par thème plutôt que
    quasi noire partout — chaque thème a désormais un fond de sidebar dans
    la même famille que sa couleur d'accent (bordeaux pour Signature, vert
    pour Émeraude, bleu pour Océan, indigo pour Ardoise, prune pour Nuit),
    en gardant une luminosité assez basse pour le contraste avec le texte
    blanc de la navigation.
  - **Largeur du contenu** (`.ct{max-width}`) : passée de 1080px à 1400px —
    sur un écran large, l'ancienne largeur laissait beaucoup d'espace vide à
    droite, particulièrement visible sur Accueil (la grille "Indicateurs
    réels" passe de 3-4 tuiles par ligne à 7 sur un écran 1920px).

- **Corrections diverses + données réelles Churchill** (18/08/2026) :
  - **Bug corrigé — bouton "Commander" du parcours éco-checkin mal aligné**
    (`public/checkin.html`, étape Boutique) : quand le panier contenait au
    moins un article, la barre du bas affichait 3 boutons (retour / Passer /
    Commander & continuer), mais la règle CSS `.brow .btn` ne donnait
    `flex:1` qu'au dernier bouton — le bouton "Passer" du milieu restait à sa
    largeur de contenu, cassant l'alignement. Un `flex:1` par défaut sur
    tous les boutons de la barre (sauf la flèche retour, toujours
    `flex:0 0 auto`) corrige l'alignement dans tous les cas (1, 2 ou 3
    boutons).
  - **"Parcours client activés" fusionné dans "Features actives"** (fiche
    CRM `public/crm.html`) : les étapes d'onboarding et les rubriques de
    l'espace client sont des modules Sesame au même titre que WebApp/
    Check-in/etc. — elles apparaissent désormais dans une seule liste de 13
    pills (lecture et édition), et la carte KPI "Parcours client activés"
    (avec son graphique dédié) a été retirée de la page Home, qui affiche
    par ailleurs déjà "Usage des modules Sesame" et "Taux d'usage des accès".
  - **Photos de chambres + plan de l'hôtel pour Hôtel Churchill**
    (`prisma/roomMedia.ts`) : faute de plan architectural réel ou de
    shooting photo pour cet hôtel de démonstration, un plan schématique
    (SVG, 540×380) et deux photos par chambre (chambre + salle de bain,
    palette selon la catégorie A/B/C) sont générés et encodés en data URI.
    Les positions `Room.x`/`Room.y` sur le plan sont renseignées pour les 12
    chambres. `seed.ts` les pose à la création ; la migration
    `20260818180000_churchill_room_media_backfill` applique la même donnée
    aux bases déjà provisionnées (chaque valeur uniquement si encore vide —
    ne jamais écraser un plan ou des photos déjà mis en ligne depuis
    l'admin).
  - **Bug corrigé — la fenêtre de création d'un modèle d'email pouvait se
    fermer seule** (`public/admin.html` et `public/crm.html`,
    `emlOpenTemplateModal`/`openTemplateModal`) : le fond du modal se
    fermait sur tout `click` dont la cible était le fond lui-même — or
    sélectionner du texte dans le champ "Corps" (grand textarea) à la
    souris puis relâcher le clic hors du modal déclenche un `click` dont la
    cible remonte au fond (comportement standard du DOM quand `mousedown`
    et `mouseup` n'ont pas la même cible), fermant le modal en pleine
    saisie. Corrigé en ne fermant que si le `mousedown` **et** le `click`
    ont tous les deux démarré exactement sur le fond.
  - **Variables de modèle listées à l'écran** (`public/admin.html`) :
    pastilles cliquables sous le champ "Corps" ({{prenom}}, {{nom}},
    {{code}}, {{secteur}}, {{ville}}, {{total}} — celles réellement
    fournies dépendent du déclencheur d'automatisation choisi) qui insèrent
    la variable au curseur.
  - **Variables {{login}} / {{password}} / {{loginUrl}}** (`public/crm.html`,
    panneau "Utilisateurs CRM") : un bouton "Envoyer par email" apparaît
    sous le mot de passe temporaire affiché à la création d'un compte ou à
    une réinitialisation — il ouvre un envoi via un modèle email existant
    avec ces trois variables réellement renseignées (`POST /wa/message/send`,
    inchangé), pour transmettre les identifiants sans les recopier à la main.
    Envoi manuel uniquement, à la demande : pas d'email automatique.

- **Suite de corrections CRM** (18/08/2026) :
  - **Sous-section "Paramètres" dans la nav CRM** (`public/crm.html`) :
    Canaux, Automatisations et Produits, auparavant mélangés aux entrées de
    navigation métier (Home/Vue liste/Affaires/Activités/Contrats), sont
    désormais regroupés sous un label dédié "Paramètres" — Utilisateurs CRM
    (visible seulement pour un rôle admin CRM) reste juste en-dessous.
  - **Bug corrigé — les fenêtres modales (fiche client, modèles email…)
    pouvaient se fermer seules en pleine saisie** : le correctif appliqué le
    même jour au seul modal de modèle email (`emlOpenTemplateModal`/
    `openTemplateModal`) a été généralisé à **tous** les modaux `.modal-bg`
    de `crm.html` (9 occurrences — fiche client, envoi d'email, utilisateurs
    CRM, devis, etc.) ainsi qu'aux 2 modaux restants de `admin.html`
    (règle d'automatisation, module verrouillé) : même cause (un `mousedown`
    dans le formulaire suivi d'un `mouseup` sur le fond fait remonter la
    cible du `click` au fond), même correctif (fermeture conditionnée à un
    `mousedown` **et** un `click` sur le fond).
  - **Champ PMS transformé en liste déroulante** (fiche client,
    `public/crm.html`) : les 13 valeurs réellement présentes dans le
    portefeuille (`PMS_OPTIONS`, extraites de l'audit clients Sesame — Mews,
    Medialog, Thais, MisterBooking, Easy Space, TeamR, etc.) plus "Autre…"
    (révèle un champ texte libre, pour ne jamais bloquer la saisie d'un PMS
    pas encore rencontré et pour préserver telles quelles les 2 fiches
    historiques à la valeur libre "none"). Un champ libre laissait
    coexister des variantes orthographiques du même PMS (ex. "Medialog" /
    "Médialog", toutes deux conservées comme options distinctes — ce
    correctif n'a pas réécrit les fiches existantes).
  - **Graphique Home "Répartition par PMS"** (`renderInsights()`) : même
    forme que "Répartition par secteur" (liste de barres, pas un camembert
    — plus d'une dizaine de valeurs réelles rendraient un camembert
    illisible), calculé en direct depuis les fiches réelles, "none"
    regroupé avec les fiches sans PMS renseigné plutôt que traité comme un
    nom de PMS à part entière.

- **Module Tickets (support)** (19/08/2026) — un contact hôtelier ouvre un
  incident depuis un widget public, l'équipe Sesame le qualifie et y répond ;
  jusqu'ici il n'existait aucune gestion de ticket réelle (seul un panneau
  "CRM Sesame" orphelin dans `admin.html`, jamais relié à la navigation et
  entièrement en `localStorage`, en avait l'apparence — cf. constat fait à
  l'utilisateur avant ce chantier).
  - **Schéma** : `CrmTicket` (rattaché à `CrmProspect`, statut/priorité/type,
    agent assigné parmi les comptes Sesame, `publicToken` unique) +
    `CrmTicketMessage` (authorType client/agent, kind reply/note, pièces
    jointes en data URI — même convention que `Room.photos`). `SmtpConfig`
    gagne `supportFromName`/`supportFromEmail`, une identité d'expédition
    dédiée aux réponses de ticket (retombe sur l'adresse générale si vide).
  - **Widget public** (`public/support.html`, sans authentification) : un
    client ouvre un ticket (email retrouvé ou créé dans le CRM, comme le
    formulaire de contact) et reçoit un lien permanent (`?token=…`, même
    principe que `CrmQuote.signToken`) pour suivre son ticket et le
    compléter ensuite d'une note et d'une photo — sans jamais voir les notes
    internes de l'équipe support (filtrées côté serveur sur `GET
    /wa/ticket/public`).
  - **Côté CRM** (`public/crm.html`) : nouvel onglet "Support" (badge du
    nombre de tickets ouverts dans la nav, comme "Sans contrat") — file
    d'attente filtrable par statut, détail d'un ticket (qualification
    statut/priorité/type/agent, fil de discussion, réponse ou note interne).
    "Répondre" envoie un vrai email au contact (adresse support si
    configurée) et bascule automatiquement le ticket en "Attente client" ;
    "Note interne" n'est jamais envoyée. Un modèle de message existant peut
    être inséré comme point de départ de la réponse (variables substituées,
    éditable avant envoi) — répond au besoin de préparer des réponses types.
    Badge "☎ N" sur chaque fiche client (liste, grille, fiche détaillée),
    à la manière du badge d'engagement entrant (✉ N) déjà existant.
  - **Automatisations** : deux nouveaux déclencheurs CRM,
    `crm.ticket_created` et `crm.ticket_client_replied` (notification interne
    de l'équipe support, via un destinataire personnalisé sur la règle —
    aucun email n'est envoyé au client par ces déclencheurs, seulement par
    "Répondre").
  - Un client qui complète un ticket déjà fermé le rouvre automatiquement
    (statut "En attente") — revenir sur un incident qu'on croyait résolu est
    le signal même qu'il ne l'est pas.

- **"Features actives" renommé en "Options actives"** (fiche client et
  modal d'édition, `public/crm.html`) — pur changement de libellé affiché,
  aucun changement de comportement.

- **Décompte total des modules sur le graphique Home** (`renderInsights()`)
  — le graphique "Usage des modules Sesame" se limitait jusqu'ici à 4 des 13
  "Options actives" (WebApp/Mobile V2/Check-in/Offline), un reliquat de
  l'époque où la carte "Parcours client activés" couvrait les 9 autres ;
  cette carte ayant été supprimée le 18/08/2026 (fusionnée dans "Options
  actives" sur la fiche), le graphique couvre maintenant les 13 options, en
  affichant le nombre brut de fiches concernées à côté du pourcentage
  ("54 (77%)" plutôt que "77%" seul), plus un total agrégé dans l'en-tête de
  la carte (somme de toutes les options actives, tous types confondus).

- **Options actives affichées sur un ticket** (`showTicketDetail()`) — la
  liste des 13 options actives du client (même composant que sur la fiche,
  factorisé dans `featDefFor()`) apparaît maintenant sur l'écran de détail
  d'un ticket, pour que l'agent support voie d'un coup d'œil ce que le
  client a réellement activé sans changer d'onglet.

- **Champ Adresse obligatoire + autocomplétion OpenData** (fiche client CRM,
  `public/crm.html` + `src/routes/crmProspect.ts`) — le nom du client seul
  ne suffisait pas à identifier une fiche de façon fiable ; `CrmProspect`
  gagne un champ `adresse` (voie), désormais obligatoire avec `ville` (déjà
  existant) à la création **et** à la modification complète d'une fiche
  depuis la modale — validé côté serveur (mêmes routes que `nom`) donc pas
  contournable en appelant l'API directement. Les mises à jour partielles
  existantes (`setContrat()`, qualification de ticket, etc.) ne sont pas
  affectées : la validation ne se déclenche que si `adresse`/`ville` sont
  explicitement envoyés vides, jamais quand ils sont absents de la requête —
  et les fiches déjà existantes sans adresse restent consultables, seule
  leur **prochaine** modification via la modale l'exige.
  - **Autocomplétion** via l'API Adresse (BAN — Base Adresse Nationale,
    data.gouv.fr) : gratuite, sans clé, appelée directement depuis le
    navigateur (CORS déjà activé côté data.gouv.fr, pas de proxy backend
    nécessaire). Taper 3 caractères ou plus déclenche une recherche
    debattue (300 ms) ; sélectionner une suggestion remplit adresse et
    ville d'un coup. Si l'API est indisponible (réseau, quota, etc.), la
    liste de suggestions se masque simplement — la saisie manuelle reste
    toujours possible, ce n'est jamais bloquant. **Non vérifiable dans cet
    environnement de développement** (pas d'accès sortant à
    `api-adresse.data.gouv.fr` depuis ce sandbox) : le code est écrit et
    testé pour le comportement de repli (échec réseau → champ manuel), mais
    l'appel réel à l'API n'a pas pu être vérifié en conditions réelles ici,
    seulement écrit d'après la documentation publique de l'API (recherche
    par texte libre, réponse GeoJSON avec `properties.name`/`.city`/
    `.label`) — à confirmer après déploiement.

- **Identité légale (dénomination sociale, SIRET, SIREN) sur la fiche
  client** (19/08/2026) — `nom` reste le nom d'usage affiché partout
  (listes, badges, graphiques), mais ne permettait pas de retrouver ou
  saisir la raison sociale exacte ni le SIRET d'un client. `CrmProspect`
  gagne 3 champs libres (`denominationSociale`, `siret`, `siren`),
  éditables directement dans la modale de la fiche ("Identité légale") :
  - **Recherche d'entreprise** via l'API publique du même nom
    (`recherche-entreprises.api.gouv.fr`, gratuite, sans clé, interroge le
    répertoire SIRENE de l'INSEE) : taper une dénomination ou un SIRET dans
    le champ de recherche affiche les correspondances, en sélectionner une
    remplit dénomination + SIRET + SIREN d'un coup. Même repli non bloquant
    que l'autocomplétion d'adresse en cas d'échec réseau. **Non plus
    vérifiable en conditions réelles depuis ce sandbox** (même limitation
    réseau que l'API Adresse) — à confirmer après déploiement.
  - Saisir un SIRET à la main déduit automatiquement le SIREN (ses 9
    premiers chiffres) sans avoir à le ressaisir.
  - Aucun des 3 champs n'est obligatoire (contrairement à adresse/ville) :
    l'information n'est pas toujours disponible ou pertinente selon le
    client.

- **Total du graphique "Usage des modules Sesame" corrigé** — additionnait
  jusqu'ici les 13 "Options actives" (booléens), un chiffre qui n'a pas de
  sens business réel puisque ces options ne couvrent pas tous les modules
  Sesame effectivement installés. Il additionne maintenant le champ "Nb
  modules" (`c.modules`, saisi depuis l'audit clients) de chaque fiche —
  c'est ce champ, pas les 13 booléens, qui est la source officielle du
  nombre de modules Sesame par client.

- **Bug corrigé — config d'un compte hôtel affichant celle d'un autre
  établissement** (`loadCfg()`) : `GET /entityModuleConfig/list` est
  volontairement public côté serveur (le parcours client en a besoin sans
  JWT admin), donc `resolveEntity()` retombe sur l'établissement par défaut
  quand ni JWT ni `entityCode` ne sont fournis. Côté front, `loadCfg()`
  passait par `withEntityCode()`, qui n'ajoute `entityCode` que pour un
  compte **sesame** (bascule multi-établissements) — un compte **hotel**
  partait donc sans aucun moyen d'identifier son propre établissement, et
  voyait systématiquement la configuration (nom, couleurs, tarifs, gains…)
  de l'établissement par défaut au lieu de la sienne. Corrigé en forçant
  l'`entityCode` de l'établissement actif dans cet appel, quel que soit le
  rôle du compte.

Également non couvert : l'app ménage (`sesame_menage.html`, application
séparée pour les agents de ménage sur le terrain). La base de données est
déjà prête à la recevoir (`RoomHousekeepingStatus`, `HousekeepingTask`,
`HousekeepingStaff`).

La simulation KYC (OCR / selfie / correspondance biométrique) reste
volontairement côté client uniquement, comme dans le prototype d'origine —
aucun service de vérification d'identité réel n'a été demandé ni intégré.

### MRR sur la fiche client + tableau "Portefeuille" (MRR / Signé / Prévisionnel)

- **Schéma** : `CrmProspect` gagne 3 champs (`mrr`, `signe`, `previsionnel`,
  tous `Float?`, `prisma/schema.prisma`). `mrr` est le seul alimenté par
  import ; `signe`/`previsionnel` sont purement des saisies manuelles — il
  n'existe pas de source fiable pour ces deux notions dans les fichiers
  fournis (voir plus bas), donc aucune tentative de les déduire
  automatiquement.
- **Import MRR** : rapprochement par nom entre l'onglet "2026" (section
  "Récurent", 36 clients avec un montant mensuel constant sur les colonnes
  janv.-déc.) d'un fichier de trésorerie fourni et les 68 fiches
  `CrmProspect`. Rapprochement flou (tokens normalisés, sigles/raisons
  sociales différents entre les deux sources) puis vérifié à la main —
  **12 correspondances** jugées fiables ont été retenues (ex. "SAS 15
  ASTORG" → fiche "ASTORG", "HÔTEL L'AUBERG'INE" → fiche "AUBERG'INE") ; les
  24 autres lignes du fichier ne correspondent à aucune fiche existante (pas
  de faux rapprochement forcé — mieux vaut un MRR manquant qu'un MRR sur le
  mauvais client). Champ affiché en lecture sur la fiche (juste après
  "Modules") et éditable dans le modal de fiche (`#m-mrr`) comme dans le
  nouveau tableau Portefeuille.
- **Import Adresse** : même principe de rapprochement flou entre un export
  d'entreprises (`pmexport.xls`, colonnes Nom/Adresse/CP/Ville) et les
  fiches — **31 correspondances** retenues et appliquées uniquement aux
  fiches dont l'adresse était encore vide (aucune adresse saisie à la main
  n'a été écrasée). Un cas ("Maison Roquelongue") avait une adresse
  imprononçable dans la source (placeholder `[ND] [ND] [ND]`) : seule la
  ville a été reprise. Les rapprochements ambigus (plusieurs fiches
  distinctes pointant vers la même ligne source, ex. les 3 "La Péniche…", ou
  un score de correspondance trop faible/à égalité) ont été exclus plutôt
  que devinés.
- Les deux imports sont rejoués comme migration Prisma
  (`prisma/migrations/20260819050000_crm_prospect_mrr_adresse_backfill`,
  guardée par `IS NULL` — n'écrase jamais une valeur déjà présente) pour que
  tout environnement provisionné à partir du même seed déterministe
  (68 fiches) hérite des mêmes données sans reseed complet.
- **Tableau "Portefeuille"** (nouvel item de nav `public/crm.html`,
  `showPortefeuille()`/`renderPortefeuille()`) : liste tous les clients avec
  3 colonnes éditables en ligne (MRR, Signé, Prévisionnel) + une colonne
  "Total" calculée par ligne et une ligne de pied de tableau qui additionne
  les 3 compteurs sur l'ensemble des clients affichés (recherche incluse).
  Chaque cellule sauvegarde individuellement au blur (`pfSave()` →
  `POST /crmProspect/update` avec un seul champ, pattern déjà utilisé
  ailleurs dans le CRM pour les mises à jour partielles) ; les totaux se
  recalculent en direct pendant la frappe (`pfLive()`, avant même la
  sauvegarde) pour que l'addition soit immédiate.
- À noter comme pour les précédents imports OpenData : le rapprochement par
  nom est fait au meilleur effort sur des données d'origine hétérogène
  (raisons sociales, sigles, orthographes différentes entre les fichiers et
  le CRM) — les correspondances retenues ont été relues une à une, mais une
  vérification humaine du résultat final reste recommandée avant de
  considérer ces chiffres comme définitifs.

### Panneau "Trésorerie" — vision annuelle du prévisionnel de trésorerie

Suite du point précédent : après une maquette HTML testée en aparté
(validée par l'utilisateur), la fonctionnalité a été codée et déployée dans
l'app (19/08/2026).

- **Schéma** : nouveau modèle `CrmCashLine` (`prisma/schema.prisma`) —
  lignes datées `kind` ∈ `signe | pipeline | depense | solde_depart`,
  `annee`, `label`, `montant`, `proba` (pipeline uniquement),
  `mois` (0-11 ; `null` = non placé pour signé/pipeline, ou récurrent
  chaque mois pour une dépense), `prospectId` optionnel. Le MRR n'a **pas**
  de ligne dédiée : il reste porté par `CrmProspect.mrr`, seule source de
  vérité (fiche, tableau Portefeuille et panneau Trésorerie affichent tous
  la même valeur, éditable depuis n'importe lequel des trois). Distinct des
  champs `signe`/`previsionnel` du tableau "Portefeuille" (un seul montant
  sans date, non touché par ce chantier) — les deux fonctionnalités
  coexistent.
- **Backend** : `src/routes/crmCashLine.ts` — CRUD standard
  (`GET /crmCashLine/list?annee=`, `POST /create|update|delete`), réservé
  aux comptes Sesame comme le reste du CRM interne.
- **Import des données réelles** : rejoué comme migration
  (`prisma/migrations/20260819083000_crm_cash_line_2026_import`, idempotente
  via `NOT EXISTS`) — 65 lignes "signé" et 86 lignes "dépense" reprises
  telles quelles du fichier de trésorerie fourni (mêmes totaux mensuels que
  le fichier source, vérifiés poste par poste), 13 lignes "pipeline"
  (montant + probabilité, mois de clôture laissé à `null` — n'existait pas
  dans la source, à choisir dans l'app) et 1 ligne "solde de départ"
  (30 000 €, repris de "Solde n-1").
- **Frontend** (`public/crm.html`) : nouvel item de navigation
  "Trésorerie" (`showTresorerie()`/`renderTresorerie()`) — 4 cartes de
  saisie (MRR récurrent, Signé en cours, Pipeline pondéré, Dépenses
  récurrentes ; chaque panneau défile en interne au-delà de 360px pour ne
  pas allonger la page avec ~250 lignes de données réelles), une carte
  "Vision annuelle" avec un graphique Recettes vs Dépenses par mois, un
  graphique de trésorerie cumulée (aire verte/rouge selon le signe) et un
  tableau mensuel compact — tout se recalcule en direct à la frappe
  (`trRenderCharts()`) et se sauvegarde par cellule au blur/changement
  (`trSave()`, `trMrrSave()`, `trStartBalanceSave()` → routes ci-dessus ou
  `POST /crmProspect/update` pour le MRR). Couleurs de catégorie fixes
  (`--tr-mrr/--tr-signe/--tr-pipeline/--tr-depense`) déclinées dans les 5
  thèmes de l'app, sur le même principe que les couleurs déjà fixes du
  donut NFC/Code/Mobile/QR (`--dch-*`).
- **Écart à noter** : le panneau MRR de Trésorerie n'affiche que les 12
  clients dont la fiche CRM porte un `mrr` (2 001 €/mois), alors que le
  fichier source recense 36 comptes récurrents (9 178 €/mois) — les 24
  autres n'ont pas de fiche CRM correspondante. Créer des fiches pour ces
  24 comptes ferait remonter le panneau au chiffre complet, mais c'est un
  choix de fond (ajouter des entrées au portefeuille CRM) qui n'a pas été
  pris unilatéralement — à trancher avec l'utilisateur.

### Options actives décochées par défaut + type de module (Sesame/Ttlock) + décompte KPI

- **Décochage des 7 options** ("Choix chambre", "Occupant", "Identité",
  "Ménage", "Boutique", "Points fidélité", "Évènements") sur toutes les
  fiches client, à la demande explicite de l'utilisateur — déjà fait une
  fois plus tôt dans le projet, mais n'avait pas survécu à un reset de
  l'environnement de dev (fait en direct sur la base, jamais rejoué en
  migration). Cette fois : migration
  (`prisma/migrations/20260820100000_crm_prospect_disable_7_options`) **et**
  changement du défaut du seed (`prisma/seed.ts`,
  `journeyFlagsFor()` retourne désormais `false` pour les 7 — l'ancienne
  logique par secteur/"universel" est retirée) pour qu'un environnement
  entièrement reseedé reparte déjà décoché, sans avoir à rejouer cette
  correction une troisième fois.
- **Type de module installé** : deux cases à cocher indépendantes
  (`CrmProspect.moduleSesame`, `moduleTtlock`) ajoutées en face du champ
  "Nb modules" dans le modal de fiche (`public/crm.html`) — un client peut
  avoir les deux (transition de l'un vers l'autre). Affichées en pastilles
  sur la fiche à côté du nombre de modules.
- **Décompte par type au niveau du KPI** : nouvelle carte "Type de module
  installé" dans le tableau de bord Home/Insights (`renderInsights()`),
  même forme (barres + %) que les cartes voisines — nombre de clients
  Sesame vs Ttlock sur l'ensemble du portefeuille.

### Formulaire de contact du site web — vérifié à nouveau, backend OK

Signalé comme "ne fonctionne plus". `POST /contact` (`src/routes/contact.ts`)
re-testé en direct (`curl`) : crée bien un `CrmProspect` (type Prospect,
trouvé/créé par email) et une activité "Relance" — réponse `201 {ok:true}`,
aucune régression décelée côté backend, code inchangé depuis le 15/08. Le
formulaire lui-même vit sur un site externe qui n'est pas dans ce dépôt,
donc invisible d'ici — je ne peux pas voir ce que le navigateur envoie
réellement. Pour aller plus loin il faut soit l'URL exacte appelée par le
formulaire (peut-être qu'elle ne pointe plus vers ce déploiement), soit le
message d'erreur/l'onglet Réseau du navigateur au moment de l'échec.

**Suite de l'investigation (19/08/2026)** : l'onglet Réseau du navigateur,
sur le site externe (chatgpt.site), montre que le formulaire poste vers
`/contact` sur son **propre** domaine (pas vers ce backend), et reçoit
`{"ok":true,"mode":"crm-only","provider":null,"crm":true,"confirmation":false}`
— une forme de réponse qui n'est pas la nôtre (`/contact` de ce dépôt
renvoie juste `{"ok":true}`). Ce n'est donc pas une régression du code :
le formulaire n'a jamais été branché sur ce backend, il tape sur un
endpoint simulé du site-builder qui l'a généré. Pas d'action possible côté
code de ce dépôt tant que le formulaire externe n'est pas reconfiguré pour
poster vers `<déploiement>/contact` avec `{nom, email, secteur?, message}`.

### Nombre d'accès sur la fiche client

Nouveau champ `CrmProspect.nbAcces` (Int, défaut 0) — nombre de points
d'accès (portes/serrures) installés chez le client. Champ numérique ajouté
juste après les cases "Type de module" (Sesame/Ttlock) dans le modal de
fiche, et affiché sur la fiche à côté de "Modules".

### Fuseau horaire de l'hôtel

Nouveau champ `EntityModuleConfig.timezone` (String, défaut `Europe/Paris`,
identifiant IANA) — configurable dans le panneau "Hôtel" (`public/admin.html`)
via un sélecteur listant les fuseaux pertinents pour un établissement
(métropole, DOM-TOM, pays limitrophes) et dans la modale rapide "Hôtels
[Multi]" (Sesame uniquement, `hmOpenEdit()`), pour que "aujourd'hui" reflète
le fuseau de l'établissement plutôt que celui du serveur (souvent UTC en
production) ou du navigateur qui consulte l'admin (ex. équipe Sesame à Paris
gérant un hôtel à la Réunion).

Surfaces effectivement rendues tz-aware (calcul de "aujourd'hui" remplacé
par un équivalent qui lit `CFG.timezone`) :
- **Arrivées du jour** (`public/admin.html`, `renderReservations()`) —
  liste et statut "Expirée" des réservations.
- **KPI / tableau de bord** (`kpiComputeRange()`) — présets de période
  (7 jours, mois en cours, mois dernier, année).
- **Planning ménage** (`getDays()`, `renderPlanGrid()` et ses variantes
  par agent/par séjour) — colonne "aujourd'hui" et date par défaut d'une
  nouvelle intervention.
- **Commandes boutique/room-service** (`renderOrders()`) — statistique
  "livré aujourd'hui".
- **Espace client** (`public/checkin.html`) — statut "séjour en cours" pour
  l'édition des préférences ménage, et statut "En cours/À venir/Terminé"
  de l'historique des séjours.
- **Moteur d'automatisation** (`src/lib/automation.ts`, `sweepDateRule()`)
  — pour les règles avant/après séjour avec un offset en jours ou en mois
  (ex. "J-1 avant arrivée"), la date pivot est ancrée sur le jour calendaire
  actuel à l'hôtel (fuseau de l'entité de la règle) plutôt que sur l'heure
  serveur ; les offsets en heures/minutes restent calculés sur l'instant
  précis (notion sans ambiguïté de fuseau).

Nouvelle librairie partagée `src/lib/timezone.ts` (`todayInTz`, `hourInTz`,
`weekdayInTz`, `dayOfMonthInTz`, via `Intl.DateTimeFormat` — aucune
dépendance externe) côté backend, et `hotelToday()`/`hotelNow()` (même
principe) dupliquées côté client dans `admin.html` et `checkin.html`.

**Non couvert par ce passage** (mentionné pour transparence, pas un oubli) :
quelques usages secondaires et cosmétiques de `new Date()` identifiés mais
volontairement laissés tels quels — graphique de revenus CRM, compte à
rebours d'essai d'abonnement (portée CRM, pas par hôtel), dates par défaut
de documents/factures et export PDF, activités CRM. La date d'expiration
d'un document KYC scanné par un client (`checkin.html`) reste elle aussi
dans le fuseau du client, pas de l'hôtel — ça n'aurait pas de sens
autrement. Le moteur de newsletters récurrentes (jour/heure programmés,
`automation.ts`) reste à portée CRM (non rattaché à une entité hôtel) et
n'a donc pas été rendu tz-aware dans ce passage. Par ailleurs, un défaut
préexistant et distinct (round-trip `date.toISOString().slice(0,10)` sur
des chaînes de date déjà "date-only" dans `housekeepingTask.ts` et
`taxeSejourRecord.ts`) a été identifié mais n'a pas été retouché ici — il
n'est fiable que par coïncidence quand les deux bouts sont ancrés en UTC,
et mériterait un passage dédié.

### Parcours client (checkin.html) traduit en FR/EN/ES, sélecteur de langue

Le parcours client (recherche de réservation, choix de chambre, occupants,
taxe de séjour, KYC, préférences éco, boutique/room-service, récompenses
& paiement, espace client post check-in) fonctionne désormais en français,
anglais et espagnol, avec un sélecteur `FR`/`EN`/`ES` dans l'en-tête —
le choix appartient au CLIENT (pas au fuseau/langue du navigateur ni à la
langue par défaut de l'hôtel `CFG.lang`, qui ne sert que de valeur de
départ) : persisté en `sessionStorage` pour la durée de la visite, et
n'écrase jamais `CFG.lang` côté hôtel. Changer de langue re-rend
immédiatement l'écran affiché, sans rechargement de page.

Infrastructure : ~360 clés `I18N_FR`/`I18N_EN`/`I18N_ES`, fonctions
`t(key)`/`tf(key, vars)` (interpolation), `data-i18n`/`data-i18n-html`/
`data-i18n-placeholder`/`data-i18n-title` sur le markup statique,
`applyStaticTranslations()` + `rerenderCurrentView()` appelés à chaque
changement de langue. Le back-office admin (`admin.html`, réservé au
personnel) reste en français pour l'instant — même squelette i18n
disponible si un passage similaire est demandé plus tard.

**Non traduit, volontairement** : le contenu saisi par l'hôtel lui-même
(catalogue boutique/room-service, message éco personnalisé, paliers de
fidélité, libellés des points d'accès, rubriques du livret digital, noms
de chambres/clients) — ce sont des données métier par établissement, pas
de l'habillage de l'app ; les traduire impliquerait des champs
multilingues côté admin, hors périmètre de ce passage.

### Module Trésorerie simplifié (20/08/2026)

Retour à un modèle plus simple, sur demande explicite : suppression du
détail par client ("Signé en cours") et par prospect ("Pipeline pondéré"),
remplacés par deux catégories génériques récurrentes —
`CrmCashLine.kind` = `revenu` (fréquence mensuelle, trimestrielle ou
annuelle) ou `depense` (fréquence mensuelle ou annuelle uniquement,
pas de trimestriel). Le solde de départ (`solde_depart`) est inchangé.

Chaque catégorie bascule indépendamment entre **saisie globale** (un seul
montant + une fréquence, ex. "8 000 €/mois") et **saisie détaillée**
(plusieurs lignes, chacune avec son propre montant/fréquence) via
`CrmCashSettings` (une ligne par année). En mode global, les éventuelles
lignes détaillées existantes restent visibles en lecture seule avec leur
somme annualisée et l'écart par rapport au montant global saisi — sert à
vérifier que le détail reste cohérent avec le chiffre global sans avoir à
choisir entre les deux façons de saisir.

Le MRR (`CrmProspect.mrr`) et le tableau "Portefeuille" sont inchangés —
seul le panneau Trésorerie ne les affiche plus.

**Données supprimées** (migration
`20260820140000_crm_cash_line_simplify`, sur confirmation explicite) :
toutes les lignes "Dépenses" existantes (86), "Signé en cours" (65) et
"Pipeline pondéré" (13) — aucune ne correspond au nouveau modèle
(fréquence au lieu d'un mois ponctuel, pas de lien client/fournisseur).
Le solde de départ (1 ligne) est conservé.

### Trésorerie : mois pour les entrées ponctuelles + mois du solde d'ouverture

Deux ajustements sur le module simplifié le 20/08/2026 :

- La fréquence "Annuel" est renommée **"Ponctuel"** (encaissement comme
  dépense) — c'est le même mécanisme (un montant qui ne tombe qu'un seul
  mois dans l'année plutôt que tous les mois ou tous les 3 mois), mais le
  mot "Annuel" prêtait à confusion en laissant penser à une récurrence
  automatique d'une année sur l'autre, alors que chaque année se saisit
  indépendamment (`CrmCashLine.annee`). Le sélecteur "Mois" apparaît dès
  que la fréquence n'est pas "Mensuel", pour les deux catégories.
- Le **solde d'ouverture** (`CrmCashLine.kind="solde_depart"`) porte
  désormais un mois (`mois`, 0-11, janvier par défaut) au lieu d'être
  toujours implicitement "au 1er janvier" — utile pour un établissement
  qui démarre le suivi de trésorerie en cours d'année. La trésorerie
  cumulée (graphique et tableau mensuel) n'affiche rien (`—`) pour les
  mois précédant le mois du solde — elle n'a pas de sens tant que le
  point de départ n'est pas encore atteint.

### Trésorerie : les mois avant le solde d'ouverture ignorent aussi encaissement/dépenses, catégories renommées

Suite au retour du 20/08/2026 : afficher les encaissements/dépenses des
mois précédant le solde d'ouverture faussait le graphique "Encaissement
vs dépenses" (des lignes récurrentes mensuelles apparaissaient sur des
mois hors période suivie). `trComputeMonthly()` met désormais aussi à
zéro `revenu`/`depenses` pour ces mois (pas seulement la trésorerie
cumulée) — le graphique et le tableau mensuel n'affichent donc plus rien
avant le mois du solde.

Les catégories "Encaissement récurrent" et "Dépenses récurrentes" sont
renommées **"Encaissement"** et **"Dépenses"** — le mot "récurrent(es)"
n'était plus exact depuis l'ajout de la fréquence "Ponctuel".

### Affaires : montant ponctuel + mois d'encaissement, reporté sur la Trésorerie

Une affaire (`CrmDeal`, module "Gestion des affaires") porte désormais
deux champs supplémentaires, distincts du MRR estimé ("Valeur mensuelle")
déjà existant : **Montant ponctuel** (€, ex. frais de mise en service,
vente ponctuelle) et **Mois d'encaissement** (0-11). Pondéré par la
probabilité de l'affaire déjà saisie, ce montant est reporté
automatiquement sur le panneau Trésorerie — catégorie "Encaissement",
mois choisi — sans ressaisie manuelle d'une ligne `CrmCashLine`.

Comportement : ignoré si l'affaire est au stade "Perdu" ; s'additionne au
total déjà affiché (mode global ou détaillé), avec une mention "dont X €
pondéré depuis les affaires en cours" sur la carte pour rester traçable ;
suit la même règle que le reste de la Trésorerie pour les mois avant le
solde d'ouverture (ignoré, cf. ci-dessus).

Sur le graphique "Encaissement vs dépenses par mois", ce pipeline
pondéré s'affiche désormais dans une **couleur distincte** (doré,
`var(--tr-pipeline)`), empilée au-dessus de l'encaissement "ferme"
(lignes/saisie globale, bleu) — légende et infobulle mises à jour en
conséquence.

### Onboarding : étape "Modèle tarifaire" — v1 du "forfait zéro" (20/08/2026)

Suite à la validation du concept (maquette autonome), le parcours
d'inscription en ligne (`public/onboarding.html`) intègre désormais une
nouvelle étape **"Tarif"** (4ᵉ sur 6, entre "Options" et "Récap") où le
prospect choisit entre deux modèles :

- **Abonnement classique** (comportement historique, sélectionné par
  défaut) : le total mensuel calculé à partir de la grille + options
  cochées, facturé comme avant.
- **Forfait zéro** : aucun abonnement fixe — Sesame prélève 10 % des
  économies de ménage (temps de ménage évité × taux horaire) et 10 % du
  chiffre d'affaires room service généré via la plateforme. Le récap
  affiche l'équivalent classique à titre de comparaison mais aucun
  montant fixe n'est facturé.

Le choix est envoyé au serveur (`POST /onboarding/register`) et persisté
sur la fiche `Subscription` via deux nouveaux champs : `pricingModel`
(`flat` par défaut | `roi_share`) et `roiSharePct` (10 par défaut). Pour
`roi_share`, `basePrice`/`modulePrices`/`monthlyTotal` sont mis à `0` en
base — afin de ne pas fausser les agrégats MRR existants (panneau
"Souscriptions", "Comptes clients") avec un forfait fantôme. La note
CRM automatique créée à l'inscription (`crmActivity`) mentionne le
modèle choisi.

**Important — périmètre v1** : cette étape capture uniquement le choix
fait à l'inscription. Le moteur de calcul mensuel réel du "forfait
zéro" (agrégation des ménages évités et des commandes room service par
établissement, facturation effective des 10 %) **n'est pas encore
implémenté** — à construire dans une itération ultérieure. Le panneau
"Souscriptions" du back-office n'affiche pas non plus (encore) de badge
distinguant les abonnements `roi_share` des abonnements classiques.

### Forfait zéro : clarification "0 € d'abonnement", barème horaire par pays, CGV

Trois ajustements sur l'étape "Modèle tarifaire" ci-dessus, suite aux
retours après validation :

- **0 € clarifié.** Le libellé et le détail de la carte "Forfait zéro"
  insistent désormais explicitement sur l'absence de tout forfait fixe
  ("0 € d'abonnement, aujourd'hui comme demain") et sur le livrable
  concret côté Sesame : un **récapitulatif mensuel des journées de
  ménage économisées**, transmis à l'hôtel — la commission de 10 % ne
  s'applique qu'aux économies constatées dans ce récapitulatif.
- **Barème horaire ménage par pays.** Le taux horaire utilisé pour
  chiffrer les économies de ménage (`entityModuleConfig.kpi.hourlyRate`)
  est désormais pré-rempli à l'inscription selon le pays de
  l'établissement (barème indicatif : France 22, Belgique 24, Suisse
  32, Luxembourg 25, Maroc 25, Espagne 14, Italie 16, autre 20 — en
  devise locale), au lieu d'une valeur unique fixe (22 €/h). Table
  côté serveur dans `src/routes/onboarding.ts`
  (`HOUSEKEEPING_HOURLY_RATE_BY_COUNTRY`, seule source qui fait foi),
  mirroir côté client dans `OB_COUNTRY_DEFAULTS`
  (`public/onboarding.html`) pour l'affichage indicatif à l'étape
  Tarif. Toujours ajustable ensuite par l'hôtel dans Admin →
  Paramètres éco.
- **Lien vers les conditions générales.** La carte "Forfait zéro"
  pointe vers une nouvelle page `public/cgv-forfait-zero.html`
  détaillant le principe, le mode de calcul et le fonctionnement du
  récapitulatif mensuel — explicitement marquée comme document de
  travail non contractuel, en attente de validation juridique avant
  toute signature.
- **Récapitulatif : plus de faux prix d'option, exemple chiffré ajouté.**
  La carte "Options sélectionnées" du récapitulatif affichait "+12 €/mois"
  pour une option même en forfait zéro, alors qu'aucune option n'y est
  facturée séparément — corrigé (affiche "Inclus" pour toutes les
  options quand `pricingModel === 'roi_share'`). La carte "Modèle
  tarifaire" ajoute un exemple concret chiffré (ex. 10 h de ménage
  économisées × taux horaire du pays + 300 € de commandes room service
  → total facturé ce mois-là à 10 %), pour rendre le calcul tangible
  avant de choisir.

### Intégration réservations : fuite inter-établissements — filtre anti-fuite actif par défaut

Un établissement ("Deer Forest") a reçu des réservations d'un autre
établissement ("Le Victor") via le connecteur "Intégration réservations"
(source "Sesame Technology", authentification à profils multiples — un
même compte externe a accès à plusieurs hôtels). Un premier filtre
(`resultEntityField`) avait déjà été ajouté le 18/08/2026 suite à une
fuite similaire, mais restait **optionnel**, dans la section repliable
"Réglages techniques avancés" — repliée automatiquement dès qu'un
connecteur préréglé est appliqué (`bsRenderPresetVars`), donc facile à
ne jamais ouvrir en configurant un nouvel établissement. Deux bugs
corrigés dans `src/lib/bookingSource.ts` :

- **Extraction codée en dur.** Le champ utilisé pour lire l'identifiant
  d'établissement DANS LE PROFIL de connexion était figé sur le nom
  littéral `"entityId"`, alors que le champ de filtrage côté
  réservations/chambres (`resultEntityField`) était configurable — si
  l'API externe nomme ce champ différemment dans son profil, l'extraction
  échouait silencieusement et le filtre ne s'appliquait jamais, sans
  erreur visible. Nouveau champ `resultEntityProfileField` (dot-path
  dans le profil, défaut `"entityId"` si vide) pour découpler les deux.
- **Filtrage passé d'opt-in à activé par défaut.** Dès qu'un tableau de
  profils est configuré (`loginProfileListPath`/`MatchField`/`MatchValue`),
  le filtre s'applique désormais automatiquement (`resultEntityField`/
  `resultEntityProfileField` valent `"entityId"` si laissés vides) —
  au lieu de rester inactif tant que personne n'a rempli ces champs à la
  main. Si la valeur ne peut pas être extraite du profil, la
  synchronisation échoue explicitement (message dans "Dernière synchro")
  plutôt que d'importer sans filtrer. Nouveau champ `skipEntityFilter`
  (case à cocher, décochée par défaut) pour les rares sources déjà
  cloisonnées côté API, qui n'ont pas besoin de ce filtre.

Migrations `20260824120000_booking_source_result_entity_profile_field`
et `20260824121500_booking_source_skip_entity_filter`. Testé (script
autonome simulant une API à profils multiples nommant l'identifiant
`hotelId` plutôt que `entityId`) : sans configuration explicite, la
synchronisation échoue désormais avec un message clair au lieu de fuiter
des données ; avec `resultEntityProfileField` renseigné, seules les
réservations du bon établissement sont importées ; avec
`skipEntityFilter` activé, le filtre est bien contourné comme demandé.
Testé aussi côté panneau Admin (Playwright, sur un établissement de test
pour ne pas toucher la configuration réelle d'Hôtel Churchill) : les
nouveaux champs s'affichent, s'enregistrent et persistent après
rechargement.

### Réservations : écran de détail + encodage NFC (connecteur générique, inerte tant que non configuré)

Sur le panneau "Réservations", cliquer sur une réservation ouvre désormais
un écran de détail (code, statut, client, "Accès" = chambre assignée,
source, dates, dernière mise à jour, badge NFC) avec un bouton "Encoder
NFC". Comme demandé, la fonction d'encodage passe par une API côté
serveur — mais sur le MÊME principe de connecteur générique déjà utilisé
pour les réservations/chambres (`BookingSourceConfig`), pas une intégration
figée sur un prestataire précis : personne, y compris nous, n'a pu
confirmer l'existence ni la forme exacte d'un endpoint d'encodage NFC sur
l'API "Sesame Technology" déjà branchée pour les réservations — ça reste à
vérifier (capture réseau F12 sur le produit réel pendant un encodage).

- Nouveaux champs `BookingSourceConfig.nfcEndpointPath/Method/BodyFormat/
  BodyParams/CodeParam/ResponseCountPath` (section "Encodage NFC", même
  connexion/auth que le reste du connecteur — cf. `src/lib/bookingSource.ts`,
  `encodeNfc()`). Tant que `nfcEndpointPath` est vide, le bouton "Encoder
  NFC" échoue avec un message explicite plutôt que d'appeler une URL non
  configurée — une fois l'endpoint réel identifié, il suffit de le
  renseigner dans l'admin, sans nouveau déploiement.
- Nouveaux champs `Booking.nfcCount`/`nfcEncodedAt`/`updatedAt` (badge
  "NFC (n)" sur la liste et le détail). `POST /wa/booking/encodeNfc`
  (`src/routes/booking.ts`) déclenche l'appel et incrémente le compteur.
  Migration `20260824130000_booking_nfc_and_source_nfc_endpoint`.
- Testé (Playwright) : ouverture du détail depuis un clic sur la carte,
  affichage correct de tous les champs, clic sur "Encoder NFC" avec
  connecteur non configuré → message d'erreur clair affiché dans l'écran
  (pas d'appel réseau vers une URL vide), sans toucher au connecteur réel
  d'Hôtel Churchill.

### Affaires : vue "Mois par mois"

Bascule Kanban / "Mois par mois" en haut du panneau Affaires
(`public/crm.html`, `dealSetViewMode`). La vue mensuelle regroupe les
affaires par mois de leur **date de clôture prévue** (`closeDate`), en
ordre chronologique — chaque mois affiche le nombre d'affaires, le
pipeline pondéré (valeur mensuelle × probabilité, hors affaires "Perdu")
et, si renseigné, le montant ponctuel pondéré. Les affaires sans date de
clôture sont listées à part plutôt qu'exclues silencieusement. Distinct
du "Pipeline pondéré (Affaires)" déjà affiché sur la Trésorerie, qui lui
se base sur `montantPonctuel`/`moisEncaissement` plutôt que sur
`closeDate` — les deux vues répondent à des questions différentes
("quand ce CA récurrent doit-il se signer ?" vs "quel encaissement
ponctuel atterrit dans quel mois ?").

### Affaires : vue Kanban pour "Mois par mois" + funnel sur la vue par étape

Deux compléments à la vue Affaires :

- **Kanban "Mois par mois".** Sous-bascule Liste/Kanban quand la vue
  mensuelle est active (`dealSetMonthlyLayout`) — mêmes groupes que la
  vue liste (un mois = une colonne, "Sans date" en dernière colonne),
  mais présentés en colonnes façon Kanban (`renderAffairesMonthlyKanban`),
  cartes identiques au Kanban par étape avec la pastille d'étape en plus
  pour ne pas perdre cette information en changeant d'axe.
- **Funnel sur le Kanban par étape.** Au-dessus des colonnes, un funnel
  (`renderDealFunnel`) affiche le nombre d'affaires par étape (hors
  "Perdu", qui est une sortie du pipeline, pas une étape de progression)
  avec un taux de conversion entre étapes consécutives, respecte le
  filtre commercial actif. C'est une photo instantanée de la répartition
  actuelle par étape, pas un suivi de cohorte dans le temps (aucun
  historique des transitions d'étape n'est conservé).

### Funnel des affaires — bandes en trapèze façon maquette (20/08/2026)

Remplace le funnel en simples barres horizontales ci-dessus par des
bandes en trapèze empilées (SVG), sur le modèle d'une maquette fournie
(funnel numéroté, une couleur par étape). Détails :

- 5 couleurs catégorielles fixes, une par étape (Nouveau → Qualification
  → Devis envoyé → Négociation → Gagné), réutilisant/complétant les
  variables `--dch-*` déjà présentes par thème (`--dch-nfc`, `--dch-code`,
  `--dch-mobile`, `--dch-qr` + nouvelle `--dch-violet` ajoutée aux 5
  thèmes). Palette validée anti-daltonisme via le script du skill
  `dataviz` (`validate_palette.js`, tous les contrôles passent en clair
  et en sombre).
- Largeur de bande décroissante par construction (plancher à 22 % pour
  rester lisible, jamais plus large que la bande précédente) — un
  funnel ne s'élargit jamais, même si les effectifs réels ne décroissent
  pas strictement d'une étape à l'autre.
- Étiquettes (nom d'étape, effectif, taux de conversion) toujours en
  texte à côté du funnel, jamais uniquement encodées par la couleur —
  chaque bande ne porte qu'un numéro, pas de texte sur fond coloré.

### CRM Home : "Usage des modules Sesame" — corrige le total affiché

Le total "X au total" de la carte "Usage des modules Sesame" (`public/crm.html`,
`totalModulesActifs`) additionnait le champ libre "Nb modules" (`c.modules`,
saisi à la main sur la fiche client depuis l'audit) — un chiffre décorrélé
des 13 barres affichées juste en dessous, et qui ne représentait pas
fidèlement le nombre de modules réellement actifs sur le portefeuille.
Corrigé pour additionner les 13 compteurs eux-mêmes (un client avec 3
modules cochés compte pour 3) — c'est désormais un vrai décompte de
**modules actifs**, pas un décompte de **clients ayant au moins un
module**. Le champ `c.modules` reste inchangé ailleurs (fiche client,
export CSV) : seul ce total agrégé change de source.

### CRM Home : "Type de module installé" — backfill depuis l'audit + 3e type "Oneway"

La carte "Type de module installé" (Sesame / Ttlock) affichait des
comptes quasi nuls (5 et 1 sur 72 clients) car `moduleSesame`/
`moduleTtlock` n'avaient jamais été renseignés pour la quasi-totalité
des fiches importées — ajoutés après l'import initial (migration
`20260819092719`), sans backfill. Retrouvé et exploité la colonne
"Type Module" de l'audit source (`AUDIT_CLIENTS_SESAME_2025.xlsx`,
ligne 26, une colonne par client) :

- **Nouveau champ `moduleOneway`** — l'audit révèle un 3e type de
  verrouillage ("Oneway") absent du modèle jusqu'ici, présent chez ~14 %
  des clients ; ajouté au schéma (`CrmProspect.moduleOneway`), à la
  route (`src/routes/crmProspect.ts`) et à l'UI (case à cocher sur la
  fiche, tag sur le détail, barre sur la carte "Type de module
  installé").
- **Backfill par nom de client** — migration
  `20260824140000_crm_prospect_module_oneway_backfill` : 63 des 67
  clients importés depuis l'audit correspondent nommément à une entrée
  de la colonne "Type Module" (appariement direct + 5 correspondances
  manuelles pour des variantes d'intitulé — ex. "COPWELL – Fédé.
  Natation" vs "COPWELL\nFédé. Fr. Natation" dans le fichier source) ;
  "Mix" dans l'audit devient `moduleSesame` ET `moduleTtlock` tous deux
  vrais. Résultat : Sesame 47, Ttlock 6, Oneway 10 (au lieu de 5/1/—).
  4 fiches ont un "Type Module" vide dans l'audit et restent à false/
  false/false ; les 9 fiches restantes (sur 72) n'existaient pas dans
  cet audit (ajoutées manuellement depuis).

### Fiche client : liste déroulante pour "Type de module" + correction d'un blocage silencieux à l'édition

Deux changements sur la fiche client (`public/crm.html`) :

- **Liste déroulante au lieu de 3 cases à cocher.** "Type de module"
  passe de 3 checkboxes indépendantes à un `<select>` (—, Sesame, Ttlock,
  Oneway, Mix) — plus lisible pour un champ presque toujours exclusif
  (2 cas "Mix" sur ~97 clients audités), tout en gardant la possibilité
  de représenter les deux à la fois.
- **Bug trouvé en testant le changement ci-dessus : "Enregistrer" ne
  faisait rien sur la plupart des fiches.** Le formulaire d'édition
  exige "Adresse" et "Ville" (côté client ET serveur), mais les envoie
  systématiquement même quand on modifie un champ sans rapport — sur les
  42/72 fiches sans adresse et 25/72 sans ville (jamais renseignées à
  l'import de l'audit), toute modification échouait silencieusement
  (`flash` générique "Erreur d'enregistrement", sans dire pourquoi).
  Adresse/ville restent obligatoires à la **création** d'une fiche
  (`/wa/crmProspect/create`) mais plus à l'**édition** d'une fiche
  existante (`/wa/crmProspect/update` et `saveModal` côté client) —
  testé en conditions réelles sur la fiche "1K" (sans adresse), qui ne
  pouvait auparavant recevoir aucune modification.

### CRM Home : total manquant sur "Type de module installé"

Suite au correctif du total sur "Usage des modules Sesame" (24/08/2026),
la carte voisine "Type de module installé" n'affichait, elle, aucun
total du tout — pas de bug de calcul à proprement parler, juste
l'absence du même récapitulatif "X au total" que sur la carte
au-dessus. Ajouté pour cohérence : somme des 3 compteurs (Sesame +
Ttlock + Oneway), un client "Mix" comptant pour 2.

### Planning ménage : vue "Statuts chambres" (statuts de propreté + départs/arrivées)

Nouvelle sous-vue du panneau "Planning d'interventions" (bascule
"Grille"/"Statuts chambres" à côté de Semaine/Jour), sur le modèle d'un
connecteur PMS de référence (Thaïs) fourni en exemple :

- **8 statuts de propreté**, un par chambre à la fois — Propre, Recouche
  lit à faire, Recouche à blanc, Sale, En vérif, Taie d'oreiller,
  Serviette, Drap — distincts du statut d'occupation existant
  (`RoomHousekeepingStatus.status` : libre/occupée/...), sur un nouveau
  champ `cleanStatus` (migration
  `20260824150000_room_housekeeping_clean_status`, défaut "sale").
  Chaque chambre affiche une pastille cliquable (liste déroulante) pour
  changer son statut ; les compteurs en tête de vue se mettent à jour en
  direct. `GET/POST /wa/housekeepingStatus/*`
  (`src/routes/housekeepingStatus.ts`).
- **Vue hebdomadaire** : pour chaque jour de la semaine, le nombre de
  départs (icône grise) et d'arrivées (icône verte) — dérivés des vraies
  réservations (`Booking.startDate`/`endDate`), comme demandé
  ("gris = check-out, vert = check-in"). Contrairement à la maquette de
  référence, qui affiche aussi un historique quotidien des statuts de
  propreté, cette v1 ne fabrique pas ces chiffres pour le passé/futur —
  `cleanStatus` est un état courant, pas un historique conservé jour par
  jour — donc seule la colonne "aujourd'hui" affiche la répartition
  réelle des statuts ; un bandeau d'info l'explique dans l'interface.
  Piste v2 explicite si besoin : un instantané quotidien (cron) pour
  reconstituer un vrai historique, comme dans la maquette.

### Réservations : la vue par défaut n'excluait pas que les expirées + jeu de données de démo Churchill

- Panneau admin "Réservations" : la case "Toutes les réservations (y
  compris expirées)" décochée ne montrait que les arrivées du jour exact
  (`startDate === aujourd'hui`), masquant à tort les réservations futures
  non expirées (ex. un séjour arrivant dans 2 jours). Le libellé de la case
  ne promet pourtant d'ajouter que les réservations *expirées* — la vue par
  défaut affiche donc désormais toutes les réservations non expirées (en
  cours ou à venir, quelle que soit leur date d'arrivée), et la case à
  cocher n'ajoute plus que l'historique expiré, conformément à son
  libellé.
- Base de démo Hôtel Churchill : ajout d'un script ponctuel
  `scripts/backfill-churchill-kpi-demo.ts` qui crée 27 réservations
  supplémentaires réparties sur les 12 derniers mois (+ quelques arrivées à
  venir), avec commandes boutique, taxe de séjour et tâches de ménage éco
  associées, pour que les "Indicateurs réels" du Dashboard (séjours, CA,
  taxe collectée, ménages évités, eau économisée, CO₂ évité, temps gagné)
  affichent des valeurs réelles sur les 4 préréglages de période (7 jours /
  mois en cours / mois dernier / année) au lieu de zéros. Supprime aussi
  deux chambres de test (`TESTX01`/`TESTX02`) laissées par erreur dans les
  données Churchill lors de tests précédents. Les photos de chambres
  existaient déjà (migration `20260818180000_churchill_room_media_backfill`)
  et n'ont pas eu besoin d'être régénérées.

### CRM Home : indicateurs cliquables (détail des fiches derrière chaque KPI)

- Les 5 cartes de `renderInsights()` (Répartition par secteur, Répartition
  par PMS, Usage des modules Sesame, Type de module installé, Taux d'usage
  des accès) sont désormais cliquables ligne par ligne (ou segment par
  segment pour le camembert) : cliquer ouvre une modale listant les fiches
  qui composent ce chiffre, avec clic direct vers la fiche client. Exemple
  demandé : cliquer "Non renseigné" sur la répartition par PMS montre la
  liste des clients sans PMS saisi. Nouvelle fonction générique
  `openKpiDetail(title, list)` + 4 raccourcis (`kpiBySecteur`, `kpiByPms`,
  `kpiByFlag`, `kpiByAccess`) qui appliquent le même critère que celui déjà
  utilisé pour agréger le chiffre affiché (ex. normalisation PMS
  vide/"none" → "Non renseigné", identique à celle du graphique).
  Volontairement limité à ces 5 cartes de la vue Home — les indicateurs de
  la vue Liste (Clients/Risque élevé/Sans contrat/Activités) et du pipe
  commercial (Affaires ouvertes/Valeur du pipe/…) n'ont pas été touchés,
  n'étant pas dans la demande.

### CRM Home : les 5 KPI ne comptent plus que les fiches Client (hors Prospect)

- Les cartes "Répartition par secteur", "Répartition par PMS", "Usage des
  modules Sesame", "Type de module installé" et "Taux d'usage des accès"
  agrégeaient jusqu'ici toutes les fiches (`clients`, qui contient en
  réalité Client ET Prospect, cf. `TYPES`) — un Prospect sans PMS/secteur
  renseigné gonflait par exemple "Non renseigné". Ces 5 cartes ne portent
  désormais que sur les fiches de type Client (le pipe commercial, avec ses
  Prospects, reste couvert séparément par `renderPipelineKpis()`) ; la
  modale de détail ouverte au clic (cf. ci-dessus) applique le même filtre,
  donc le total affiché et la liste qui s'ouvre restent toujours
  cohérents.

### Affaires : la valeur pondérée du pipe utilise le montant ponctuel, pas le montant mensuel

- "Valeur pondérée" sur Home (`renderPipelineKpis`) et "pondéré" sur les vues
  "Mois par mois" (liste et Kanban) des Affaires multipliaient le montant
  mensuel récurrent (`amount`) par la probabilité — un calcul incohérent
  avec le "Pipeline pondéré (Affaires)" de la Trésorerie, qui lui a
  toujours utilisé `montantPonctuel × probabilité` (cf. `trDealsPipelineFor`).
  Les 3 endroits utilisent désormais tous la même formule
  (`montantPonctuel × probabilité`) ; "Valeur du pipe (mensuel)" sur Home
  reste, elle, le total non pondéré du montant mensuel récurrent — une
  mesure distincte, pas concernée par ce changement. Vérifié avec deux
  affaires de test aux montants mensuel/ponctuel volontairement divergents
  pour confirmer que les 3 vues affichent bien la même valeur pondérée.

### CRM Home : "Type de module installé" compte les modules, pas les clients

- Ce KPI comptait le nombre de fiches ayant chaque type (`moduleSesame` /
  `moduleTtlock` / `moduleOneway`), pas la quantité réelle de modules
  installés. Chaque compteur est désormais la SOMME du champ "Nb modules"
  (`c.modules`, saisi depuis l'audit) des fiches ayant ce type, cohérent
  avec la demande explicite ("le KPI type de module installé renvoie un
  nombre de client plutôt que la somme des valeurs se trouvant dans la
  fiche client Nb de modules"). Le pourcentage affiché par barre reflète
  désormais la part de ce type dans le total des modules (et non plus la
  part des clients). Le clic sur une barre (cf. `kpiByFlag`) ouvre
  toujours la liste des fiches ayant ce type — inchangé, puisqu'on ne peut
  pas "cliquer" une quantité. Vérifié : Sesame 902 modules / 47 fiches,
  Ttlock 128 / 6, Oneway 153 / 10, total 1183.

### CRM : les champs de recherche client perdaient le focus à chaque frappe

- La recherche "Client, ville, groupe…" (Vue liste) et "Rechercher un
  client…" (Portefeuille) redéclenchaient un re-render complet de `#main`
  (`innerHTML=...`) à chaque caractère tapé (`oninput`) — le champ étant
  recréé de zéro à chaque frappe, il perdait le focus, obligeant à
  recliquer dedans après chaque lettre. Nouvelle fonction utilitaire
  `withFocusKept(selector, renderFn)` : capture le focus + la position du
  curseur du champ avant le re-render, les restaure juste après. Appliquée
  aux deux champs concernés (`.srch-wrap input` en Vue liste,
  `#pf-search-input` en Portefeuille — nouvel id ajouté pour le cibler,
  la classe `.lsel` étant partagée par d'autres champs). Vérifié en tapant
  caractère par caractère avec Playwright : focus conservé, filtrage
  toujours correct.

### Pipe pondéré de la Trésorerie : deux affaires du même mois d'années différentes s'additionnaient

- Signalé : sur Octobre, la Trésorerie affichait un pipeline pondéré de
  16 200 € alors qu'une seule affaire visible (montant ponctuel 30 000 €,
  probabilité 10 %) donnait 3 000 €. Cause : `CrmDeal.moisEncaissement`
  n'est qu'un index de mois (0-11), sans année — `trDealsPipelineFor(m)`
  ne filtrait donc que par mois, additionnant dans l'Octobre de l'année
  Trésorerie actuellement affichée TOUTE affaire "Octobre" quelle que soit
  son année réelle (Octobre 2026 ET Octobre 2027 finissaient dans le même
  panier). Ajout du champ `CrmDeal.anneeEncaissement` (migration
  `20260825090000_crm_deal_annee_encaissement`), select année à côté du
  mois dans la fiche affaire, et filtre `trDealsPipelineFor()` sur
  `moisEncaissement ET anneeEncaissement===cashYear`. Les affaires déjà en
  base sans cette valeur (toutes, avant ce correctif) sont traitées comme
  l'année civile en cours au moment du calcul (`dealEncaissementYear()`),
  pour ne pas les faire disparaître du pipe tant qu'elles ne sont pas
  rééditées. Reproduit et vérifié avec deux affaires 30 000 €/10 % et
  26 400 €/50 %, l'une en Octobre 2026 et l'autre en Octobre 2027 : avant
  le correctif, les deux vues (2026 et 2027) auraient montré 16 200 € ; le
  correctif rend bien 3 000 € pour 2026 et 13 200 € pour 2027.

### Hôtel Churchill : photos de chambres retravaillées

- Les photos de chambres générées (SVG, faute d'accès réseau à un vrai
  shooting photo ou à une banque d'images libres depuis cet
  environnement — la sortie HTTPS est limitée à une liste blanche
  d'infrastructure de développement, pas au web ouvert) étaient de simples
  aplats rectangulaires (lit/fenêtre/chevet en blocs plats sans profondeur).
  `prisma/roomMedia.ts` génère désormais une scène avec dégradés (mur,
  ciel, parquet, couette), ombres douces, rideaux encadrant la fenêtre, une
  vraie silhouette de lampe de chevet (pied fin caché sous l'abat-jour
  plutôt que dépassant dessus) et un cadre mural, déclinée dans les 3
  palettes de catégorie existantes (Supérieure/doré, Standard/bleu,
  Compacte/vert) ; la salle de bain gagne un miroir lumineux rapproché de
  la vasque, une douche vitrée avec pommeau et gouttes, un sol carrelé et
  une plante à 3 feuilles. Nouveau script `scripts/backfill-room-media.ts`
  (comblant une promesse du commentaire d'en-tête du fichier depuis la
  migration du 18/08 — jamais tenue jusqu'ici) : régénère les photos des
  chambres déjà en base à partir du générateur courant, à relancer chaque
  fois que celui-ci est retouché visuellement pour propager la mise à jour
  aux bases déjà provisionnées (seed.ts ne pose des photos qu'à la
  création d'une chambre, jamais sur une ligne existante). **Ces photos
  restent des illustrations générées, pas de vraies photographies** —
  cet environnement n'a pas d'accès Internet général pour en récupérer.

### Trésorerie : nouveau tableau mensuel MRR / Signé / Pipeline / Recettes

- Le tableau "Vision annuelle" ne montrait qu'Encaissement/Dépenses/Net/
  Trésorerie, où "Encaissement" ne comptait que les lignes CrmCashLine
  saisies à la main + le pipeline pondéré des affaires — **le MRR du
  portefeuille (panneau Portefeuille, champ `mrr` par fiche client)
  n'entrait jamais dans le calcul**, malgré une variable CSS `--tr-mrr`
  déjà prévue dans les 5 thèmes mais jamais utilisée. Remplacé par le
  tableau demandé : Mois / MRR / Signé / Pipeline / Recettes / Dépenses /
  Net / Trésorerie, avec `Recettes = MRR + Signé + Pipeline`. Nouvelle
  fonction `trPortfolioMrrMonthly()` (somme de `CrmProspect.mrr`, reportée
  identiquement chaque mois — flux récurrent, contrairement à Signé/
  Pipeline qui varient mois par mois). Le graphique en barres empilées
  gagne un 3ᵉ segment (vert, MRR, sous Signé/Pipeline), la légende et
  l'infobulle sont mises à jour en conséquence, et la carte "Recettes"
  (ex-"Encaissement") affiche désormais un encart "dont X € de MRR
  portefeuille — non éditable ici" à côté de celui déjà existant pour le
  pipeline. Vérifié avec un cas combinant les 3 sources sur un même mois
  (MRR 2 001 € + Signé 5 000 € + Pipeline 2 000 €) : Recettes affiche bien
  9 001 €, cohérent entre tableau, infobulle et graphique.

### Trésorerie : détail cliquable sur le Pipeline (retrouver l'affaire sans année renseignée)

- Rapporté après le correctif `anneeEncaissement` : le pipeline pondéré
  d'un mois restait incorrect (le même écart chiffré qu'avant le
  correctif). Cause confirmée en reproduisant le cas : les affaires déjà
  en base au moment du correctif n'ont pas d'année renseignée, donc
  `dealEncaissementYear()` les traite comme l'année civile en cours — si
  deux affaires "Octobre" distinctes (l'une avec une année explicitement
  posée, l'autre encore sans) tombent toutes les deux sur l'année en
  cours par ce mécanisme de repli, elles se remélangent exactement comme
  avant le correctif. Ce n'est pas un bug de calcul, mais une donnée à
  finir de renseigner affaire par affaire — sans façon de voir QUELLES
  affaires composent un montant de pipeline, impossible à repérer
  soi-même. La cellule "Pipeline" du tableau mensuel est désormais
  cliquable (dès qu'elle est non nulle) : ouvre le détail des affaires
  qui la composent, avec le montant pondéré de chacune et — si l'année
  n'a jamais été renseignée — un avertissement explicite ("année non
  renseignée, traitée comme 2026"). Cliquer une affaire dans ce détail
  ouvre directement sa fiche pour corriger l'année. Nouvelle fonction
  `trDealsFor(m)` (factorisée avec `trDealsPipelineFor`) +
  `openPipelineDetail(m)`. Reproduit et vérifié : deux affaires Octobre
  (30 000€×10% avec année posée, 26 400€×50% sans année) redonnent bien
  16 200€ de pipeline tant que la seconde n'est pas corrigée — la
  modale de détail identifie sans ambiguïté laquelle des deux corriger.

### Docker : scripts/ absent de l'image (backfills en prod cassés)

- `docker exec ... npx tsx scripts/backfill-room-media.ts` échouait en
  production avec `ERR_MODULE_NOT_FOUND` — le Dockerfile copiait
  `prisma`/`src`/`public` mais jamais `scripts/`, absent de l'image
  buildée malgré sa présence dans le dépôt. `COPY scripts ./scripts`
  ajouté, même endroit que les autres `COPY`.

### Intégration réservations : réglages techniques verrouillés par défaut par modèle de PMS

- Les préréglages PMS (Sesame Technology, Mews, Opera Cloud, Thaïs)
  appliquaient déjà des valeurs techniques par défaut (endpoint, mapping,
  authentification…) au choix dans la liste déroulante, mais rien
  n'empêchait de les modifier par mégarde ensuite. Les champs sous
  "Réglages techniques avancés" démarrent désormais verrouillés
  (`disabled`) sur les valeurs par défaut du modèle choisi — à chaque
  sélection d'un modèle ET à chaque rechargement du panneau — avec un
  bandeau "Réglages techniques par défaut du modèle X — verrouillés" et un
  bouton "Modifier" pour les déverrouiller à la demande (et "Personnalisé"
  déverrouillé, cf. bsSetLocked/bsToggleLock). Les identifiants simplifiés
  propres à l'établissement (URL, identifiants de connexion, code
  établissement — section "Identifiants" au-dessus) restent toujours
  éditables, verrou ou non : ce ne sont pas des valeurs par défaut du
  modèle. Cliquer "Modifier" déplie aussi la section si elle était
  repliée. Revenir sur le même modèle réapplique et reverrouille ses
  valeurs par défaut (vérifié : une valeur modifiée à la main après
  déverrouillage est bien écrasée en resélectionnant le même modèle).

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

### Vérifier quelle version tourne après un déploiement

Chaque build est identifié par le commit et sa date, affichés en bas de la
barre latérale du CRM (`/crm`) et du back-office (`/admin`), et exposés sur
`GET /version`. Comme le `.git` du dépôt n'est pas accessible depuis
l'image (le contexte de build est `sesame-suite/`, `.git` est un niveau
au-dessus), ces informations doivent être passées en argument de build —
sinon la version affichée reste `inconnu` :

```bash
GIT_SHA=$(git rev-parse --short HEAD) GIT_TIME=$(git log -1 --format=%cI) docker compose up --build -d
```

Utile en particulier après un `git pull` sur un serveur distant, pour
confirmer que le nouveau code tourne bien avant de retester.

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
      bookingSource.ts                     # GET/POST /wa/bookingSource/* (connecteur réservations, par hôtel)
      auth.ts                               # POST /api/auth/guest-login (client)
    lib/provisionEntity.ts                # provisionne Entity + config + AdminUser hotel
    lib/loyaltyScope.ts                    # résout le scope de fidélité (entité ou groupe centralisé)
    lib/bookingSource.ts                   # mapping JSON générique + import de réservations externes
    lib/bookingSourceScheduler.ts          # boucle de synchronisation automatique (vérifiée /60s)
  public/
    checkin.html          # prototype d'origine (client), rebranché sur l'API
    admin.html             # prototype d'origine (back-office), rebranché sur l'API
```

## Prochaine itération suggérée

1. App agent ménage (`sesame_menage.html`) branchée sur
   `RoomHousekeepingStatus` / `HousekeepingTask` / `HousekeepingStaff`.
2. Export CSV taxe de séjour (`TaxeSejourRecord.findByPeriod` côté doc)
   et génération QR réelle (actuellement simulée, comme dans le prototype).
3. Paiement réel du mandat GoCardless sur les souscriptions (actuellement
   simulé — seuls titulaire + 4 derniers chiffres de l'IBAN sont conservés,
   sans tokenisation ni prélèvement réel).
4. CRM commercial (`/crm`) : le panneau "devis/factures/tickets support" du
   prototype `sesame_admin.html` n'a pas été repris — la nouvelle version
   couvre le pipeline prospects/clients (fiches, journal d'activité,
   contrats) mais pas la facturation.
