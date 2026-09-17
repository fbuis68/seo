# Passation développeur — Copilote IA MCDF

Ce document complète `A-TRANSMETTRE-AU-DEVELOPPEUR.md` (déploiement) et
`ARCHITECTURE.md` (vue d'ensemble initiale, en partie datée — voir la mise en
garde en fin de document). Il rassemble le contexte qui n'est écrit nulle
part ailleurs : décisions techniques, contraintes découvertes en live,
contexte métier, et ce qui reste en suspens.

Destiné à quelqu'un qui reprend ce projet seul, sans avoir participé aux
échanges qui ont produit ce code.

---

## 1. Ce qu'est ce projet

Un ensemble de widgets HTML/JS autonomes (aucun build, aucune dépendance
serveur à nous) qui s'intègrent dans **MCDF** (moncentredeformation.fr, un
logiciel de gestion de centre de formation basé sur **Ext JS**), via un
bouton flottant (`launcher-embed.js`) déjà en place sur
`test.moncentredeformation.fr`. Chaque widget est un fichier `.html` unique,
déposé tel quel dans `/var/lib/tomcat/webapps/ROOT/`, qui appelle l'API MCDF
en direct depuis le navigateur (cookie de session déjà actif, pas
d'authentification à part).

Marque commerciale utilisée en interne pour l'ensemble : **« Copilote IA »**.

## 2. Modules et leur état réel

| Fichier | Module | État réel (pas celui d'ARCHITECTURE.md) |
|---|---|---|
| `widget-ia.html` | Génération de rapports | ✅ Production. 8 onglets : Commercial, Planning, Formateurs, Listing, CPF Sous-traitance (API en direct), Facturation (import Excel), Observatoire marché (open data en direct), Formation → compétences (import Excel ROME) |
| `widget-conversationnel.html` | IA Conversationnelle | ✅ Production. Moteur à règles (regex), PAS un LLM — voir §4. Recherche libre + bascule directe MCDF (§4) + détection de date/mois dans la question |
| `widget-envoi.html` | Envoi de documents | ✅ Production. Le seul widget qui écrit (vrai envoi d'email), toujours avec écran de confirmation |
| `widget-suggestions.html` | Suggestions d'évolution | ✅ Outil interne, pas connecté à l'API MCDF, `mailto:` + `localStorage` |
| `widget-qualiopi.html` | Assistant Qualiopi | 🔴 **PAS production-ready**, malgré ce que dit `ARCHITECTURE.md`. Voir son propre commentaire d'en-tête dans le fichier : champs jamais confirmés contre l'API réelle, aucun indicateur "habillé" affiché volontairement pour ne pas montrer de faux chiffres. Ne pas le présenter comme fini à un client. |

## 3. Faits techniques à ne pas redécouvrir

Ces points ont chacun coûté un aller-retour d'investigation en direct sur le
serveur de test. Les reperdre ferait perdre du temps pour rien.

**a. Aucune URL par fiche dans MCDF.** MCDF est une single-page app : l'URL
de la barre d'adresse ne change jamais, quelle que soit la fiche ouverte
(confirmé en observant la barre d'adresse pendant la navigation). **Mais**
MCDF a un mécanisme de navigation interne en JS : ses propres liens
(inspectés en direct) sont de la forme
`<a href="javascript:Convention.linkToObject('C00076271','convention_tab')">`.
`Convention.linkToObject(id, tab)` est une fonction déjà chargée sur la page
MCDF elle-même — **pas** une vraie URL. Comme `launcher-embed.js` charge
chaque widget dans une `<iframe>` à l'intérieur de la page MCDF,
`window.parent.Convention.linkToObject(id, tab)` est atteignable **si et
seulement si** le widget est ouvert via le bouton flottant (pas via une URL
directe/favori — dans ce cas `window.parent === window`, prévoir un repli).
Tabs confirmés : `convention_tab` (dossier), `customer_tab` (client),
`actor_tab` (formateur **et** stagiaire — un formateur et un stagiaire sont
tous les deux des "acteurs" côté MCDF), `training_session_tab` (session).
Implémenté dans `widget-conversationnel.html` (`mcdfOpen()`).

**b. Pas de champ "CPF" dans l'API.** Un dossier est traité comme financé
CPF dans `widget-ia.html` si le payeur d'au moins une de ses factures
(`invoice.payerId`/`payerName`) est **« Caisse des Dépôts et Consignations »**
(gestionnaire de Mon Compte Formation) — confirmé manuellement sur ce
compte le 02/09/2026. C'est une approximation, pas un vrai champ MCDF.

**c. Pas de champ "sous-traitance" au niveau dossier.** Vient du champ
`timetable.subcontracted` ("0"/"1"), au niveau de chaque ligne de
facturation, agrégé côté widget.

**d. `conventionTraining`/`timetable` ne supportent pas le listing en
masse sur ce compte.** `/wa/conventionTraining/list?nopaging=1` et
`/wa/timetable/list?nopaging=1` timeout (504 Gateway Timeout côté MCDF) —
l'historique est trop volumineux, aucun paramètre de filtre serveur
disponible. La solution retenue : identifier les dossiers CPF via
`invoice` (qui, lui, répond vite en masse), puis n'appeler
`conventionTraining/listWithTimetable?type=convention&conventionId=X`
(l'appel que MCDF utilise lui-même pour une fiche dossier) que pour ce
sous-ensemble, par lots de 6 en parallèle. Voir `loadCpfLive()` dans
`widget-ia.html`. **Si un futur module a besoin d'autres entités à fort
volume, tester d'abord un `nopaging=1` isolé avant de bâtir dessus — il y
a de bonnes chances que ça timeout pareil.**

**e. `/wa/{entité}/list?nopaging=1&_dc=...` est le pattern d'appel API
confirmé** pour toutes les lectures, cookie de session déjà actif. Entités
confirmées à ce jour : `customer`, `convention`/`fullConventionQualiopi`,
`invoice`, `conventionAttendee`, `session`, `sessionQualiopi`,
`conventionTraining`, `timetable`, `messageTemplate`. Pas de nom "officiel"
garanti au-delà — à vérifier par capture réseau avant d'en supposer une
nouvelle.

**f. Déploiement = copie de fichier, pas de build.** Voir
`A-TRANSMETTRE-AU-DEVELOPPEUR.md` pour les commandes `curl` de mise à jour
et les 3 points de vigilance (encodage UTF-8 en première ligne, cache
navigateur, `entityId` propre à chaque serveur/environnement).

## 4. Contexte métier — non tranché, à connaître avant de trancher

**Tarification actuelle de MCDF** (le produit, pas le Copilote) : 30 €/mois
par admin, 5 €/mois par formateur.

**Piste de tarification du Copilote IA discutée** (jamais validée, jamais
implémentée) : un modèle hybride aligné sur cette grille — petit
supplément par formateur (accès "mon portefeuille" limité : recherche de
ses propres stagiaires/sessions) + supplément plus élevé par admin (suite
complète). Cette piste est née d'une remarque : *"si nous avons beaucoup de
formateurs qui gèrent leur portefeuille de stagiaires"*, le volume
formateur peut peser plus lourd qu'il n'y paraît dans la valeur captée.

**Prérequis technique bloquant cette piste, jamais résolu** : on ne sait
pas encore comment identifier, depuis l'API MCDF, **quel formateur est
l'utilisateur actuellement connecté** dans le widget. Sans ça, impossible
de filtrer les résultats sur "mon" portefeuille plutôt que celui de tout le
centre. Première étape si on reprend ce sujet : investiguer côté
session/cookie MCDF ou un appel `/wa/...` qui renverrait l'identité de
l'utilisateur courant — pas encore cherché.

## 5. En suspens / à trancher avec le client (fbuis@sesame-technology.com)

1. **Vue "mon portefeuille" formateur** — voir §4, en attente de décision
   depuis plusieurs jours au moment de cette passation.
2. **Assistant Qualiopi** — nécessite une vraie session de découverte API
   (capturer les requêtes réseau des écrans Qualiopi dans MCDF) avant de
   pouvoir afficher un seul indicateur réel. Ne pas improviser des
   indicateurs sans confirmation, même pour une démo.
3. **Récapitulatif automatique du soir** — une Routine (trigger planifié)
   tourne chaque jour à 19h Paris, résume les demandes d'évolution de la
   journée dans cette session Claude. Si quelqu'un d'autre reprend le
   suivi produit, cette routine doit être repointée vers sa session ou
   désactivée (`delete_trigger` / recréée depuis sa propre session) — elle
   ne se transfère pas automatiquement.
4. **Documentation marketing produite hors-repo** — un support PowerPoint
   client ("Copilote IA MCDF") et une vidéo de démonstration (52s, écrans
   réels + graphiques) ont été générés et envoyés directement au client,
   mais **leurs fichiers sources ne sont pas dans ce repo** (générés dans
   un répertoire de travail temporaire, hors git). Si quelqu'un doit les
   régénérer ou les modifier, il faudra reconstruire le script
   (`pptxgenjs` pour le PPTX, Playwright + ffmpeg pour la vidéo) à partir
   de zéro, ou récupérer les fichiers déjà livrés au client.

## 6. Mise en garde sur la documentation existante

`ARCHITECTURE.md` (à la racine de `mcdf-widget/`) date d'une phase de
planification antérieure et est **partiellement obsolète** : il décrit
`widget-qualiopi.html` comme "🟢 livrable" avec indicateurs en direct — ce
n'est plus vrai (ou ne l'a jamais été en production, voir §2). Se fier en
priorité au commentaire d'en-tête de chaque fichier `.html` (toujours tenu
à jour dans ce projet) et à l'historique des commits Git, qui documente
précisément pourquoi chaque changement a été fait — pas seulement quoi.

## 7. Pour aller plus loin

- Déploiement / mise à jour serveur : `A-TRANSMETTRE-AU-DEVELOPPEUR.md`
- Vue d'ensemble fonctionnelle d'origine (avec la réserve du §6) :
  `ARCHITECTURE.md`
- Détail par module : `mcdf-widget/modules/*/NOTES.md`
- Capture réseau confirmée pour l'envoi de documents :
  `mcdf-widget/modules/03-documents/NOTES.md`
