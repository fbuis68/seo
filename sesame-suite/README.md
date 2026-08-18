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
  - **SMS et WhatsApp** : un seul fournisseur, **Twilio**, dont l'API REST
    couvre les deux canaux avec les mêmes identifiants de compte — c'est ce
    qui permet la convergence (`src/lib/sms.ts`, endpoints
    `/wa/channelConfig/*`, appel HTTP direct, sans SDK).
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
