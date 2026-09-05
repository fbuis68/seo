# Installation du lanceur flottant — procédure complète

Le lanceur (`launcher.html`) est le bouton "Copilote IA" flottant qui ouvre
un panneau avec les 4 modules. Contrairement à `widget-ia.html` (une page
à part, déployée une fois et ouverte via son URL), le lanceur doit
apparaître **sur toutes les pages de l'application** — l'installation est
donc différente et un peu plus technique. Ce document donne la procédure
complète, à suivre dans l'ordre.

## 1. Ce qui est livré

| Fichier | Rôle |
|---|---|
| `launcher.html` | Référence complète (CSS + HTML + JS) à copier dans le gabarit de l'appli — **ne se déploie pas tel quel comme `widget-ia.html`**, voir §3. |
| `widget-ia.html` | Le module "Génération de rapports", déjà livré — c'est vers lui que pointe la carte "Disponible" du lanceur. |
| `INSTALL-LAUNCHER.md` | Ce document. |

## 2. Pourquoi ce n'est pas un simple dépôt de fichier

MCDF est une application **ExtJS** : après connexion, une seule page HTML
se charge, et toute la navigation (Contacts, Dossiers, Planning...) se
fait ensuite **sans recharger la page**. Le bouton flottant doit donc
être injecté dans **cette page-là uniquement** — pas dans chaque écran —
puisqu'elle reste chargée en permanence pendant toute la session.

## 3. Étape 1 — Identifier le fichier gabarit à modifier

C'est l'étape la plus importante : trouver LA page qui charge l'appli
ExtJS après connexion (probablement `WEB-INF/html/premium.html` ou
équivalent, d'après le nom `@premium` vu dans la configuration de
`loginController`, **mais à confirmer**, ne pas deviner) :

1. Se connecter normalement à `test.moncentredeformation.fr`
2. Une fois sur l'écran principal (Accueil, Contacts, Dossiers...), ouvrir
   DevTools (F12) → onglet **Sources** (ou clic droit sur la page →
   **"Afficher le code source de la page"**)
3. Repérer le document HTML principal : il contient une balise
   `<script src=".../ext-all-debug.js">` (déjà vue dans tes captures
   réseau précédentes) et se termine par `</body></html>`
4. Noter son chemin exact côté serveur (le développeur le retrouvera dans
   `WebContent/WEB-INF/html/` ou `WEB-INF/jsp/`)

**Ne pas modifier** les pages de login, formulaires web publics
(`WEB-INF/jsp/login.jsp`, `suscribe.jsp`, etc.) — ce sont des pages
séparées, pas la coquille de l'appli.

## 4. Étape 2 — Tester le lanceur seul, avant intégration

Avant de toucher au gabarit de production, ouvrir `launcher.html`
directement dans un navigateur (double-clic sur le fichier) et vérifier
que le bouton et le panneau fonctionnent visuellement (déjà validé de mon
côté, mais bon réflexe de le revoir une fois de son côté).

## 5. Étape 3 — Copier les 3 blocs dans le gabarit

Dans `launcher.html`, trois blocs sont à repérer et copier :

1. **Le bloc `<style>...</style>`** (tokens de couleur + classes
   `#ia-launcher-btn`, `#ia-launcher-modal`, etc.) → coller dans le
   `<head>` du gabarit, ou dans une feuille CSS déjà chargée sur toutes
   les pages.
   *(Ignorer les règles sous le commentaire `/* --- page de démo... */`
   tout en bas du bloc `<style>` — c'est uniquement pour la page de
   démonstration autonome, pas pour l'intégration réelle.)*
2. **Les deux `<div>`** — `<button id="ia-launcher-btn">` et
   `<div id="ia-launcher-modal">` (avec tout leur contenu) → coller juste
   avant `</body>`.
3. **Le `<script>...</script>`** final (qui construit les cartes et gère
   ouverture/fermeture) → coller juste après les deux `<div>` ci-dessus,
   toujours avant `</body>`.

*(Ignorer le `<div class="ia-demo-page">` tout en haut du fichier — c'est
la fausse page de fond utilisée uniquement pour la prévisualisation.)*

## 6. Étape 4 — Connecter l'entité courante (recommandé, pas bloquant)

Le script lit `window.MCDF_CURRENT_ENTITY_ID` pour ouvrir le module
"Génération de rapports" sur la bonne entité. Si cette variable n'existe
pas, le widget s'ouvre quand même, juste sans filtrage par entité
(bandeau d'avertissement visible, cf. `INTEGRATION.md`).

Pour la brancher : dans le JavaScript existant de l'appli, à l'endroit où
l'entité sélectionnée dans le menu du haut est déjà connue côté client,
ajouter une ligne du type :
```js
window.MCDF_CURRENT_ENTITY_ID = /* la variable qui contient déjà l'entité courante */;
```
avant que le script du lanceur ne s'exécute. Si le développeur ne trouve
pas rapidement cette variable, c'est acceptable de sauter cette étape
pour un premier test — la fonctionnalité reste utilisable.

## 7. Étape 5 — Déployer et recharger

Redéployer le fichier gabarit modifié selon la méthode habituelle (même
principe que pour `widget-ia.html`, cf. `INSTALL-SERVEUR-TEST.md` §3.2).
Se déconnecter/reconnecter à MCDF pour forcer le rechargement de la page
principale (elle n'est chargée qu'une fois par session).

## 8. Checklist de validation

- [ ] Le bouton "Copilote IA" est visible en bas à droite sur l'écran d'accueil
- [ ] Il reste visible après avoir navigué vers un autre onglet de l'appli (Contacts, Dossiers...) **sans recharger la page** — preuve que l'injection est bien au niveau du gabarit commun, pas d'un écran particulier
- [ ] Cliquer dessus ouvre le panneau, avec les 4 cartes visibles
- [ ] La croix (✕) et le clic en dehors du panneau le referment
- [ ] La carte "Génération de rapports" (seule cliquable) ouvre `widget-ia.html` dans un nouvel onglet, avec des données (pas tout à zéro — sinon revoir `entityId`, cf. §6)
- [ ] Aucune erreur dans la console (DevTools → Console)
- [ ] Le rendu est correct si l'utilisateur a le thème sombre activé côté OS/navigateur

## 9. Retrait (rollback)

Aucun risque de donnée : le lanceur est purement visuel, lecture seule.
Pour le retirer, supprimer les 3 blocs ajoutés (style, div×2, script) du
gabarit — rien d'autre à annuler.

## 10. Sécurité / portée

Identique à `widget-ia.html` (voir `INTEGRATION.md` et
`INSTALL-SERVEUR-TEST.md`) : même origine, aucune nouvelle
authentification, aucune écriture. Le lanceur lui-même n'appelle aucune
API — il ne fait qu'ouvrir `widget-ia.html`, qui applique ses propres
règles de lecture seule.
