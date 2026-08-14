# Module 1 — IA Conversationnelle (le copilote)

## Objectif
Dialoguer avec MCDF en langage naturel au lieu de naviguer dans les menus :
> "Crée une session Excel le 15 septembre avec Jean Dupont."
> "Inscris les 12 stagiaires de l'entreprise X."
> "Quels sont les devis à relancer cette semaine ?"

## Ce qu'on sait déjà
- Le pattern `GET /wa/{entité}/list?filtres` (lecture, avec pagination et
  filtres par propriété) est confirmé et généralisable à toutes les entités
  du système (voir `chiefOrchester` dans `controller-beans.xml` : ~300 entités
  nommées enregistrées automatiquement).
- `GET /wa/{entité}/item?id=...` (lecture d'un enregistrement) est confirmé.
- L'authentification par cookie de session est confirmée et implémentée
  (`client/mcdf_client.py::login`).
- Les questions purement informatives ("Quels sont les devis à relancer ?",
  "Montre-moi les 30 derniers stagiaires") sont **déjà réalisables** avec ce
  qu'on a : il suffit de mapper l'intention vers un appel `list_entity()`
  avec les bons filtres — c'est exactement ce que fait `live-reports.js`.

## Ce qu'il reste à découvrir (bloquant pour les actions d'écriture)
Aucune requête d'écriture (création/modification) n'a encore été capturée.
Hypothèse à vérifier : par analogie avec `list`/`item`, il existe probablement
`/wa/{entité}/add` et `/wa/{entité}/edit` (ou une même route `item` avec une
méthode POST/PUT). À confirmer via DevTools :
1. Ouvrir un écran d'ajout (ex: "Ajouter" sur Dossiers ou Session)
2. Remplir le formulaire, valider, et capturer la requête (méthode, URL,
   payload, réponse) — idem méthode que pour le login (filtre `method:POST`
   ou `Doc` si formulaire classique)

## Architecture proposée
1. **Couche outils (tools)** : une fonction par verbe générique —
   `list_entity(entity, filters)`, `get_item(entity, id)`, et une fois
   confirmées, `create_entity(entity, fields)` / `update_entity(entity, id, fields)`.
   Chacune devient un tool Claude (function calling), avec un schéma JSON
   décrivant les champs attendus par entité (dérivé des champs déjà
   confirmés : `session`, `actor`, `convention`, `invoice`, `customer`...).
2. **Résolution d'intention** : le LLM choisit l'entité + l'action à partir
   du langage naturel, en s'appuyant sur le contexte de conversation pour
   résoudre les références ("les stagiaires de l'entreprise X" → chercher
   `customer`/`company` par nom, puis `conventionAttendee`/`actor` liés).
3. **Confirmation avant écriture** : toute action de création/modification
   doit être confirmée explicitement par l'utilisateur avant exécution
   (cohérent avec la prudence attendue sur les actions à effet de bord).

## Priorité / complexité
Très haute valeur, complexité élevée tant que les endpoints d'écriture ne
sont pas confirmés. La partie lecture seule peut démarrer immédiatement.
