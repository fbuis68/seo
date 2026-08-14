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

**`production/`** contient le premier livrable réel : `widget-ia.html`
(page autonome, données MCDF en direct, lecture seule) + `INTEGRATION.md`
(instructions pour le développeur qui le branche dans l'appli).

## Vue d'ensemble

| # | Module | État | Ce qui manque avant de coder |
|---|--------|------|-------------------------------|
| 1 | IA Conversationnelle | 🔴 à démarrer | les endpoints d'écriture (create/edit) — on n'a capturé que des lectures |
| 2 | Assistant Qualiopi | 🟡 piste confirmée | tester les entités `sessionQualiopi`/`conventionExportQualiopi` déjà repérées dans le code source |
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
