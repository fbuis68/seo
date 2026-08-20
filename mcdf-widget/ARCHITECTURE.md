# Widget IA MCDF — architecture en 4 modules

Ce document découpe le widget IA en 4 axes fonctionnels. Chacun s'appuie
sur la même base technique déjà construite et validée contre l'API réelle
(`portal.moncentredeformation.fr`) :

- **`client/mcdf_client.py`** — client Python générique (login, `list_entity`, `get_item`)
- **`browser/live-reports.js`** — même logique côté navigateur, testée en conditions réelles
- Le pattern d'API confirmé : `GET /wa/{entité}/list?filtres&page=&start=&limit=`
  → `{success, root}`, authentification par cookie de session (`POST /login.htm?controller=checkLogin`)
- Le schéma de données confirmé : `customer`, `company`, `actor` (stagiaires/formateurs
  unifiés via des flags), `convention` (devis+dossiers unifiés), `conventionAttendee`,
  `invoice`, `session`

Chaque module ci-dessous a son propre `NOTES.md` dans `modules/` avec le détail.

**`production/`** contient les livrables réels :
- `widget-ia.html` (module rapports, page autonome, données MCDF en
  direct, lecture seule, structuré en 4 sous-rubriques — Commercial
  (CA, top conseillers/clients, comparaison N vs N-1 avec sélecteur de
  période), Planning (sessions à venir, volume d'heures), Formateurs
  (top formateurs, heures prévues/réalisées/planifiées), Listing
  (stagiaires, crédit d'heures restant, sessions, montant vendu/facturé)
  — reconstruit à partir des rapports Power BI existants (Suivi
  Commercial, Suivi Formateurs, Rapports Listings)) + `INTEGRATION.md` /
  `INSTALL-SERVEUR-TEST.md`
- `widget-conversationnel.html` (module IA Conversationnelle, v1 à base
  de règles sur des questions connues, mêmes données réelles que
  `widget-ia.html`)
- `widget-qualiopi.html` (module Assistant Qualiopi — 3 onglets :
  « Indicateurs » calculés en direct sur les champs confirmés de
  `sessionQualiopi`/`fullConventionQualiopi` (documents envoyés/signés,
  attestations, heures vendues/réalisées/facturées, crédit OPCA,
  enquêtes) ; « Détection API » pour explorer d'autres champs ; « Saisie
  manuelle » pour les indicateurs qualité classiques — satisfaction,
  réclamations, actions correctives — qui n'ont toujours aucune source
  MCDF connue)
- `launcher-embed.js` (bouton flottant + panneau donnant accès aux 4
  modules, une seule ligne à intégrer) + `INSTALL-LAUNCHER.md`
- `mock_server.py` / `mock_server.js` — validation locale sans accès à
  MCDF, données fictives dans le même format que l'API réelle.
- `A-TRANSMETTRE-AU-DEVELOPPEUR.md` — fiche de déploiement/mise à jour
  côté serveur (commandes `curl` + points de vigilance).

Côté découverte : `browser/live-qualiopi-check.js` — script console pour
confirmer les noms d'entité et les champs réels du module Qualiopi.

## Vue d'ensemble

| # | Module | État | Ce qui manque |
|---|--------|------|-------------------------------|
| 1 | IA Conversationnelle | 🟢 v1 livrée | `production/widget-conversationnel.html` — répond à un jeu de questions connu sur les données réelles ; pas encore un vrai LLM (pas de endpoint d'écriture confirmé non plus) |
| 2 | Assistant Qualiopi | 🟢 livrable | `production/widget-qualiopi.html` — `sessionQualiopi`/`fullConventionQualiopi` confirmées en direct (5544/3769 lignes réelles) ; indicateurs de suivi horaire/documentaire/OPCO calculés en direct ; les indicateurs qualité classiques (satisfaction, réclamations) restent en saisie manuelle, aucune source MCDF trouvée pour ceux-là |
| 3a | Génération de rapports | 🟢 livrable | `production/widget-ia.html` — widget réel, données en direct, prêt à intégrer (voir `production/INTEGRATION.md`) |
| 3b | Génération de documents | 🔴 à démarrer | trouver l'endpoint qui déclenche le pipeline XDocReport existant |
| 4 | Recherche intelligente | 🟡 piste confirmée | trouver le paramètre HTTP qui active la recherche libre (`freeField`) déjà présente côté serveur |

## Pourquoi cet ordre de priorité

**Le plus rentable maintenant : le module 4 (recherche) et le module 2 (Qualiopi)** —
dans les deux cas, l'essentiel de la mécanique existe déjà côté serveur (confirmé
dans `data-beans.xml` : DAOs Qualiopi dédiés, `filterOption`/`freeField` sur de
nombreux DAOs). Il ne reste qu'à capturer 1-2 requêtes réseau pour débloquer
l'implémentation, exactement comme on l'a fait pour le reste.

**Le module 1 (conversationnel) est la fonctionnalité phare mais la plus bloquée** :
tout ce qu'on a confirmé jusqu'ici, ce sont des lectures (`list`/`item`). Un
copilote qui ne fait que *lire* est déjà utile (interroger, résumer), mais
"Crée une session", "Inscris les stagiaires" nécessite de découvrir comment
MCDF reçoit des écritures — probablement `/wa/{entité}/add` et `/wa/{entité}/edit`
par analogie avec le pattern `list`/`item`, mais à confirmer par capture réseau
sur un vrai clic "Ajouter" dans l'interface.

**Le module 3b (documents) a une infrastructure existante mais un point d'entrée
inconnu** : les jars (FreeMarker, XDocReport, docx4j, iText, Aspose, Apache FOP)
et les DAOs (`templateDao`, `actorDocumentDao`, `conventionDocumentDao`) prouvent
que MCDF sait déjà générer des documents depuis des modèles — il faut juste
capturer l'appel réseau du bouton "Imprimer"/"Générer" pour savoir comment le
déclencher.
